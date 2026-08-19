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
    await chip('N+1');
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length < previous,
      {},
      before,
    );

    expect(await page.$$eval('.row', (nodes) => nodes.length)).toBe(1);

    await chip('any');
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length === previous,
      {},
      before,
    );
  });

  /** Clicks the filter chip with this exact label. */
  async function chip(label: string): Promise<void> {
    const target = await page.evaluateHandle((wanted: string) => {
      const found = [...document.querySelectorAll('.chip')].find(
        (node) => node.textContent?.trim() === wanted,
      );
      if (!found) throw new Error(`no chip labelled ${wanted}`);
      return found as HTMLElement;
    }, label);
    await (target.asElement() as unknown as { click(): Promise<void> }).click();
  }

  /** Enough traffic that the list scrolls — the banner needs somewhere to hide. */
  async function burst(times: number): Promise<void> {
    const before = await page.$$eval('.row', (nodes) => nodes.length);
    for (let i = 0; i < times; i++) await fetch(`${base}/api/order`);
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length > previous + 1,
      {},
      before,
    );
  }

  /** The selected row's text, once it settles on something other than `from`. */
  async function selectionAfterChange(from: string | null): Promise<string> {
    await page.waitForFunction(
      (previous: string | null) =>
        (document.querySelector('.row[data-selected="true"]')?.textContent ?? null) !== previous,
      {},
      from,
    );
    return page.$eval('.row[data-selected="true"]', (node) => node.textContent ?? '');
  }

  it('j and k move the selection, enter opens it', async () => {
    await page.waitForSelector('.row');

    await page.keyboard.press('j');
    const first = await selectionAfterChange(null);
    await page.keyboard.press('j');
    const second = await selectionAfterChange(first);
    expect(second).not.toBe(first);

    // `k` goes back to where `j` started.
    await page.keyboard.press('k');
    expect(await selectionAfterChange(second)).toBe(first);

    await page.keyboard.press('Enter');
    await page.waitForSelector('.waterfall');
    await page.waitForFunction(() => location.hash.startsWith('#l/req/'));

    // esc leaves the detail without touching the mouse, and the row it opened
    // stays highlighted in the list.
    await page.keyboard.press('Escape');
    await page.waitForSelector('.row[data-selected="true"]');
  });

  it('shortcuts are inert while the filter field has focus', async () => {
    const before = await page.$eval('.row[data-selected="true"]', (node) => node.textContent ?? '');

    try {
      await page.keyboard.press('/');
      await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');

      // In the field, `j` and `k` are letters: they land in the filter rather
      // than walking the list.
      await page.keyboard.type('jk');
      expect(await page.$eval('.search input', (node) => (node as HTMLInputElement).value)).toBe(
        'jk',
      );
    } finally {
      // Always leave the filter empty: the whole suite shares this page, and a
      // stray filter would blank the list for every test after this one.
      // Clearing the way a person does — assigning .value slips past React.
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await page.waitForFunction(() => document.querySelectorAll('.row').length > 1);
    }

    // With the rows back, the selection is where it was: the two keystrokes
    // never reached the list.
    expect(await page.$eval('.row[data-selected="true"]', (node) => node.textContent ?? '')).toBe(
      before,
    );

    // esc hands the keyboard back instead of navigating.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.tagName !== 'INPUT');
  });

  it('the ? panel lists the shortcuts and esc closes it', async () => {
    await page.keyboard.press('?');
    await page.waitForSelector('.keys-panel');
    const text = await page.$eval('.keys-panel', (node) => node.textContent ?? '');

    expect(text).toContain('j / k');
    expect(text).toContain('pause or resume');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.keys-panel') === null);
  });

  it('the banner counts arrivals while scrolled away and takes you back', async () => {
    await burst(40);
    await page.$eval('.rows', (node) => {
      node.scrollTop = 400;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    await fetch(`${base}/api/order`);
    await page.waitForSelector('.new-banner');
    expect(await page.$eval('.new-banner', (node) => node.textContent ?? '')).toContain('new');

    await (await page.$('.new-banner'))?.click();
    await page.waitForFunction(() => (document.querySelector('.rows')?.scrollTop ?? 1) === 0);
    expect(await page.$('.new-banner')).toBeNull();
  });

  it('dragging the timeline narrows the list, reset restores it', async () => {
    const before = await page.$$eval('.row', (nodes) => nodes.length);
    const chart = await page.$('.timeline-chart');
    const box = await chart?.boundingBox();
    if (!box) throw new Error('the timeline did not render');

    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, y, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length < previous,
      {},
      before,
    );
    const narrowed = await page.$$eval('.row', (nodes) => nodes.length);
    expect(narrowed).toBeGreaterThan(0);
    // The label switches from the full range to the window it selected.
    expect(await page.$eval('.timeline-label', (node) => node.textContent ?? '')).toContain(
      'window',
    );

    await (await page.$('.tl-reset'))?.click();
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length === previous,
      {},
      before,
    );
  });

  it('a pinned row stays through a filter that excludes it', async () => {
    // The N+1 row is the one filter chips can single out, so pin its opposite:
    // an ordinary GET that `N+1` would otherwise hide.
    const rows = await page.$$('.row');
    const plain = rows[rows.length - 1];
    const path = await plain?.$eval('.ellipsis', (node) => node.textContent ?? '');
    await plain?.$eval('[data-act="pin"]', (node) => (node as HTMLElement).click());

    await page.waitForSelector('.row [data-act="pin"].s-acc');
    expect(await page.$eval('.statusbar', (node) => node.textContent ?? '')).toContain('pinned: 1');

    try {
      await chip('N+1');
      await page.waitForFunction(
        (previous: number) => document.querySelectorAll('.row').length < previous,
        {},
        rows.length,
      );

      const shown = await page.$$eval('.row .ellipsis', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      // Two rows now: the one the filter matched, and the pinned one.
      expect(shown).toContain('/api/orders');
      expect(shown).toContain(path);
      expect(await page.$eval('.statusbar', (node) => node.textContent ?? '')).toContain(
        'pinned entries exempt',
      );
    } finally {
      await chip('any');
      // Unpin so the rest of the suite sees an ordinary list.
      await page.$eval('.row [data-act="pin"].s-acc', (node) => (node as HTMLElement).click());
      await page.waitForFunction(
        () => document.querySelector('.row [data-act="pin"].s-acc') === null,
      );
    }
  });

  it('shows a findings block with a card per detector', async () => {
    await fetch(`${base}/api/invoice/1`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.row .ellipsis')].some((node) =>
        node.textContent?.includes('/api/invoice/1'),
      ),
    );

    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string }>;
    };
    const invoice = list.requests.find((row) => row.path === '/api/invoice/1');

    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_loupe/#l/req/${invoice?.id}`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.findings');

      expect(await fresh.$eval('.findings-label', (node) => node.textContent ?? '')).toContain(
        'FINDINGS',
      );
      const card = await fresh.$eval('.callout', (node) => node.textContent ?? '');
      expect(card).toContain('identical calls to the same URL');
      expect(card).toContain('src/shop.js');

      // Duplicates badge their own spans rather than collapsing the waterfall
      // into one bar spanning everything between them.
      const labels = await fresh.$$eval('.wf-span .wf-label', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      expect(labels.filter((label) => label.includes('DUP'))).toHaveLength(2);
    } finally {
      await fresh.close();
    }
  });

  it('exports: the collector builds the files, the panel copies the links', async () => {
    // The files themselves are fetched rather than clicked: a download in
    // headless Chrome would land on disk and prove less than the content does.
    const har = (await (await fetch(`${base}/_loupe/api/export/har`)).json()) as {
      log: { entries: Array<{ request: { method: string }; _loupe: unknown }> };
    };
    expect(har.log.entries.length).toBeGreaterThan(3);
    expect(har.log.entries[0]?._loupe).toMatchObject({ sqlQueries: expect.any(Number) });

    const script = await (await fetch(`${base}/_loupe/api/export/curl`)).text();
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('curl -i -X GET');

    // The menu itself, and the toast it raises.
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.export button')];
      (buttons[0] as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.export-menu', { visible: true });
    const items = await page.$$eval('.export-item', (nodes) =>
      nodes.map((node) => node.textContent ?? ''),
    );
    expect(items).toHaveLength(4);
    expect(items.some((item) => item.includes('Deep link'))).toBe(true);

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('.export-item')];
      (items.find((node) => node.textContent?.includes('Deep link')) as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.toast', { visible: true });
    expect(await page.$eval('.toast', (node) => node.textContent ?? '')).toContain('Deep link');
    await page.waitForFunction(() => document.querySelector('.toast') === null, {
      timeout: 6_000,
    });
  });

  it('switches the waterfall for a flamegraph and back', async () => {
    const list = (await (await fetch(`${base}/_loupe/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string }>;
    };
    const orders = list.requests.find((row) => row.path === '/api/orders');

    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_loupe/#l/req/${orders?.id}`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.waterfall');

      await fresh.evaluate(() => {
        const cells = [...document.querySelectorAll('.view-toggle button')];
        (cells.find((cell) => cell.textContent === 'flamegraph') as HTMLButtonElement)?.click();
      });
      await fresh.waitForSelector('.flame-block', { visible: true });

      // Every span is a block, and the graph is as deep as the nesting.
      const blocks = await fresh.$$eval('.flame-block', (nodes) => nodes.length);
      expect(blocks).toBeGreaterThan(1);
      expect(await fresh.$eval('.flame-legend', (node) => node.textContent ?? '')).toContain('sql');

      await fresh.evaluate(() => {
        const cells = [...document.querySelectorAll('.view-toggle button')];
        (cells.find((cell) => cell.textContent === 'waterfall') as HTMLButtonElement)?.click();
      });
      await fresh.waitForSelector('.wf-span');
    } finally {
      await fresh.close();
    }
  });

  it('the routes screen ranks endpoints and filters the list', async () => {
    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav button')];
      (nav.find((button) => button.textContent === 'Routes') as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.routes-row');

    const head = await page.$eval('.routes-head', (node) => node.textContent ?? '');
    expect(head).toContain('routes');
    expect(head).toContain('samples');

    // Variable segments collapse: /api/external/inventory/3 and /…/153 are
    // one route, not two.
    const routes = await page.$$eval('.routes-row .ellipsis', (nodes) =>
      nodes.map((node) => node.textContent ?? ''),
    );
    expect(routes.some((route) => route.includes('/api/orders'))).toBe(true);
    expect(routes.every((route) => !/\/\d+$/.test(route.trim()))).toBe(true);

    // Sorting by calls puts the most-hit route on top.
    await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.routes-header .sort-head')];
      (heads.find((node) => node.textContent?.startsWith('CALLS')) as HTMLButtonElement)?.click();
    });
    await page.waitForFunction(
      () => document.querySelector('.routes-header .sort-head[aria-pressed="true"]') !== null,
    );

    // Clicking a row filters the request list down to that route.
    await (await page.$('.routes-row'))?.click();
    await page.waitForSelector('.route-filter');
    const paths = await page.$$eval('.row .ellipsis', (nodes) =>
      nodes.map((node) => node.textContent ?? ''),
    );
    expect(new Set(paths.map((path) => path.replace(/\d+/g, ':id'))).size).toBe(1);

    await (await page.$('.route-filter'))?.click();
    await page.waitForFunction(() => document.querySelector('.route-filter') === null);
  });

  it('highlight rules tint rows, and switching one off untints them', async () => {
    // /api/boom is a 500, which the "status ≥ 500" rule owns by default.
    await page.waitForSelector('.row[data-rule="server_error"]');

    await (await page.$('.rules .chip'))?.click();
    // `visible` matters: the popover once rendered inside an overflow
    // container, present in the DOM and clipped out of sight.
    await page.waitForSelector('.rules-pop', { visible: true });
    expect(await page.$eval('.rules-pop', (node) => node.textContent ?? '')).toContain(
      'first matching rule tints the row',
    );

    const rows = await page.$$('.rules-row');
    // Second rule in evaluation order: `status ≥ 500`.
    await rows[1]?.click();
    await page.waitForFunction(
      () => document.querySelector('.row[data-rule="server_error"]') === null,
    );

    await rows[1]?.click();
    await page.waitForSelector('.row[data-rule="server_error"]');
    await (await page.$('.rules .chip'))?.click();
    await page.waitForFunction(() => document.querySelector('.rules-pop') === null);
  });

  it('marks requests a test issued, and filters down to them', async () => {
    const name = 'orders.spec.ts:42 › creates an order';
    const before = await page.$$eval('.row', (nodes) => nodes.length);
    await fetch(`${base}/api/order`, {
      headers: { 'x-loupe-test': encodeURIComponent(name) },
    });
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length > previous,
      {},
      before,
    );

    await page.waitForSelector('.test-mark');

    try {
      await chip('tests');
      await page.waitForFunction(() => document.querySelectorAll('.row').length === 1);

      // Opening it shows who issued it, spelled out.
      await (await page.$('.row'))?.click();
      await page.waitForSelector('.test-strip');
      expect(await page.$eval('.test-strip', (node) => node.textContent ?? '')).toContain(name);

      await page.keyboard.press('Escape');
      await page.waitForSelector('.row');
    } finally {
      await chip('any');
      await page.waitForFunction(
        (previous: number) => document.querySelectorAll('.row').length > previous,
        {},
        before,
      );
    }
  });

  it('picking two requests offers the comparison', async () => {
    const rows = await page.$$('.row');
    await rows[0]?.$eval('[data-act="cmp"]', (node) => (node as HTMLElement).click());
    await page.waitForSelector('.cmp-bar');
    expect(await page.$eval('.cmp-bar', (node) => node.textContent ?? '')).toContain('1 selected');

    await rows[1]?.$eval('[data-act="cmp"]', (node) => (node as HTMLElement).click());
    await page.waitForFunction(() =>
      (document.querySelector('.cmp-bar')?.textContent ?? '').includes('↔'),
    );

    await page.$eval('.cmp-bar .btn-primary', (node) => (node as HTMLElement).click());
    await page.waitForFunction(() => location.hash.startsWith('#l/cmp/'));
    await page.waitForSelector('.waterfall');

    await page.keyboard.press('Escape');
    await page.waitForSelector('.row');
    await page.$eval('.cmp-bar .btn-secondary', (node) => (node as HTMLElement).click());
    await page.waitForFunction(() => document.querySelector('.cmp-bar') === null);
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
    await chip('POST');
    await page.waitForFunction(
      (previous: number) => document.querySelectorAll('.row').length < previous,
      {},
      before + 1,
    );
    await chip('POST');
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

    // First click: slowest on top — /api/report and its long timer.
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
    expect(link).toContain('#l/req/');

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

  it('links written in the original hash scheme still open', async () => {
    // Those links are already in chat threads and issue trackers.
    const id = page.url().split('#l/req/')[1];
    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_loupe/#/req/${id}`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.callout');

      expect(await fresh.$eval('.callout', (node) => node.textContent ?? '')).toContain(
        'in a loop',
      );
      // …and the panel rewrites them to the scheme it speaks now.
      expect(fresh.url()).toContain('#l/req/');
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

      expect(text).toContain('METRICS');
      expect(text).toContain('SPAN BY SPAN');
      expect(text).toContain('line_items');

      // The metrics table states the facts, and the verdict states the point.
      const metrics = await fresh.$$eval('.metrics-row', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      expect(metrics.some((row) => row.includes('sql queries'))).toBe(true);
      const verdict = await fresh.$eval('.verdict', (node) => node.textContent ?? '');
      expect(verdict).toMatch(/faster by \d+ ms/);
      expect(verdict).toContain('N+1');

      // Swapping turns the comparison around.
      await fresh.evaluate(() => {
        const buttons = [...document.querySelectorAll('.detail-head button')];
        (buttons.find((b) => b.textContent?.includes('swap')) as HTMLButtonElement)?.click();
      });
      await fresh.waitForFunction(
        (before: string) => (document.querySelector('.verdict')?.textContent ?? '') !== before,
        {},
        verdict,
      );
      expect(await fresh.$eval('.verdict', (node) => node.textContent ?? '')).not.toBe(verdict);
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
      // The header owns the answer: "2 spans · 854 ms total · 852 ms uninstrumented".
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
