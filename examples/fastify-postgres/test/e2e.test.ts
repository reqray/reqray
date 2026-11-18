/**
 * End-to-end check on the demo application.
 *
 * The app runs in its own process, started exactly the way a user starts it —
 * `node --import @reqray/register` — so this covers the whole chain at once:
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
  evidence: Record<string, unknown>;
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
  app = spawn(process.execPath, ['--import', '@reqray/register', 'src/index.js'], {
    cwd: exampleRoot,
    env: { ...process.env, PORT: String(port), DEMO_TRAFFIC: 'off' },
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

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/orders');

    expect(row?.nPlusOne).toBe(true);
    expect(row?.sqlCount).toBeGreaterThan(100);

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
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

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/orders/eager');

    expect(row?.nPlusOne).toBe(false);
    expect(row?.sqlCount).toBe(2);
  });

  it('finds sequential HTTP calls and shows the line of code', async () => {
    await fetch(`${base}/api/prices`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/prices');

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
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

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/prices/parallel');
    expect(row).toBeDefined();

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
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

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/checkout');

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
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

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/search');

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
      spans: Array<{ id: number; kind: string; values: string[] | null }>;
    };
    const span = detail.spans.find((item) => item.kind === 'db');
    // The demo opts into collectSqlValues — the panel shows `$1 = %walnut%`.
    expect(span?.values).toEqual(['%walnut%']);

    const explain = (await (
      await fetch(`${base}/_reqray/api/explain`, {
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

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/register');
    expect(row).toBeDefined();

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
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

  it('tells an expensive request from a merely slow one', async () => {
    // The claim the cost column exists to make, asserted where it can be made
    // honestly: a whole process to itself. `/api/register` hashes a password
    // and burns its whole life on a processor; `/api/report` waits, and is
    // several times longer for a fraction of the price.
    //
    // Marked with the test header, because the demo generates its own traffic
    // to the same routes — and a registration for an address already taken
    // returns before it hashes anything, which is the cheap request this test
    // must not pick up.
    const name = 'cost/expensive-vs-slow';
    const mark = { 'x-reqray-test': name };

    await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...mark },
      body: JSON.stringify({ email: `ada-${Date.now()}@example.com`, password: 'correct horse' }),
    });
    await fetch(`${base}/api/report`, { headers: mark });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<Row & { cpuMs: number | null; cpuShare: number | null; test: string | null }>;
    };
    const mine = list.requests.filter((item) => item.test === name);
    const hashing = mine.find((item) => item.path === '/api/register');
    const waiting = mine.find((item) => item.path === '/api/report');

    // Asserted on processor time rather than on its share of the wall clock.
    // A busy machine stretches the wall clock without granting more
    // processor, so the share of a genuinely expensive request falls under
    // load; the milliseconds it burns do not.
    expect(hashing?.cpuMs ?? 0).toBeGreaterThan(100);
    expect(waiting?.cpuMs ?? 999).toBeLessThan(50);
    // The slower request is the cheaper one, which is the whole point: a list
    // ordered by duration puts these two the wrong way round.
    expect(waiting?.durationMs ?? 0).toBeGreaterThan(hashing?.durationMs ?? 0);
    expect(hashing?.cpuShare ?? 0).toBeGreaterThan(waiting?.cpuShare ?? 1);
  });

  it('the flaky route yields both sides for comparison', async () => {
    // The route alternates, so two calls are enough in principle. In practice
    // the detector is allowed to decline: on a machine running the whole suite
    // the spans of a loop can smear until they no longer look sequential, and
    // a detector that fires anyway would be the false positive this project
    // refuses. So it is asked a few times, and the failure that matters — one
    // side never appearing at all — still fails.
    let flaky: Row[] = [];
    for (let round = 0; round < 6; round++) {
      await fetch(`${base}/api/orders/flaky`);
      await fetch(`${base}/api/orders/flaky`);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
        requests: Row[];
      };
      flaky = list.requests.filter((item) => item.path === '/api/orders/flaky');
      if (flaky.some((item) => item.nPlusOne) && flaky.some((item) => !item.nPlusOne)) break;
    }

    expect(flaky.length).toBeGreaterThanOrEqual(2);
    expect(flaky.some((item) => item.nPlusOne)).toBe(true);
    expect(flaky.some((item) => !item.nPlusOne)).toBe(true);
  });

  it('remembers which test issued a request, and which test reproduces a crash', async () => {
    // What a test harness sets on every request it makes. Header values are
    // latin1, and `›` is not, so the harness percent-encodes it.
    const testName = 'orders.spec.ts:42 › creates an order';
    const header = { 'x-reqray-test': encodeURIComponent(testName) };
    await fetch(`${base}/api/order`, { headers: header });
    await fetch(`${base}/api/boom`, { headers: header });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<Row & { test: string | null; httpCount: number }>;
    };
    const fromTest = list.requests.filter((item) => item.test === testName);
    expect(fromTest.length).toBeGreaterThanOrEqual(2);

    // Ordinary traffic stays unmarked — the marker means something.
    expect(list.requests.some((item) => item.test === null)).toBe(true);

    const detail = (await (
      await fetch(`${base}/_reqray/api/requests/${fromTest[0]?.id}`)
    ).json()) as { test: string | null };
    expect(detail.test).toBe(testName);

    const exceptions = (await (await fetch(`${base}/_reqray/api/exceptions`)).json()) as {
      groups: Array<{ type: string; test: string | null }>;
    };
    expect(exceptions.groups[0]?.test).toBe(testName);
  });

  it('finds the same external call made twice, and the budget breach', async () => {
    await fetch(`${base}/api/invoice/1`);
    await fetch(`${base}/api/report`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<Row & { httpCount: number }>;
    };

    const invoice = list.requests.find((item) => item.path === '/api/invoice/1');
    expect(invoice?.httpCount).toBe(2);
    const invoiceDetail = (await (
      await fetch(`${base}/_reqray/api/requests/${invoice?.id}`)
    ).json()) as { findings: Finding[] };
    const duplicate = invoiceDetail.findings.find((item) => item.detector === 'dup_http');

    expect(duplicate).toBeDefined();
    expect(duplicate?.callsite?.relative).toBe('src/shop.js');
    // Both readers are named, since neither knows about the other.
    expect(duplicate?.hint).toContain('src/shop.js');

    // The slow report is over the 700 ms budget, and the finding says where
    // the time went — which here is nowhere Reqray can see.
    const report = list.requests.find((item) => item.path === '/api/report');
    const reportDetail = (await (
      await fetch(`${base}/_reqray/api/requests/${report?.id}`)
    ).json()) as { findings: Finding[] };
    const budget = reportDetail.findings.find((item) => item.detector === 'slow_budget');

    expect(budget).toBeDefined();
    expect(budget?.title).toContain('700');
    expect(budget?.hint).toContain('not covered by any instrumentation');
  });

  it('records real Redis traffic, cold and warm, and finds the read made twice', async () => {
    // Twice: the first call misses and fills the cache, the second is the
    // ordinary steady state. Both must read the same key one time too many.
    await fetch(`${base}/api/profile/1`);
    await fetch(`${base}/api/profile/1`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const rows = list.requests.filter((item) => item.path === '/api/profile/1');
    expect(rows).toHaveLength(2);

    interface Detail {
      findings: Finding[];
      spans: Array<{ kind: string; command: string | null; key: string; hit: boolean | null }>;
    }
    const details = (await Promise.all(
      rows.map(async (row) => (await fetch(`${base}/_reqray/api/requests/${row.id}`)).json()),
    )) as Detail[];

    const cacheOf = (detail: Detail) => detail.spans.filter((span) => span.kind === 'cache');
    const wrote = (detail: Detail) => cacheOf(detail).some((span) => span.command === 'SET');
    const cold = details.find(wrote);
    const warm = details.find((detail) => !wrote(detail));

    // The first request: a miss, the value stored, then the read that did not
    // need making. The second: two hits of what is already there.
    expect(cacheOf(cold as Detail).map((span) => `${span.command} ${span.key}`)).toEqual([
      'GET user:1',
      'SET user:1',
      'GET user:1',
      'INCR profile:views:1',
    ]);
    expect(cacheOf(cold as Detail).map((span) => span.hit)).toEqual([false, null, true, null]);
    expect(cacheOf(warm as Detail).map((span) => `${span.command} ${span.key}`)).toEqual([
      'GET user:1',
      'GET user:1',
      'INCR profile:views:1',
    ]);

    for (const detail of details) {
      const duplicate = detail.findings.find((item) => item.detector === 'dup_cache');
      expect(duplicate?.callsite?.relative).toBe('src/shop.js');
      // The second reader is named too: it is the one that did not need to read.
      expect(duplicate?.hint).toContain('src/shop.js');

      // What was cached is a user record with an email in it. The spans know
      // the key, the timing and the outcome — never the value.
      expect(JSON.stringify(cacheOf(detail))).not.toContain('ada@example.com');
    }
  });

  it('the queue in front of a query, not the query', async () => {
    // Five reports at once through a pool that cannot serve five. The last
    // one queues, and the whole claim of this stage is that the panel says
    // so rather than drawing it as a slow query.
    await fetch(`${base}/api/reports/burst`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/reports/burst');

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
      findings: Finding[];
      spans: Array<{ kind: string; waitMs: number | null; duration: number }>;
    };

    const waited = detail.spans.filter((span) => span.kind === 'db' && span.waitMs !== null);
    expect(waited.length).toBeGreaterThan(0);

    const finding = detail.findings.find((item) => item.detector === 'pool_wait');
    expect(finding?.costMs).toBeGreaterThan(50);
    expect(finding?.callsite?.relative).toBe('src/shop.js');
    // And the five identical queries are not an N+1: they ran together.
    expect(detail.findings.some((item) => item.detector === 'n_plus_one')).toBe(false);
  });

  it('a charge inside the transaction: one finding, pointing at the call', async () => {
    // The whole chain at once, and the reason this test is here rather than
    // in a unit: the finding needs SQL and an outgoing call to be seen on the
    // same connection, and nothing short of a real driver and a real request
    // puts all three in the same place.
    await fetch(`${base}/api/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: 2 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/pay');

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
      findings: Finding[];
    };
    const held = detail.findings.filter((finding) => finding.detector === 'transaction_hold');

    expect(held).toHaveLength(1);
    expect(held[0]?.evidence).toMatchObject({ kind: 'transaction', closedBy: 'COMMIT' });
    expect(held[0]?.evidence.externalMs as number).toBeGreaterThan(200);
    // The line to change is the call, not the `BEGIN`.
    expect(held[0]?.callsite?.relative).toBe('src/shop.js');
    expect(held[0]?.hint).toContain('Move the call out of the transaction');
  });

  it('the same charge after the COMMIT finds nothing', async () => {
    // The case that must not fire. Same request, same duration, same payment
    // provider — and the connection back in the pool while it answers.
    await fetch(`${base}/api/pay/after`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: 2 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Row[];
    };
    const row = list.requests.find((item) => item.path === '/api/pay/after');

    const detail = (await (await fetch(`${base}/_reqray/api/requests/${row?.id}`)).json()) as {
      findings: Finding[];
    };

    expect(detail.findings.some((finding) => finding.detector === 'transaction_hold')).toBe(false);
  });

  it('groups the exception and shows where it came from', async () => {
    await fetch(`${base}/api/boom`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const payload = (await (await fetch(`${base}/_reqray/api/exceptions`)).json()) as {
      groups: Array<{ type: string; origin: string | null; count: number }>;
    };

    expect(payload.groups[0]).toMatchObject({ type: 'TypeError' });
    expect(payload.groups[0]?.origin).toContain('src/index.js');
  });

  it('serves the panel at its own path', async () => {
    const response = await fetch(`${base}/_reqray/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });
});
