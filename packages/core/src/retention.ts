/**
 * How long collected requests are kept.
 *
 * One policy, read by every store that keeps anything: the SQLite history and
 * the log file must not mean different things by "a week", and the panel must
 * have one number to show and one to change.
 *
 * A change made from the panel is remembered in a small JSON file, because a
 * retention setting that resets when the process restarts is not a setting —
 * it is a mood. The file is read at startup and its values win over the ones
 * written in code: what somebody set last is what is in force.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RetentionLimits } from '@reqray/protocol';
import { warn, warnOnce } from './logger.js';

export type { RetentionLimits };

export interface RetentionOptions extends Partial<RetentionLimits> {
  /**
   * Where a change made from the panel is remembered.
   *
   * Without it the policy is still readable and still changeable, but the
   * change lasts as long as the process does.
   */
  readonly file?: string;
  /**
   * Whether the panel may change it.
   *
   * Defaults to development only: lowering retention deletes data, and a
   * panel reachable from outside must not offer that by accident.
   */
  readonly writable?: boolean;
}

/**
 * The policy in force.
 *
 * Read on every eviction rather than captured once, so a change takes effect
 * on the next sweep instead of at the next restart.
 */
export interface RetentionPolicy {
  /** The limits in force right now. */
  current(): RetentionLimits;
  /**
   * Changes them.
   *
   * @returns the limits in force after the change.
   * @throws when a value is not a limit — the panel is a client like any
   * other and its numbers are checked.
   */
  update(patch: Partial<RetentionLimits>): RetentionLimits;
  /** Whether {@link update} may be called from the panel. */
  readonly writable: boolean;
  /** Where a change is remembered, or `null` when it is not. */
  readonly file: string | null;
  /** Called after every change, with the limits that now apply. */
  subscribe(listener: (limits: RetentionLimits) => void): () => void;
}

/** A day, in milliseconds — what `days` is counted in. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Beyond this a number of days is a mistake rather than a policy. */
const MAX_DAYS = 3_650;

/** What is kept when nothing says otherwise: everything the stores allow. */
const NO_LIMITS: RetentionLimits = { days: null, maxBytes: null, maxRequests: null };

/** A limit, or the reason it is not one. */
function limitOf(name: string, value: unknown, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${name} must be a positive number of ${name === 'days' ? 'days' : 'units'}, or null`,
    );
  }
  if (value > max) throw new RangeError(`${name} is larger than makes sense (${max} at most)`);
  return value;
}

/** Reads a patch from anywhere — the panel, a file — and refuses nonsense. */
function sanitize(patch: Partial<RetentionLimits>, base: RetentionLimits): RetentionLimits {
  return {
    days: 'days' in patch ? limitOf('days', patch.days, MAX_DAYS) : base.days,
    maxBytes: 'maxBytes' in patch ? limitOf('maxBytes', patch.maxBytes, 2 ** 50) : base.maxBytes,
    maxRequests:
      'maxRequests' in patch
        ? limitOf('maxRequests', patch.maxRequests, 100_000_000)
        : base.maxRequests,
  };
}

/** What the remembered file holds. Anything else in it is ignored. */
function readFile(file: string): Partial<RetentionLimits> | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const patch: { days?: number | null; maxBytes?: number | null; maxRequests?: number | null } =
      {};
    for (const key of ['days', 'maxBytes', 'maxRequests'] as const) {
      const value = parsed[key];
      if (value === null || typeof value === 'number') patch[key] = value;
    }
    return patch;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missing) {
      // A settings file nobody can read is worth one line, not a crash: the
      // limits written in code still apply.
      warnOnce('retention.read', `retention settings could not be read (${file}), using the code`);
    }
    return null;
  }
}

/**
 * Writes the file the next start reads.
 *
 * Through a temporary name: a half-written settings file is one that reads as
 * "no limits at all" on the next boot.
 */
function writeSettings(file: string, limits: RetentionLimits): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(limits, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`retention settings could not be saved (${file}): ${reason}`);
  }
}

/**
 * Creates the policy.
 *
 * Pass the same object to every store and to `reqray({ retention })` — that is
 * what makes one number on the Project tab mean one thing.
 */
export function retentionPolicy(options: RetentionOptions = {}): RetentionPolicy {
  const file = options.file ?? null;
  const listeners = new Set<(limits: RetentionLimits) => void>();

  let limits = sanitize(options, NO_LIMITS);
  if (file) {
    const remembered = readFile(file);
    // What somebody set last wins over what was written in code: otherwise
    // the panel would appear to change the setting and quietly not.
    if (remembered) {
      try {
        limits = sanitize(remembered, limits);
      } catch {
        warnOnce('retention.invalid', `retention settings in ${file} are out of range, ignoring`);
      }
    }
  }

  return {
    file,
    writable: options.writable ?? true,

    current: () => limits,

    update(patch) {
      limits = sanitize(patch, limits);
      if (file) writeSettings(file, limits);
      for (const listener of listeners) {
        try {
          listener(limits);
        } catch {
          // A store that dislikes the news must not stop the others hearing it.
        }
      }
      return limits;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The moment before which nothing is kept, or `null` when age is unlimited.
 *
 * `now` is passed in so a test can decide what "today" is.
 */
export function cutoffOf(limits: RetentionLimits, now: number): number | null {
  return limits.days === null ? null : now - limits.days * DAY_MS;
}
