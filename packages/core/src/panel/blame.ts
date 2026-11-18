/**
 * `git blame` for the frames of an exception.
 *
 * A stack trace says where it broke; blame says who last touched that line
 * and when, which is usually the next question. It runs `git` on the machine
 * the panel runs on, so it is gated exactly like replay and EXPLAIN: local
 * development by default, explicit opt-in anywhere else.
 *
 * Results are cached per file and revision — blame is not cheap, and the same
 * file is asked about once per frame of every occurrence of a group.
 */

import { execFile } from 'node:child_process';
import { isAbsolute, resolve, sep } from 'node:path';
import type { BlameLine } from '@reqray/protocol';
import { warnOnce } from '../logger.js';

export type { BlameLine };

const cache = new Map<string, BlameLine | null>();

/** Bounded so a long session cannot turn the cache into a leak. */
const CACHE_LIMIT = 500;

function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, timeout: 3_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Parses `git blame --porcelain` for a single line.
 *
 * The porcelain format leads with the hash, then key/value header lines; only
 * three of them matter here.
 */
export function parsePorcelain(output: string): BlameLine | null {
  const lines = output.split('\n');
  const header = lines[0]?.split(' ')[0];
  if (!header || !/^[0-9a-f]{7,40}$/.test(header)) return null;

  let author = 'unknown';
  let at = 0;
  for (const line of lines) {
    if (line.startsWith('author ')) author = line.slice('author '.length).trim();
    else if (line.startsWith('author-time ')) {
      at = Number.parseInt(line.slice('author-time '.length), 10) * 1000;
    }
  }

  // A line that is staged but not committed blames to all zeroes; naming a
  // commit that does not exist would be worse than saying nothing.
  if (/^0+$/.test(header)) return null;
  return { sha: header.slice(0, 7), author, at };
}

/**
 * Blame for one line of one file.
 *
 * @returns `null` when the file is untracked, the repository is absent, or
 * git is not installed — all ordinary situations, none of them an error.
 */
export async function blameLine(
  file: string,
  line: number,
  cwd: string,
): Promise<BlameLine | null> {
  if (!isAbsolute(file) || !Number.isInteger(line) || line < 1) return null;

  // Inside the project, or blame becomes a way to ask which absolute paths on
  // this machine are tracked, and by whom.
  const root = resolve(cwd);
  const target = resolve(file);
  if (target !== root && !target.startsWith(root + sep)) return null;

  const key = `${file}:${line}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let result: BlameLine | null = null;
  try {
    const output = await run(
      'git',
      ['blame', '--porcelain', '-L', `${line},${line}`, '--', file],
      cwd,
    );
    result = parsePorcelain(output);
  } catch (error) {
    // Not a repository, not tracked, no git at all: the panel simply shows
    // nothing for that frame.
    const reason = error instanceof Error ? error.message : String(error);
    warnOnce('panel.blame', `git blame unavailable: ${reason}`);
  }

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}

/** Forgets everything blamed so far. Needed by tests and after a checkout. */
export function clearBlameCache(): void {
  cache.clear();
}
