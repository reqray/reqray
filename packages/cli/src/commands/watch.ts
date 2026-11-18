/**
 * `reqray watch` — the stream.
 *
 * `tail -f` for requests: one line each, as they finish. Everything that
 * narrows it is decided here rather than by the server, because the stream
 * endpoint sends every request and takes no parameters — the same arrangement
 * the web panel's own feed runs on.
 *
 * A request that failed gets a second line with the exception on it. That
 * needs the record rather than the row, so it is fetched — with a short
 * deadline, because a stream that stalls waiting for a detail is worse than
 * one that admits it could not get it.
 */

import type { RequestDetail, RequestRow } from '@reqray/protocol';
import { boolFlag, type FlagSpec, listFlag, numberFlag, stringFlag } from '../args.js';
import { EXIT_OK } from '../errors.js';
import type { StreamFilter } from '../filter.js';
import { matches } from '../filter.js';
import { failureLines, streamHead, streamRow } from '../render/row.js';
import { emptyState, header, noticeLine } from '../render/screens.js';
import type { Command, CommandContext } from './context.js';

/** How long a failed row may hold the stream while its detail is fetched. */
const DETAIL_TIMEOUT_MS = 1_000;

const FLAGS: FlagSpec = {
  ids: 'boolean',
  'slower-than': 'string',
  status: 'list',
  method: 'list',
  path: 'string',
  'findings-only': 'boolean',
};

/** Reads the flags that narrow the stream. */
export function filterFrom(context: CommandContext): StreamFilter {
  return {
    slowerThanMs: numberFlag(context.args, 'slower-than'),
    statuses: listFlag(context.args, 'status'),
    methods: listFlag(context.args, 'method'),
    path: stringFlag(context.args, 'path'),
    findingsOnly: boolFlag(context.args, 'findings-only'),
  };
}

export const watch: Command = {
  name: 'watch',
  summary: 'follow requests as they happen',
  flags: FLAGS,

  async run(context): Promise<number> {
    const { client, globals, out, signal } = context;
    const filter = filterFrom(context);

    // Asked first, and deliberately: this is the request that finds out the
    // collector is not there, while there is still nothing on screen to
    // interrupt.
    const meta = await client.meta(signal);
    for (const line of header(context.version, globals.url, meta, globals.theme)) out.line(line);

    // The identifier is a handle, not information, so it is printed only when
    // asked for — but without it a row on screen cannot be opened.
    const ids = { ids: boolFlag(context.args, 'ids') };

    const recorded = await client.list({ limit: 1 }, signal);
    let headPrinted = false;
    if (recorded.requests.length === 0) {
      for (const line of emptyState(globals.url, meta, globals.theme)) out.line(line);
    } else {
      out.line(streamHead(globals.theme, ids));
      headPrinted = true;
    }

    /** Rows are printed one at a time, in the order they arrived. */
    let printing: Promise<void> = Promise.resolve();

    await client.stream({
      signal,
      onNotice: (text) => {
        printing = printing.then(() => {
          out.line(noticeLine(text, globals.theme));
        });
      },
      onRow: (payload) => {
        const row = payload as RequestRow;
        if (!matches(row, filter)) return;

        printing = printing.then(async () => {
          if (!headPrinted) {
            out.line('');
            out.line(streamHead(globals.theme, ids));
            headPrinted = true;
          }
          out.line(streamRow(row, globals.theme, ids));
          if (!row.hasError) return;

          const detail = await detailFor(context, row);
          for (const line of failureLines(row, detail, globals.theme)) out.line(line);
        });
      },
    });

    await printing;
    return EXIT_OK;
  },
};

/**
 * The record behind a failed row, if it can be had quickly.
 *
 * `null` rather than an error: the exception type is a nicety, and the row
 * itself has already said the request failed.
 */
async function detailFor(context: CommandContext, row: RequestRow): Promise<RequestDetail | null> {
  const timeout = AbortSignal.timeout(DETAIL_TIMEOUT_MS);
  const signal = AbortSignal.any([context.signal, timeout]);
  try {
    return await context.client.detail(row.id, signal);
  } catch {
    return null;
  }
}
