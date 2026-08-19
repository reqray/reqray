/**
 * The panel in a real browser.
 *
 * Typecheck and unit tests cannot tell whether the SPA actually renders — a
 * runtime error in a component would leave a blank page and every other test
 * still green. This drives the built panel against the live demo application
 * and walks the path the design describes: list → detail → SQL tab → replay,
 * plus the exceptions screen and both themes.
 *
 * Uses the locally installed Chrome through `puppeteer-core`, so nothing is
 * downloaded. Skipped — loudly — where no Chrome is present.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = `${exampleRoot}../../`;
const shots = `${repoRoot}docs/screenshots/`;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.warn('loupe: UI tests skipped — Chrome not found. The panel went unverified.');
}

let app: ChildProcess;
let browser: Browser;
let page: Page;
let base: string;
const consoleErrors: string[] = [];

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
      if ((await fetch(url)).ok) return;
    } catch {
      // Still starting: seeding the embedded database takes a moment.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the demo application did not come up');
}

/**
 * Screenshots are written only on request.
 *
 * Otherwise every `pnpm test` would rewrite seven PNGs and leave the tree
 * dirty; the assertions above are what the test is actually for.
 */
const writeScreenshots = process.env['SCREENSHOTS'] === '1';

async function shoot(name: string): Promise<void> {
  if (!writeScreenshots) return;
  // Finite animations (bar growth, entrances, the fresh-row flash) must end
  // first, or the README gets half-grown bars. Infinite ones — the collector
  // pulse — are exempt, otherwise nothing would ever settle.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const timing = animation.effect?.getTiming();
      return timing?.iterations === Infinity || animation.playState === 'finished';
    }),
  );
  // Two frames so the compositor settles: right after a theme flip headless
  // Chrome can capture a stale paint layer (a dark topbar on a light page).
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await page.screenshot({ path: `${shots}${name}.png` });
}

