/**
 * How long anything is kept, and who may change it.
 *
 * The policy is the one number three places agree on — the store, the log and
 * the panel — so most of this is about what it refuses: a setting that can be
 * set to nonsense from a browser is not a setting, it is a way to lose data.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cutoffOf, DAY_MS, retentionPolicy, setLogSink } from '../src/index.js';

const directories: string[] = [];
const warnings: string[] = [];

beforeEach(() => {
  warnings.length = 0;
  setLogSink({ info: () => {}, warn: (message) => warnings.push(message) });
});

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  setLogSink(null);
});

function directory(): string {
  const made = mkdtempSync(join(tmpdir(), 'reqray-retention-'));
  directories.push(made);
  return made;
}

describe('the limits', () => {
  it('are whatever was asked for, and no limit otherwise', () => {
    expect(retentionPolicy({ days: 7 }).current()).toEqual({
      days: 7,
      maxBytes: null,
      maxRequests: null,
    });
    expect(retentionPolicy().current()).toEqual({
      days: null,
      maxBytes: null,
      maxRequests: null,
    });
  });

  it('change one at a time, leaving the rest alone', () => {
    const policy = retentionPolicy({ days: 7, maxBytes: 1_000 });

    expect(policy.update({ days: 3 })).toEqual({ days: 3, maxBytes: 1_000, maxRequests: null });
    expect(policy.current().maxBytes).toBe(1_000);
  });

  it('accept null as "no limit", which is different from not saying', () => {
    const policy = retentionPolicy({ days: 7 });

    expect(policy.update({ days: null }).days).toBeNull();
  });

  it('refuse what is not a limit', () => {
    const policy = retentionPolicy({ days: 7 });

    expect(() => policy.update({ days: 0 })).toThrow(/positive/);
    expect(() => policy.update({ days: -1 })).toThrow(/positive/);
    expect(() => policy.update({ days: Number.NaN })).toThrow(/positive/);
    expect(() => policy.update({ days: 'week' as never })).toThrow(/positive/);
    expect(() => policy.update({ days: 10_000 })).toThrow(/larger than makes sense/);
    // And the refusal changes nothing.
    expect(policy.current().days).toBe(7);
  });

  it('tell the stores, so a change does not wait for the next request', () => {
    const policy = retentionPolicy({ days: 7 });
    const heard: Array<number | null> = [];
    const stop = policy.subscribe((limits) => heard.push(limits.days));

    policy.update({ days: 2 });
    stop();
    policy.update({ days: 1 });

    expect(heard).toEqual([2]);
  });

  it('survive a subscriber that throws', () => {
    const policy = retentionPolicy({ days: 7 });
    policy.subscribe(() => {
      throw new Error('the store is unhappy');
    });
    const heard: number[] = [];
    policy.subscribe((limits) => heard.push(limits.days ?? 0));

    expect(() => policy.update({ days: 2 })).not.toThrow();
    expect(heard).toEqual([2]);
  });
});

describe('remembering a change', () => {
  it('writes it, and reads it back on the next start', () => {
    const file = join(directory(), 'retention.json');
    retentionPolicy({ days: 7, file }).update({ days: 2 });

    // A different process, the same file: what somebody set last is in force.
    expect(retentionPolicy({ days: 7, file }).current().days).toBe(2);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ days: 2 });
  });

  it('keeps the code’s limits for whatever the file does not mention', () => {
    const file = join(directory(), 'retention.json');
    writeFileSync(file, JSON.stringify({ days: 3 }));

    expect(retentionPolicy({ days: 7, maxBytes: 500, file }).current()).toEqual({
      days: 3,
      maxBytes: 500,
      maxRequests: null,
    });
  });

  it('ignores a file that is not one, and says so once', () => {
    const file = join(directory(), 'retention.json');
    writeFileSync(file, 'not json at all');

    expect(retentionPolicy({ days: 7, file }).current().days).toBe(7);
    expect(warnings.join(' ')).toContain('could not be read');
  });

  it('ignores values in the file that are out of range', () => {
    const file = join(directory(), 'retention.json');
    writeFileSync(file, JSON.stringify({ days: -5 }));

    expect(retentionPolicy({ days: 7, file }).current().days).toBe(7);
  });

  it('works without a file, for as long as the process lives', () => {
    const policy = retentionPolicy({ days: 7 });

    expect(policy.file).toBeNull();
    expect(policy.update({ days: 1 }).days).toBe(1);
  });

  it('says so rather than throwing when the file cannot be written', () => {
    const blocked = join(directory(), 'in-the-way');
    writeFileSync(blocked, 'x');
    const policy = retentionPolicy({ days: 7, file: join(blocked, 'retention.json') });

    expect(policy.update({ days: 2 }).days).toBe(2);
    expect(warnings.join(' ')).toContain('could not be saved');
  });
});

describe('what the panel may do', () => {
  it('is writable unless the application says otherwise', () => {
    expect(retentionPolicy({ days: 7 }).writable).toBe(true);
    expect(retentionPolicy({ days: 7, writable: false }).writable).toBe(false);
  });
});

describe('the cutoff', () => {
  it('is a number of days back from now', () => {
    expect(cutoffOf({ days: 2, maxBytes: null, maxRequests: null }, 10 * DAY_MS)).toBe(8 * DAY_MS);
  });

  it('is nothing at all when age is not limited', () => {
    expect(cutoffOf({ days: null, maxBytes: null, maxRequests: null }, 0)).toBeNull();
  });
});
