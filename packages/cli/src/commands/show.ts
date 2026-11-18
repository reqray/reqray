/**
 * `reqray show` — one request, whole.
 *
 * Either by id, or by a question: the last one, the last one that failed, the
 * slowest. The question is asked of the server rather than answered here —
 * "the slowest request" over a history on disk is not something a client can
 * work out from a page of it.
 */

import type { RequestDetail } from '@reqray/protocol';
import { boolFlag, type FlagSpec, stringFlag } from '../args.js';
import type { ListQuery } from '../client.js';
import { EXIT_OK, UsageError } from '../errors.js';
import { detailScreen } from '../render/detail.js';
import { sqlLines } from '../render/sql.js';
import type { Command, CommandContext } from './context.js';

const FLAGS: FlagSpec = {
  last: 'boolean',
  failed: 'boolean',
  slowest: 'boolean',
  path: 'string',
  json: 'boolean',
  body: 'boolean',
  sql: 'optional',
  full: 'boolean',
};

/**
 * `--sql` with no reference means all of them.
 *
 * The flag takes a value, so a bare `--sql` would swallow whatever came next;
 * an empty string is how "no reference given" arrives here.
 */
function sqlRef(context: CommandContext): string | null | undefined {
  const raw = stringFlag(context.args, 'sql');
  if (raw === null) return undefined;
  return raw.trim() === '' ? null : raw.trim();
}

export const show: Command = {
  name: 'show',
  summary: 'one request, whole',
  flags: FLAGS,

  async run(context): Promise<number> {
    const { client, globals, out, signal } = context;
    const id = await resolveId(context);
    if (id === null) return EXIT_OK;

    if (boolFlag(context.args, 'json')) {
      out.line(await client.detailRaw(id, signal));
      return EXIT_OK;
    }

    const detail = await client.detail(id, signal);

    if (boolFlag(context.args, 'body')) {
      out.line(bodyOf(detail));
      return EXIT_OK;
    }

    const ref = sqlRef(context);
    if (ref !== undefined) {
      const lines = sqlLines(detail, globals.theme, {
        only: ref,
        full: boolFlag(context.args, 'full'),
      });
      for (const line of lines) out.line(line);
      return EXIT_OK;
    }

    // Asked for after the request itself, and allowed to come back empty: a
    // verdict is worth printing when there is one and worth no words when
    // there is not.
    const compared = await client.baseline(id, signal);
    for (const line of detailScreen(detail, globals.theme, compared)) out.line(line);
    return EXIT_OK;
  },
};

/**
 * What `--path` searches for.
 *
 * A substring rather than a glob, because the store is what searches: asking
 * the collector "the last request whose path contains this" is one question
 * with one true answer, where matching a glob here would mean "the last one
 * among however many rows happened to come back". Surrounding `*` is dropped
 * so a glob typed out of habit still means what it looks like.
 */
function pathQuery(context: CommandContext): string | null {
  const raw = stringFlag(context.args, 'path');
  if (raw === null) return null;
  const trimmed = raw.replace(/^\*+/, '').replace(/\*+$/, '').trim();
  if (trimmed === '') {
    throw new UsageError('--path wants something to look for, not just a wildcard');
  }
  return trimmed;
}

/** The response body as it was recorded, truncation noted. */
function bodyOf(detail: RequestDetail): string {
  if (!detail.responseBody) return 'this request recorded no response body';
  const { text, truncated } = detail.responseBody;
  return truncated ? `${text}\n… cut at the recorded limit` : text;
}

/** The forms `show` takes, printed whenever it is asked for one it has not. */
const FORMS = [
  '',
  '  reqray show 8974                    that request',
  '  reqray show --last                  the one that just finished',
  '  reqray show --last --failed         the last one that failed',
  '  reqray show --last --slowest        the slowest one recorded',
  '  reqray show --last --path /orders   the last one to a path',
  '',
  '  reqray watch --ids                  prints the identifier of every row',
];

/**
 * Which request to show.
 *
 * `null` means the collector answered and had nothing — not an error, so it
 * is said plainly and the command succeeds.
 */
async function resolveId(context: CommandContext): Promise<string | null> {
  const { args, client, out, globals, signal } = context;
  const given = args.positionals[0];
  const failed = boolFlag(args, 'failed');
  const slowest = boolFlag(args, 'slowest');
  const path = pathQuery(context);
  const last = boolFlag(args, 'last') || failed || slowest || path !== null;

  if (given && last) {
    throw new UsageError('give show an id or a question, not both', FORMS);
  }
  if (given) return given;
  if (!last) {
    throw new UsageError('show needs an id, or a question to ask instead', FORMS);
  }

  const query: ListQuery = {
    limit: 1,
    ...(failed ? { onlyErrors: true } : {}),
    ...(slowest ? { sort: 'slowest' as const } : {}),
    ...(path ? { query: path } : {}),
  };
  const page = await client.list(query, signal);
  const row = page.requests[0];
  if (row) return row.id;

  const what = path
    ? `nothing recorded matches "${path}"`
    : failed
      ? 'no request has failed yet'
      : 'nothing has been recorded yet';
  out.line(globals.theme.paint('plain', `  ${what}`));
  out.line(
    globals.theme.paint(
      'dim',
      '  the panel is attached and answering — it just has nothing to show',
    ),
  );
  return null;
}