describe.skipIf(!chromePath)('the panel in a browser', () => {
  beforeAll(async () => {
    // Unreachable thanks to `skipIf`, but it is what narrows the type.
    if (!chromePath) throw new Error('Chrome not found');
    if (!existsSync(`${repoRoot}packages/dashboard/dist/index.html`)) {
      execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit', timeout: 600_000 });
    }
    if (writeScreenshots) mkdirSync(shots, { recursive: true });

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = spawn(process.execPath, ['--import', '@loupe/register', 'src/index.js'], {
      cwd: exampleRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    await waitForApp(`${base}/api/orders/eager`, 90_000);

    // Traffic the panel will show: an N+1, its fixed twin, an exception, and
    // two requests whose time is mostly uninstrumented — a timer tail and a
    // stretch of sync CPU between two queries.
    await fetch(`${base}/api/orders`);
    await fetch(`${base}/api/orders/eager`);
    await fetch(`${base}/api/order`);
    await fetch(`${base}/api/boom`);
    await fetch(`${base}/api/report`);
    await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lin@example.com', password: 'correct horse battery' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const { default: puppeteer } = await import('puppeteer-core');
    browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    // Not `networkidle`: the panel holds an SSE connection open for the live
    // feed, so the network is never idle by design.
    await page.goto(`${base}/_loupe/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shell', { timeout: 30_000 });
  }, 700_000);

  afterAll(async () => {
    await browser?.close();
    app?.kill('SIGKILL');
  });

  it('renders the request list with an N+1 flag', async () => {
    await page.waitForSelector('.row');
    const rows = await page.$$eval('.row', (nodes) => nodes.map((node) => node.textContent ?? ''));

    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.some((row) => row.includes('/api/orders') && row.includes('N+1'))).toBe(true);
    // The status bar counts what the buffer holds, not what is on screen.
    expect(await page.$eval('.statusbar', (node) => node.textContent ?? '')).toContain('entries');

    await shoot('01-requests');
  });

  it('filters by chips', async () => {
    const before = await page.$$eval('.row', (nodes) => nodes.length);
    const chips = await page.$$('.chip');
    // `N+1` is the last chip of the duration group.
    await chips[chips.length - 1]?.click();
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length < previous,
      {},
      before,
    );

    expect(await page.$$eval('.row', (nodes) => nodes.length)).toBe(1);

    await chips[chips.length - 4]?.click();
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length === previous,
      {},
      before,
    );
  });

  it('the new-row flash plays once and does not return with filters', async () => {
    const before = await page.$$eval('.row', (nodes) => nodes.length);
    await fetch(`${base}/api/order`);
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length > previous,
      {},
      before,
    );

    // The arrival itself flashes…
    expect(await page.$$eval('.row[data-fresh="true"]', (nodes) => nodes.length)).toBeGreaterThan(
      0,
    );
    // …then the moment passes (the freshness window is 1.5s).
    await new Promise((resolve) => setTimeout(resolve, 1700));

    // POST-only unmounts the fresh GET row; lifting the filter remounts it —
    // the exact path that used to replay the flash on every filter change.
    const chips = await page.$$('.chip');
    await chips[1]?.click();
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length < previous,
      {},
      before + 1,
    );
    await chips[1]?.click();
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length >= previous,
      {},
      before + 1,
    );

    expect(await page.$$eval('.row[data-fresh="true"]', (nodes) => nodes.length)).toBe(0);
  });

  it('sorts on a header click and flips on a second one', async () => {
    const headers = await page.$$('.sort-head');
    const labels = await Promise.all(
      headers.map((header) => header.evaluate((node) => node.textContent ?? '')),
    );
    const durationHeader = headers[labels.findIndex((label) => label.includes('DURATION'))];

    // First click: slowest on top — /api/report and its 600 ms timer.
    await durationHeader?.click();
    await page.waitForFunction(() =>
      (document.querySelector('.row')?.textContent ?? '').includes('/api/report'),
    );

    // Second click flips to ascending: the report sinks off the top.
    await durationHeader?.click();
    await page.waitForFunction(
      () => !(document.querySelector('.row')?.textContent ?? '').includes('/api/report'),
    );

    // TIME restores the default newest-first order for the tests that follow.
    await headers[labels.findIndex((label) => label.includes('TIME'))]?.click();
    await page.waitForFunction(() =>
      (document.querySelector('.sort-head[aria-pressed="true"]')?.textContent ?? '').includes(
        'TIME',
      ),
    );
  });

  it('opens the detail with a waterfall and the N+1 callout', async () => {
    const rows = await page.$$('.row');
    for (const row of rows) {
      const text = await row.evaluate((node) => node.textContent ?? '');
      if (text.includes('N+1')) {
        await row.click();
        break;
      }
    }

    await page.waitForSelector('.callout');
    const callout = await page.$eval('.callout', (node) => node.textContent ?? '');

    expect(callout).toContain('in a loop');
    expect(callout).toContain('src/orders.js:26');
    // The N+1 run collapses into a single bar, as the design specifies.
    expect(await page.$$eval('.wf-span', (nodes) => nodes.length)).toBeLessThan(10);
    expect(await page.$$eval('.badge-nplus', (nodes) => nodes.length)).toBeGreaterThan(0);

    await shoot('02-detail-nplus1');
  });

  it('the permanent link opens the same detail in a new tab', async () => {
    // The previous test left the detail open — its URL is the permanent link.
    const link = page.url();
    expect(link).toContain('#/req/');

    const fresh = await browser.newPage();
    try {
      await fresh.goto(link, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.callout');
      const callout = await fresh.$eval('.callout', (node) => node.textContent ?? '');
      expect(callout).toContain('in a loop');
    } finally {
      await fresh.close();
    }
  });

  it('comparing N+1 and eager by link shows the divergence', async () => {
    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string }>;
    };
    const slow = list.requests.find((row) => row.path === '/api/orders');
    const fast = list.requests.find((row) => row.path === '/api/orders/eager');
    expect(slow && fast).toBeTruthy();

    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_loupe/#/compare/${slow?.id}/${fast?.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await fresh.waitForSelector('.waterfall');
      const text = await fresh.$eval('body', (node) => node.textContent ?? '');

      expect(text).toContain('DIFF BY GROUP');
      expect(text).toContain('line_items');
      // Two waterfalls plus the diff table share the class.
      expect(await fresh.$$eval('.waterfall', (nodes) => nodes.length)).toBeGreaterThanOrEqual(3);
    } finally {
      await fresh.close();
    }
  });

  /** Opens the detail of the latest request for `path` in its own tab. */
  async function openDetail(path: string): Promise<Page> {
    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string }>;
    };
    const row = list.requests.find((item) => item.path === path);
    expect(row, `request ${path} did not reach the panel`).toBeDefined();

    const fresh = await browser.newPage();
    await fresh.goto(`${base}/_loupe/#/req/${row?.id}`, { waitUntil: 'domcontentloaded' });
    await fresh.waitForSelector('.waterfall');
    return fresh;
  }

  it('slow report: the uninstrumented bar answers where the time went', async () => {
    const fresh = await openDetail('/api/report');
    try {
      // The header owns the answer: "2 spans · 604 ms total · 602 ms uninstrumented".
      const head = await fresh.$eval('.waterfall-head', (node) => node.textContent ?? '');
      const gapMs = Number(/([\d,.]+) ms uninstrumented/.exec(head)?.[1]?.replace(',', '') ?? 0);
      expect(gapMs).toBeGreaterThan(400);

      const labels = await fresh.$$eval('.wf-span .wf-label', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      expect(labels.some((label) => label.includes('uninstrumented — app code or waiting'))).toBe(
        true,
      );
    } finally {
      await fresh.close();
    }
  });

  it('registration: the gap sits between the two queries, not at the tail', async () => {
    const fresh = await openDetail('/api/register');
    try {
      const labels = await fresh.$$eval('.wf-span .wf-label', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      const select = labels.findIndex((label) => label.includes('SELECT'));
      const gap = labels.findIndex((label) => label.includes('uninstrumented'));
      const insert = labels.findIndex((label) => label.includes('INSERT'));

      // Bars are sorted by start time: the hashing sits after the email check
      // and before the INSERT — the timeline places it, not just counts it.
      expect(select).toBeGreaterThanOrEqual(0);
      expect(gap).toBeGreaterThan(select);
      expect(insert).toBeGreaterThan(gap);
    } finally {
      await fresh.close();
    }
  });

  it('expands SQL with highlighting and the line of code', async () => {
    // SQL is the default tab — it is what the developer came for.
    expect(await page.$eval('.tabs [aria-selected="true"]', (node) => node.textContent)).toBe(
      'SQL',
    );

    await page.waitForSelector('.sql-row');
    await (await page.$('.sql-row'))?.click();
    await page.waitForSelector('.sql-block');

    expect(await page.$$eval('.tok-keyword', (nodes) => nodes.length)).toBeGreaterThan(0);
    // Two .sql-origin lines now: parameter values (the demo opts into
    // collectSqlValues) and the callsite — both must be there.
    const origins = await page.$$eval('.sql-origin', (nodes) =>
      nodes.map((node) => node.textContent ?? ''),
    );
    expect(origins.some((text) => text.includes('src/orders.js'))).toBe(true);
    expect(origins.some((text) => text.includes('$1 ='))).toBe(true);

    await shoot('03-sql-tab');
  });

  it('replays the request and fills the comparison', async () => {
    await (await page.$('.btn-primary'))?.click();
    await page.waitForSelector('.drawer');
    await shoot('04-replay');

    await (await page.$('.drawer .btn-primary'))?.click();
    await page.waitForFunction(
      () => (document.querySelector('.replay-note')?.textContent ?? '').includes('replayed'),
      { timeout: 20_000 },
    );

    const comparison = await page.$eval('.comparison', (node) => node.textContent ?? '');
    expect(comparison).toContain('sql queries');
    expect(comparison).toContain('detected');

    await shoot('05-replay-comparison');
    await page.keyboard.press('Escape');
  });

  it('shows exception groups with a stack', async () => {
    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav button')];
      (nav.find((button) => button.textContent === 'Exceptions') as HTMLButtonElement)?.click();
    });

    await page.waitForSelector('.exc-row');
    const group = await page.$eval('.exc-row', (node) => node.textContent ?? '');

    expect(group).toContain('TypeError');
    expect(group).toContain('src/index.js');
    // Project frames are highlighted; node_modules frames are not.
    expect(
      await page.$$eval('.frame[data-project="true"]', (nodes) => nodes.length),
    ).toBeGreaterThan(0);

    await shoot('06-exceptions');
  });

  it('switches to the light theme', async () => {
    await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.segmented button')];
      (cells.find((cell) => cell.textContent === 'light') as HTMLButtonElement)?.click();
    });
    await page.waitForFunction(() => document.documentElement.dataset['theme'] === 'light');

    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).not.toBe('rgba(0, 0, 0, 0)');

    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav button')];
      (nav.find((button) => button.textContent === 'Requests') as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.row');
    await shoot('07-light-theme');
  });

  it('writes no console errors over the whole run', () => {
    expect(consoleErrors).toEqual([]);
  });
});
