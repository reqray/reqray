/**
 * The client, run the way a person runs it.
 *
 * Argv in, lines and an exit code out. What is checked here is mostly the
 * contract around the output: which code comes back, which stream a failure
 * goes to, and that no stack trace ever reaches a terminal.
 */

import type { RequestRow } from '@reqray/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/app.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { fakeCollector } from './fixtures/collector.js';
import { failedRequest, ordersWithNPlusOne, quietRequest } from './fixtures/records.js';
import { calmRows, failedRow, nPlusOneRow } from './fixtures/rows.js';
import { capture, hasColor } from './fixtures/text.js';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const collector of open.splice(0)) await collector.close();
});

async function collector(options: Parameters<typeof fakeCollector>[0] = {}) {
  const started = await fakeCollector(options);
  open.push(started);
  return started;
}

/** Runs one command line and collects everything it printed. */
async function reqray(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out = capture();
  const err = capture();
  const code = await run(argv, {
    env: { COLUMNS: '100', ...env },
    stdout: { write: out.write },
    stderr: { write: err.write },
  });
  return { code, out: out.lines, err: err.lines };
}

describe('the command line itself', () => {
  it('prints what it can do when given nothing, and calls that a usage error', async () => {
    const { code, out } = await reqray([]);

    expect(code).toBe(EXIT_USAGE);
    expect(out.join('\n')).toContain('reqray watch');
    expect(out.join('\n')).toContain('reqray show');
  });

  it('prints the same on --help, which is a run that succeeded', async () => {
    expect((await reqray(['--help'])).code).toBe(EXIT_OK);
  });

  it('prints its version', async () => {
    const { code, out } = await reqray(['--version']);

    expect(code).toBe(EXIT_OK);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('refuses a command it does not have, and lists the ones it does', async () => {
    const { code, err } = await reqray(['top']);

    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('there is no command called "top"');
    expect(err.join('\n')).toContain('watch');
  });

  it('refuses a flag it does not know', async () => {
    const { code, err } = await reqray(['watch', '--slow-than', '100']);

    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('unknown flag');
  });

  it('refuses an address that is not one', async () => {
    expect((await reqray(['watch', '--url', 'localhost:3000'])).code).toBe(EXIT_USAGE);
    expect((await reqray(['watch', '--url', 'ftp://localhost'])).code).toBe(EXIT_USAGE);
  });

  it('takes the panel address from the environment when no flag says otherwise', async () => {
    const panel = await collector({ details: [ordersWithNPlusOne()] });
    const { code, out } = await reqray(['show', '8974'], { REQRAY_URL: panel.url });

    expect(code).toBe(EXIT_OK);
    expect(out[0]).toContain('GET /api/orders');
  });

  it('adds the usual mount point to a bare origin', async () => {
    const panel = await collector({ details: [ordersWithNPlusOne()] });
    const origin = new URL(panel.url).origin;

    expect((await reqray(['show', '8974', '--url', origin])).code).toBe(EXIT_OK);
  });

  it('will not draw a grid into a window too narrow for one', async () => {
    const { code, err } = await reqray(['watch'], { COLUMNS: '40' });

    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('40 columns wide');
  });
});

describe('when the collector is not there', () => {
  it('says so in one sentence, with three things to check, and exits 1', async () => {
    const { code, out, err } = await reqray(['watch', '--url', 'http://127.0.0.1:1']);

    expect(code).toBe(EXIT_FAILED);
    expect(out).toEqual([]);
    expect(err[0]).toBe('reqray: cannot reach the collector');
    expect(err.join('\n')).toContain('1  reqray is attached');
    // Nothing that looks like a stack trace.
    expect(err.join('\n')).not.toContain('    at ');
    expect(err.join('\n')).not.toContain('Error:');
  });

  it('keeps the technical cause for --verbose', async () => {
    const quiet = await reqray(['watch', '--url', 'http://127.0.0.1:1']);
    const loud = await reqray(['watch', '--url', 'http://127.0.0.1:1', '--verbose']);

    expect(quiet.err.join('\n')).not.toContain('fetch failed');
    expect(loud.err.join('\n')).toContain('fetch failed');
  });

  it('says what a gated collector wants, rather than repeating a status code', async () => {
    const panel = await collector({ token: 'shh' });
    const { code, err } = await reqray(['show', '--last', '--url', panel.url]);

    expect(code).toBe(EXIT_FAILED);
    expect(err.join('\n')).toContain('--token');
  });
});

describe('when it is there and has nothing', () => {
  it('watch says the connection worked and what to do about the silence', async () => {
    const panel = await collector({ rows: [] });
    const controller = new AbortController();
    const out = capture();

    const running = run(['watch', '--url', panel.url], {
      env: { COLUMNS: '100' },
      stdout: { write: out.write },
      stderr: { write: () => {} },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();

    expect(await running).toBe(EXIT_OK);
    expect(out.lines.join('\n')).toContain('collector attached — no requests recorded yet');
    expect(out.lines.join('\n')).toContain('buffer 500, empty');
    // Nothing red, and no column heads over an empty list.
    expect(out.lines.join('\n')).not.toContain('TIME');
  });

  it('show says the same and succeeds, because empty is not a failure', async () => {
    const panel = await collector({ rows: [] });
    const { code, out } = await reqray(['show', '--last', '--url', panel.url]);

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('nothing has been recorded yet');
  });

  it('and says specifically that nothing has failed when that is the question', async () => {
    const panel = await collector({ rows: calmRows() });
    const { out } = await reqray(['show', '--last', '--failed', '--url', panel.url]);

    expect(out.join('\n')).toContain('no request has failed yet');
  });
});

describe('show', () => {
  it('needs an id or a question, and says which', async () => {
    const { code, err } = await reqray(['show']);

    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('reqray show --last');
  });

  it('refuses both at once rather than guessing', async () => {
    expect((await reqray(['show', '8974', '--last'])).code).toBe(EXIT_USAGE);
  });

  it('asks the collector for the last one, the last failure, and the slowest', async () => {
    // Three different answers, so each question is proved to be asked.
    const newest = { ...(calmRows()[2] as RequestRow), startedAt: Date.now() };
    const slowest = { ...(calmRows()[1] as RequestRow), id: '8975', durationMs: 5_000 };
    const panel = await collector({
      rows: [newest, slowest, failedRow()],
      details: [ordersWithNPlusOne(), failedRequest(), quietRequest()],
    });

    const last = await reqray(['show', '--last', '--url', panel.url]);
    expect(last.out[0]).toContain('#8974');

    const failed = await reqray(['show', '--last', '--failed', '--url', panel.url]);
    expect(failed.out[0]).toContain('#9012');

    const worst = await reqray(['show', '--last', '--slowest', '--url', panel.url]);
    expect(worst.out[0]).toContain('#8975');
  });

  it('finds the last request to a path, for when no id is at hand', async () => {
    const panel = await collector({
      rows: [...calmRows(), failedRow()],
      details: [ordersWithNPlusOne(), failedRequest()],
    });

    const { code, out } = await reqray([
      'show',
      '--last',
      '--path',
      '/api/orders',
      '--url',
      panel.url,
    ]);

    expect(code).toBe(EXIT_OK);
    expect(out[0]).toContain('#9012');
  });

  it('a wildcard typed out of habit still means the substring inside it', async () => {
    const panel = await collector({
      rows: [calmRows()[2] as RequestRow],
      details: [ordersWithNPlusOne()],
    });

    const found = await reqray(['show', '--last', '--path', '*orders*', '--url', panel.url]);
    expect(found.code).toBe(EXIT_OK);
    expect(found.out[0]).toContain('#8974');
    expect((await reqray(['show', '--last', '--path', '*', '--url', panel.url])).code).toBe(
      EXIT_USAGE,
    );
  });

  it('says what it looked for when nothing matches', async () => {
    const panel = await collector({ rows: calmRows() });
    const { code, out } = await reqray(['show', '--last', '--path', '/nope', '--url', panel.url]);

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('nothing recorded matches "/nope"');
  });

  it('hands back the trace unformatted under --json', async () => {
    const panel = await collector({ details: [ordersWithNPlusOne()] });
    const { code, out } = await reqray(['show', '8974', '--json', '--url', panel.url]);

    expect(code).toBe(EXIT_OK);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toMatchObject({ id: '8974', method: 'GET' });
  });

  it('prints a body whole when asked for it, since that is why it was asked for', async () => {
    const panel = await collector({ details: [ordersWithNPlusOne()] });
    const { out } = await reqray(['show', '8974', '--body', '--url', panel.url]);

    expect(JSON.parse(out.join('\n'))).toMatchObject({ meta: { total: 213 } });
  });

  it('says a request is gone rather than printing a status code', async () => {
    const panel = await collector();
    const { code, err } = await reqray(['show', 'nope', '--url', panel.url]);

    expect(code).toBe(EXIT_FAILED);
    expect(err.join('\n')).toContain('evicted');
  });
});

describe('watch', () => {
  /** Runs watch until it has printed what was pushed, then stops it. */
  async function watched(argv: readonly string[], push: readonly unknown[]): Promise<string[]> {
    const panel = await collector({ rows: calmRows(), details: [failedRequest()] });
    const controller = new AbortController();
    const out = capture();

    const running = run([...argv, '--url', panel.url], {
      env: { COLUMNS: '100' },
      stdout: { write: out.write },
      stderr: { write: () => {} },
      signal: controller.signal,
    });

    await until(() => panel.watchers() === 1);
    for (const row of push) panel.push(row as never);
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    await running;
    return out.lines;
  }

  it('prints a line per request, under a head row', async () => {
    const lines = await watched(['watch'], calmRows().slice(0, 3));

    expect(lines[2]).toContain('TIME');
    expect(lines.filter((line) => line.includes('09:41:'))).toHaveLength(3);
  });

  it('narrows to what was asked for', async () => {
    const lines = await watched(['watch', '--slower-than', '100', '--method', 'POST'], calmRows());
    const rows = lines.filter((line) => line.includes('09:41:'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('POST');
  });

  it('keeps what the detectors flagged, and only that', async () => {
    const lines = await watched(['watch', '--findings-only'], [...calmRows(), nPlusOneRow()]);
    const rows = lines.filter((line) => line.includes('09:4'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('N+1');
  });

  it('prints the identifier when asked, so a row can be opened', async () => {
    const lines = await watched(['watch', '--ids'], [nPlusOneRow()]);

    expect(lines[2]).toContain('ID');
    expect(lines.find((line) => line.includes('N+1'))).toContain('8980');
    // And not otherwise: the grid is for reading, the id is for the next command.
    const without = await watched(['watch'], [nPlusOneRow()]);
    expect(without.find((line) => line.includes('N+1'))).not.toContain('8980');
  });

  it('narrows by path, with a glob', async () => {
    const lines = await watched(['watch', '--path', '/static/*'], calmRows());
    const rows = lines.filter((line) => line.includes('09:41:'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('/static/app.js');
  });

  it('gives a failed request its second line, from the record', async () => {
    const lines = await watched(['watch'], [failedRow()]);

    expect(lines.join('\n')).toContain('TypeError');
    expect(lines.join('\n')).toContain('reqray show 9012');
  });

  it('prints no escape codes when it is not writing to a terminal', async () => {
    expect(hasColor(await watched(['watch'], [nPlusOneRow()]))).toBe(false);
  });
});

/** Waits for a condition, or gives up loudly. */
async function until(ready: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the stream');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
