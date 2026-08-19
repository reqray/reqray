/**
 * End-to-end check on the demo application.
 *
 * The app runs in its own process, started exactly the way a user starts it —
 * `node --import @loupe/register` — so this covers the whole chain at once:
 * loader hooks, the pg instrumentation, the pool callsite handoff, the
 * detector, the transport and the panel API.
 *
 * It needs the workspace built, because `--import` loads the built entry, not
 * the sources. CI builds before running tests.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = `${exampleRoot}../../`;

interface Row {
  id: string;
  method: string;
  path: string;
  status: number;
  sqlCount: number;
  nPlusOne: boolean;
  durationMs: number;
}

interface Finding {
  detector: string;
  title: string;
  costMs: number;
  callsite: { relative: string; line: number } | null;
  hint: string;
}

let app: ChildProcess;
let base: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
}

async function waitForApp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The app is still starting: seeding the embedded database takes a moment.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the demo application did not come up');
}

beforeAll(async () => {
  if (!existsSync(`${repoRoot}packages/register/dist/index.js`)) {
    execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit', timeout: 300_000 });
  }

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--import', '@loupe/register', 'src/index.js'], {
    cwd: exampleRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });

  await waitForApp(`${base}/api/orders/eager`, 60_000);
}, 400_000);

afterAll(() => {
  app?.kill('SIGKILL');
});

describe('demo application', () => {
  it('finds the deliberate N+1 and shows the line of code', async () => {
    await fetch(`${base}/api/orders`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/orders');

    expect(row?.nPlusOne).toBe(true);
    expect(row?.sqlCount).toBeGreaterThan(100);

    const detail = (await (await fetch(`${base}/_loupe/api/requests/${row?.id}`)).json()) as {
      findings: Finding[];
      logs: Array<{ level: string; message: string }>;
    };
    const finding = detail.findings[0];

    // The console line written inside the handler belongs to this request.
    expect(detail.logs.some((line) => line.message.includes('loading line items'))).toBe(true);

    expect(finding?.detector).toBe('n_plus_one');
    // The line the loop lives on — the whole point of the product.
    expect(finding?.callsite?.relative).toBe('src/orders.js');
    expect(finding?.costMs).toBeGreaterThan(0);
    expect(finding?.hint).toContain('line_items');
  });

  it('finds nothing on the fixed route', async () => {
    await fetch(`${base}/api/orders/eager`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/orders/eager');

    expect(row?.nPlusOne).toBe(false);
    expect(row?.sqlCount).toBe(2);
  });

  it('finds sequential HTTP calls and shows the line of code', async () => {
    await fetch(`${base}/api/prices`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/prices');

    const detail = (await (await fetch(`${base}/_loupe/api/requests/${row?.id}`)).json()) as {
      findings: Finding[];
    };
    const finding = detail.findings.find((item) => item.detector === 'sequential_http');

    expect(finding).toBeDefined();
    // The line with `await fetch` inside the loop.
    expect(finding?.callsite?.relative).toBe('src/prices.js');
    expect(finding?.costMs).toBeGreaterThan(0);
    expect(finding?.hint).toContain('Promise.all');
  });

  it('finds nothing on the parallel route', async () => {
    await fetch(`${base}/api/prices/parallel`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/prices/parallel');
    expect(row).toBeDefined();

    const detail = (await (await fetch(`${base}/_loupe/api/requests/${row?.id}`)).json()) as {
      findings: Finding[];
    };
    expect(detail.findings).toHaveLength(0);
  });

  it('checkout — the whole "incident": a finding, logs and a masked card', async () => {
    await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: 3, cardNumber: '4111 1111 1111 1111' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/checkout');

    const detail = (await (await fetch(`${base}/_loupe/api/requests/${row?.id}`)).json()) as {
      findings: Finding[];
      logs: Array<{ message: string }>;
      requestBody: { text: string } | null;
    };

    const finding = detail.findings.find((item) => item.detector === 'sequential_http');
    expect(finding?.callsite?.relative).toBe('src/shop.js');

    expect(detail.logs.some((line) => line.message.includes('warehouse confirmed'))).toBe(true);

    expect(detail.requestBody?.text).toContain('[redacted]');
    expect(detail.requestBody?.text).not.toContain('4111');
  });

  it('search: parameter values and EXPLAIN with an index hint', async () => {
    await fetch(`${base}/api/search?q=walnut`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/search');

    const detail = (await (await fetch(`${base}/_loupe/api/requests/${row?.id}`)).json()) as {
      spans: Array<{ id: number; kind: string; values: string[] | null }>;
    };
    const span = detail.spans.find((item) => item.kind === 'db');
    // The demo opts into collectSqlValues — the panel shows `$1 = %walnut%`.
    expect(span?.values).toEqual(['%walnut%']);

    const explain = (await (
      await fetch(`${base}/_loupe/api/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: row?.id, spanId: span?.id }),
      })
    ).json()) as { nodes: Array<{ label: string }>; notes: Array<{ message: string }> };

    expect(explain.nodes.some((node) => node.label.includes('Seq Scan on products'))).toBe(true);
    expect(explain.notes.some((note) => note.message.includes('index'))).toBe(true);
  });

  it('registration: password hashing shows up as uncovered time', async () => {
    await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'grace@example.com', password: 'correct horse battery' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/register');
    expect(row).toBeDefined();

    const detail = (await (await fetch(`${base}/_loupe/api/requests/${row?.id}`)).json()) as {
      spans: Array<{ kind: string; duration: number }>;
      requestBody: { text: string } | null;
    };

    // The two queries take a couple of milliseconds; the rest of the request
    // is pbkdf2 at OWASP cost — uncovered time the waterfall must own up to.
    const covered = detail.spans
      .filter((span) => span.kind !== 'handler' && span.kind !== 'middleware')
      .reduce((sum, span) => sum + span.duration, 0);
    expect((row?.durationMs ?? 0) - covered).toBeGreaterThan(100);

    expect(detail.requestBody?.text).toContain('[redacted]');
    expect(detail.requestBody?.text).not.toContain('correct horse');
  });

  it('the flaky route yields both sides for comparison', async () => {
    await fetch(`${base}/api/orders/flaky`);
    await fetch(`${base}/api/orders/flaky`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Row[];
    };
    const flaky = list.requests.filter((item) => item.path === '/api/orders/flaky');

    expect(flaky.length).toBeGreaterThanOrEqual(2);
    expect(flaky.some((item) => item.nPlusOne)).toBe(true);
    expect(flaky.some((item) => !item.nPlusOne)).toBe(true);
  });

  it('remembers which test issued a request, and which test reproduces a crash', async () => {
    // What a test harness sets on every request it makes. Header values are
    // latin1, and `›` is not, so the harness percent-encodes it.
    const testName = 'orders.spec.ts:42 › creates an order';
    const header = { 'x-loupe-test': encodeURIComponent(testName) };
    await fetch(`${base}/api/order`, { headers: header });
    await fetch(`${base}/api/boom`, { headers: header });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Array<Row & { test: string | null; httpCount: number }>;
    };
    const fromTest = list.requests.filter((item) => item.test === testName);
    expect(fromTest.length).toBeGreaterThanOrEqual(2);

    // Ordinary traffic stays unmarked — the marker means something.
    expect(list.requests.some((item) => item.test === null)).toBe(true);

    const detail = (await (
      await fetch(`${base}/_loupe/api/requests/${fromTest[0]?.id}`)
    ).json()) as { test: string | null };
    expect(detail.test).toBe(testName);

    const exceptions = (await (await fetch(`${base}/_loupe/api/exceptions`)).json()) as {
      groups: Array<{ type: string; test: string | null }>;
    };
    expect(exceptions.groups[0]?.test).toBe(testName);
  });

  it('finds the same external call made twice, and the budget breach', async () => {
    await fetch(`${base}/api/invoice/1`);
    await fetch(`${base}/api/report`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Array<Row & { httpCount: number }>;
    };

    const invoice = list.requests.find((item) => item.path === '/api/invoice/1');
    expect(invoice?.httpCount).toBe(2);
    const invoiceDetail = (await (
      await fetch(`${base}/_loupe/api/requests/${invoice?.id}`)
    ).json()) as { findings: Finding[] };
    const duplicate = invoiceDetail.findings.find((item) => item.detector === 'dup_http');

    expect(duplicate).toBeDefined();
    expect(duplicate?.callsite?.relative).toBe('src/shop.js');
    // Both readers are named, since neither knows about the other.
    expect(duplicate?.hint).toContain('src/shop.js');

    // The slow report is over the 700 ms budget, and the finding says where
    // the time went — which here is nowhere Loupe can see.
    const report = list.requests.find((item) => item.path === '/api/report');
    const reportDetail = (await (
      await fetch(`${base}/_loupe/api/requests/${report?.id}`)
    ).json()) as { findings: Finding[] };
    const budget = reportDetail.findings.find((item) => item.detector === 'slow_budget');

    expect(budget).toBeDefined();
    expect(budget?.title).toContain('700');
    expect(budget?.hint).toContain('not covered by any instrumentation');
  });

  it('groups the exception and shows where it came from', async () => {
    await fetch(`${base}/api/boom`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const payload = (await (await fetch(`${base}/_loupe/api/exceptions`)).json()) as {
      groups: Array<{ type: string; origin: string | null; count: number }>;
    };

    expect(payload.groups[0]).toMatchObject({ type: 'TypeError' });
    expect(payload.groups[0]?.origin).toContain('src/index.js');
  });

  it('serves the panel at its own path', async () => {
    const response = await fetch(`${base}/_loupe/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });
});
