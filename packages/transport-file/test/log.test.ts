/**
 * The request log on disk.
 *
 * What matters here is the promise around it rather than the JSON: a file per
 * day so retention is a matter of deleting files, a sweep that never takes
 * today's with it, and a log that goes quiet instead of taking the
 * application down when the disk says no.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAY_MS,
  type RecordedRequest,
  retentionPolicy,
  setLogSink,
  timingOf,
  weightOf,
} from '@reqray/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dayOf, fileTransport, midnightOf } from '../src/index.js';

const AT = new Date(2026, 7, 20, 9, 41, 2).getTime();

const directories: string[] = [];
const logs: Array<{ close(): Promise<void> }> = [];
const warnings: string[] = [];

beforeEach(() => {
  warnings.length = 0;
  setLogSink({ info: () => {}, warn: (message) => warnings.push(message) });
});

afterEach(async () => {
  for (const log of logs.splice(0)) await log.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  setLogSink(null);
});

function directory(): string {
  const made = mkdtempSync(join(tmpdir(), 'reqray-log-'));
  directories.push(made);
  return made;
}

function request(over: Partial<RecordedRequest> = {}): RecordedRequest {
  const base = {
    id: 'r1',
    method: 'GET',
    path: '/api/orders',
    query: null,
    status: 200,
    durationMs: 12,
    startedAt: AT,
    spans: [],
    findings: [],
    requestHeaders: {},
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    logs: [],
    error: null,
    droppedSpans: 0,
    droppedLogs: 0,
    test: null,
    ...over,
  };
  return {
    ...base,
    timing: timingOf(base.spans, base.durationMs),
    host: base.host ?? null,
    weight: weightOf(base),
    cost: null,
  };
}

/** Opens a log whose idea of "now" the test controls. */
function open(dir: string, options: Record<string, unknown> = {}) {
  let now = AT;
  const log = fileTransport({ dir, now: () => now, ...options });
  logs.push(log);
  return {
    log,
    /** Moves the clock, in days. */
    travel(days: number) {
      now += days * DAY_MS;
    },
  };
}

/** The lines of one day's file. */
function linesOf(dir: string, at: number): string[] {
  const path = join(dir, `requests-${dayOf(at)}.jsonl`);
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
}

describe('writing', () => {
  it('puts one request on one line', async () => {
    const dir = directory();
    const { log } = open(dir);

    log.send(request({ id: 'a' }));
    log.send(request({ id: 'b', status: 500 }));
    await log.close();

    const lines = linesOf(dir, AT);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 'a', path: '/api/orders' });
    // Whole records, so the file is a log and not a summary of one.
    expect(JSON.parse(lines[1] as string)).toMatchObject({ id: 'b', status: 500 });
  });

  it('starts a new file when the day turns', async () => {
    const dir = directory();
    const { log, travel } = open(dir);

    log.send(request({ id: 'yesterday' }));
    travel(1);
    log.send(request({ id: 'today' }));
    await log.close();

    expect(readdirSync(dir).sort()).toEqual([
      `requests-${dayOf(AT)}.jsonl`,
      `requests-${dayOf(AT + DAY_MS)}.jsonl`,
    ]);
    expect(linesOf(dir, AT + DAY_MS)).toHaveLength(1);
  });

  it('counts what it wrote', async () => {
    const dir = directory();
    const { log } = open(dir);

    log.send(request());
    log.send(request());
    await log.flush();

    expect(log.stats()).toMatchObject({ files: 1, written: 2, dropped: 0, writing: true });
    expect(log.stats().bytes).toBeGreaterThan(0);
  });

  it('drops one record it cannot serialize and keeps going', async () => {
    const dir = directory();
    const { log } = open(dir);
    const circular = request({ id: 'loop' }) as unknown as Record<string, unknown>;
    circular['self'] = circular;

    log.send(circular as unknown as RecordedRequest);
    log.send(request({ id: 'fine' }));
    await log.close();

    expect(linesOf(dir, AT)).toHaveLength(1);
    expect(warnings.join(' ')).toContain('could not be written');
  });
});

