/**
 * `@reqray/transport-file` — the request log on disk.
 *
 * One line of JSON per recorded request, in a file per day. Not a store: the
 * panel never reads it. It is what a store on disk cannot be — something
 * `grep` understands, `tail -f` follows, a log shipper picks up and an
 * operator copies off the machine after the container is gone.
 *
 * It runs beside a store rather than instead of one:
 *
 * ```js
 * const retention = retentionPolicy({ days: 7, file: '.reqray/retention.json' });
 * reqray({
 *   retention,
 *   transport: [
 *     sqliteTransport({ file: '.reqray/requests.db', retention }),
 *     fileTransport({ dir: '.reqray/log', retention }),
 *   ],
 * });
 * ```
 *
 * Writing is off the hot path — `send` is called after the response — but it
 * is still someone's process: writes are streamed, a write that fails takes
 * the log down and nothing else, and a queue that grows past its cap drops
 * lines and says how many rather than eating the heap.
 */

import {
  createWriteStream,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';
import {
  cutoffOf,
  DAY_MS,
  type RetentionPolicy,
  type Transport,
  warn,
  warnOnce,
} from '@reqray/core';
import type { RecordedRequest, RetentionLimits } from '@reqray/protocol';

/** Options for {@link fileTransport}. */
export interface FileTransportOptions {
  /** Directory the log files live in. Created if it is not there. */
  readonly dir: string;
  /**
   * The retention policy, shared with the store.
   *
   * Without one the limits below apply and nothing can change them from the
   * panel.
   */
  readonly retention?: RetentionPolicy;
  /** How many days of log to keep, when no policy says otherwise. */
  readonly days?: number | null;
  /** How much disk the log may take, when no policy says otherwise. */
  readonly maxBytes?: number | null;
  /** File name prefix; the date and `.jsonl` follow it. */
  readonly prefix?: string;
  /**
   * How much may wait in memory for the disk, bytes.
   *
   * Past this, lines are dropped and counted. A log is worth less than the
   * application it is a log of.
   */
  readonly maxPendingBytes?: number;
  /**
   * What time it is.
   *
   * Only tests pass this: rotation happens at midnight, and waiting for one
   * is not a test.
   */
  readonly now?: () => number;
}

/** What the log holds right now. */
export interface FileLogStats {
  readonly files: number;
  /** How much disk they take. */
  readonly bytes: number;
  /** The day of the oldest file, epoch ms at local midnight. `null` if empty. */
  readonly oldestAt: number | null;
  /** How many requests this process has written. */
  readonly written: number;
  /** How many it had to drop because the disk could not keep up. */
  readonly dropped: number;
  /** `false` once a write has failed: the log is off, the application is not. */
  readonly writing: boolean;
}

/** What was removed by one sweep. */
export interface SweepResult {
  readonly removed: number;
  readonly bytesFreed: number;
}

/** A transport that writes a log and answers questions about it. */
export interface FileLog extends Transport {
  readonly dir: string;
  stats(): FileLogStats;
  /** Applies the retention limits now. Called on rotation and on a timer. */
  sweep(now?: number): SweepResult;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** A week of history: long enough for "what happened yesterday". */
const DEFAULT_DAYS = 7;
/** Half a gigabyte, the same order as the SQLite store's own cap. */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_PREFIX = 'requests';
const DEFAULT_PENDING = 8 * 1024 * 1024;
/** How often a sweep may run while writing. */
const SWEEP_EVERY_MS = 60_000;

/** The local day a moment falls in, as `2026-08-20`. */
export function dayOf(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** Local midnight of a day named the way {@link dayOf} names it. */
export function midnightOf(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [, year, month, date] = match;
  return new Date(Number(year), Number(month) - 1, Number(date)).getTime();
}

export function fileTransport(options: FileTransportOptions): FileLog {
  const dir = options.dir;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const maxPending = options.maxPendingBytes ?? DEFAULT_PENDING;
  const clock = options.now ?? Date.now;
  const own: RetentionLimits = {
    days: options.days === undefined ? DEFAULT_DAYS : options.days,
    maxBytes: options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes,
    maxRequests: null,
  };

  /**
   * The limits in force: the shared policy if there is one, ours otherwise.
   *
   * A policy that says nothing about size leaves this log's own cap standing,
   * the way the SQLite store reads the same policy. `{ days: 7 }` is what
   * most people write, and it must not mean "and as many bytes as the disk
   * has".
   */
  const limits = (): RetentionLimits => {
    const shared = options.retention?.current();
    return shared ? { ...shared, maxBytes: shared.maxBytes ?? own.maxBytes } : own;
  };

  let stream: WriteStream | null = null;
  let openDay = '';
  let written = 0;
  let dropped = 0;
  let writing = true;
  let sweptAt = 0;

  const fileFor = (day: string) => join(dir, `${prefix}-${day}.jsonl`);

  const stop = (reason: string): void => {
    writing = false;
    stream?.destroy();
    stream = null;
    warnOnce('log.write', `the request log is off: ${reason}`);
  };

  function open(day: string): void {
    try {
      mkdirSync(dir, { recursive: true });
      // The descriptor is opened here rather than by the stream, which opens
      // on a later tick. Two things go wrong with a late open: the file is
      // not there to be swept or counted until it happens, and an open that
      // lands after a sweep has removed the name creates the file again —
      // yesterday's log, resurrected empty.
      const path = fileFor(day);
      const fd = openSync(path, 'a');
      const next = createWriteStream(path, { fd, flags: 'a' });
      next.on('error', (error) => stop(error.message));
      stream?.end();
      stream = next;
      openDay = day;
    } catch (error) {
      stop(error instanceof Error ? error.message : String(error));
    }
  }

  /** Every log file this directory holds, oldest first. */
  function files(): Array<{ path: string; day: string; at: number; bytes: number }> {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }

    const found: Array<{ path: string; day: string; at: number; bytes: number }> = [];
    for (const name of names) {
      const match = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`).exec(name);
      const day = match?.[1];
      const at = day ? midnightOf(day) : null;
      if (!day || at === null) continue;
      const path = join(dir, name);
      const size = statSync(path, { throwIfNoEntry: false })?.size;
      if (size === undefined) continue;
      found.push({ path, day, at, bytes: size });
    }
    return found.sort((a, b) => a.at - b.at);
  }

  function sweep(now = clock()): SweepResult {
    sweptAt = now;
    const { days, maxBytes } = limits();
    const cutoff = cutoffOf({ days, maxBytes, maxRequests: null }, now);
    let removed = 0;
    let bytesFreed = 0;

    const remaining = files();
    const drop = (index: number): void => {
      const entry = remaining[index];
      if (!entry) return;
      try {
        unlinkSync(entry.path);
        removed++;
        bytesFreed += entry.bytes;
        remaining.splice(index, 1);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnOnce('log.sweep', `a log file could not be removed (${entry.path}): ${reason}`);
        remaining.splice(index, 1);
      }
    };

    // By age first. A day's file is only past the cutoff once the whole day
    // is: a file named for today holds requests from a minute ago.
    if (cutoff !== null) {
      for (let index = remaining.length - 1; index >= 0; index--) {
        const entry = remaining[index];
        if (entry && entry.at + DAY_MS <= cutoff) drop(index);
      }
    }

    // Then by size, oldest first — and never the file being written to, which
    // is the only one that would take the current day's requests with it.
    if (maxBytes !== null) {
      let total = remaining.reduce((sum, entry) => sum + entry.bytes, 0);
      while (total > maxBytes && remaining.length > 1) {
        const oldest = remaining[0];
        if (!oldest) break;
        total -= oldest.bytes;
        drop(0);
      }
      if (total > maxBytes) {
        warnOnce(
          'log.size',
          `today's log file alone is over the ${maxBytes} byte limit; nothing older is left to remove`,
        );
      }
    }

    return { removed, bytesFreed };
  }

  // Old files are swept at startup too: an application that starts and gets no
  // traffic still has yesterday's limits to honour.
  sweep();
  options.retention?.subscribe(() => void sweep());

  return {
    name: 'file',
    dir,

    send(request: RecordedRequest) {
      if (!writing) return;

      const now = clock();
      const day = dayOf(now);
      if (day !== openDay) {
        open(day);
        sweep(now);
      } else if (now - sweptAt > SWEEP_EVERY_MS) {
        sweep(now);
      }
      if (!stream) return;

      let line: string;
      try {
        line = `${JSON.stringify(request)}\n`;
      } catch (error) {
        // A record that will not serialize is one record, not a reason to stop.
        const reason = error instanceof Error ? error.message : String(error);
        warnOnce('log.serialize', `a request could not be written to the log: ${reason}`);
        return;
      }

      // What the stream still owes the disk, asked of the stream itself: a
      // count of refused writes would miss the case where nothing has been
      // refused yet and megabytes are already queued.
      if (stream.writableLength > maxPending) {
        dropped++;
        warnOnce(
          'log.behind',
          'the request log is behind the application and lines are being dropped',
        );
        return;
      }

      stream.write(line);
      written++;
    },

    stats(): FileLogStats {
      const all = files();
      return {
        files: all.length,
        bytes: all.reduce((sum, entry) => sum + entry.bytes, 0),
        oldestAt: all[0]?.at ?? null,
        written,
        dropped,
        writing,
      };
    },

    sweep,

    async flush() {
      const open = stream;
      if (!open) return;
      // An empty write with a callback: `drain` only ever fires after a write
      // that was refused, so waiting for one is how a flush hangs forever.
      await new Promise<void>((resolve) => {
        open.write('', () => resolve());
      });
    },

    async close() {
      const open = stream;
      stream = null;
      if (!open) return;
      await new Promise<void>((resolve) => {
        open.end(() => resolve());
        open.once('error', (error) => {
          warn(`the request log did not close cleanly: ${error.message}`);
          resolve();
        });
      });
    },
  };
}

/**
 * The retention policy, re-exported.
 *
 * Anyone keeping requests on disk installs this package; making them add
 * `@reqray/core` as well to say how long to keep them would be a dependency
 * for one function. It is the same object either way.
 */
export {
  type RetentionLimits,
  type RetentionOptions,
  type RetentionPolicy,
  retentionPolicy,
} from '@reqray/core';