describe('retention', () => {
  it('removes whole days once they are past the limit', async () => {
    const dir = directory();
    const { log, travel } = open(dir, { days: 2 });

    log.send(request({ id: 'day0' }));
    travel(1);
    log.send(request({ id: 'day1' }));
    travel(1);
    log.send(request({ id: 'day2' }));
    travel(1);
    log.send(request({ id: 'day3' }));
    await log.flush();

    // Two days of history plus today; the first day is gone.
    const kept = readdirSync(dir).sort();
    expect(kept).not.toContain(`requests-${dayOf(AT)}.jsonl`);
    expect(kept).toContain(`requests-${dayOf(AT + 3 * DAY_MS)}.jsonl`);
  });

  it('keeps a day until the whole day is past the cutoff', async () => {
    const dir = directory();
    const { log, travel } = open(dir, { days: 1 });

    log.send(request({ id: 'day0' }));
    travel(1);
    log.send(request({ id: 'day1' }));
    await log.flush();

    // Yesterday is one day old, not more: a file named for a day holds
    // requests from every hour of it.
    expect(readdirSync(dir)).toContain(`requests-${dayOf(AT)}.jsonl`);
  });

  it('removes the oldest files when the whole log is too big', () => {
    const dir = directory();
    for (const day of [0, 1, 2]) {
      writeFileSync(join(dir, `requests-${dayOf(AT + day * DAY_MS)}.jsonl`), 'x'.repeat(1_000));
    }

    // The sweep at startup is the one that acts: three kilobytes over a limit
    // of two and a half, so the oldest day goes and the newer two stay.
    open(dir, { days: null, maxBytes: 2_500 });

    expect(readdirSync(dir).sort()).toEqual([
      `requests-${dayOf(AT + DAY_MS)}.jsonl`,
      `requests-${dayOf(AT + 2 * DAY_MS)}.jsonl`,
    ]);
  });

  it('never removes the last file, which is the one being written', () => {
    const dir = directory();
    writeFileSync(join(dir, `requests-${dayOf(AT)}.jsonl`), 'x'.repeat(5_000));
    const { log } = open(dir, { days: null, maxBytes: 100 });

    expect(log.sweep().removed).toBe(0);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(warnings.join(' ')).toContain('over the 100 byte limit');
  });

  it('sweeps at startup, before anything is written', () => {
    const dir = directory();
    writeFileSync(join(dir, `requests-${dayOf(AT - 30 * DAY_MS)}.jsonl`), 'old');
    writeFileSync(join(dir, `requests-${dayOf(AT - 1 * DAY_MS)}.jsonl`), 'recent');

    open(dir, { days: 3 });

    // An application that starts and gets no traffic still honours the limit.
    expect(readdirSync(dir)).toEqual([`requests-${dayOf(AT - DAY_MS)}.jsonl`]);
  });

  it('ignores files that are not its own', () => {
    const dir = directory();
    writeFileSync(join(dir, 'notes.txt'), 'not a log');
    writeFileSync(join(dir, 'requests-nonsense.jsonl'), 'not a day');
    const { log } = open(dir, { days: 1 });

    log.sweep();

    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'requests-nonsense.jsonl']);
  });

  it('keeps its own size cap under a policy that names only days', () => {
    // `retentionPolicy({ days: 7 })` says nothing about size. It used to be
    // read as "no size limit at all", and the log grew until the disk ended.
    const dir = directory();
    for (const day of [0, 1, 2]) {
      writeFileSync(join(dir, `requests-${dayOf(AT + day * DAY_MS)}.jsonl`), 'x'.repeat(1_000));
    }

    open(dir, { retention: retentionPolicy({ days: 30 }), maxBytes: 2_500 });

    expect(readdirSync(dir).sort()).toEqual([
      `requests-${dayOf(AT + DAY_MS)}.jsonl`,
      `requests-${dayOf(AT + 2 * DAY_MS)}.jsonl`,
    ]);
  });

  it('follows a shared policy, including a change made later', async () => {
    const dir = directory();
    const retention = retentionPolicy({ days: 30 });
    for (const day of [0, 1, 2, 3]) {
      writeFileSync(join(dir, `requests-${dayOf(AT - day * DAY_MS)}.jsonl`), 'x');
    }
    const { log } = open(dir, { retention });

    expect(readdirSync(dir)).toHaveLength(4);

    // The panel lowers it; the log obeys without waiting for a request.
    retention.update({ days: 1 });
    await log.flush();

    expect(readdirSync(dir).sort()).toEqual([
      `requests-${dayOf(AT - DAY_MS)}.jsonl`,
      `requests-${dayOf(AT)}.jsonl`,
    ]);
  });
});

describe('when the disk says no', () => {
  it('goes quiet instead of taking the application with it', async () => {
    // A path that cannot be a directory: the file in the way is not one.
    const dir = directory();
    const blocked = join(dir, 'file-in-the-way');
    writeFileSync(blocked, 'x');
    const log = fileTransport({ dir: join(blocked, 'log') });
    logs.push(log);

    expect(() => log.send(request())).not.toThrow();
    expect(log.stats().writing).toBe(false);
    expect(warnings.join(' ')).toContain('the request log is off');
  });

  it('drops lines rather than the heap when writing falls behind', async () => {
    const dir = directory();
    const { log } = open(dir, { maxPendingBytes: 1 });

    for (let index = 0; index < 200; index++) log.send(request({ id: `r${index}` }));

    expect(log.stats().dropped).toBeGreaterThan(0);
    expect(warnings.join(' ')).toContain('behind the application');
    await log.close();
  });
});

describe('the day a file is named for', () => {
  it('round-trips through midnight', () => {
    expect(midnightOf(dayOf(AT))).toBe(new Date(2026, 7, 20).getTime());
    expect(midnightOf('not-a-day')).toBeNull();
  });
});
