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
  console.warn('reqray: UI tests skipped — Chrome not found. The panel went unverified.');
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

async function shoot(name: string, target: Page = page): Promise<void> {
  if (!writeScreenshots) return;
  // A toast from an earlier test is still on screen for a few seconds, and it
  // lands across the bottom of whatever is being photographed. Bounded: a
  // toast that never leaves must not hold the suite.
  await target
    .waitForFunction(() => document.querySelector('.toast') === null, { timeout: 6_000 })
    .catch(() => undefined);
  // Finite animations (bar growth, entrances, the fresh-row flash) must end
  // first, or the README gets half-grown bars. Infinite ones — the collector
  // pulse — are exempt, otherwise nothing would ever settle.
  await target.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const timing = animation.effect?.getTiming();
      return timing?.iterations === Infinity || animation.playState === 'finished';
    }),
  );
  // Two frames so the compositor settles: right after a theme flip headless
  // Chrome can capture a stale paint layer (a dark topbar on a light page).
  await target.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await target.screenshot({ path: `${shots}${name}.png` });
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
    app = spawn(process.execPath, ['--import', '@reqray/register', 'src/index.js'], {
      cwd: exampleRoot,
      env: { ...process.env, PORT: String(port), DEMO_TRAFFIC: 'off' },
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
    // Megabytes of JSON out of one fast query — the mistake the waterfall
    // has nothing to show for. The body has to be drained: `fetch` resolves
    // on the headers, and four megabytes are still on the wire after it does,
    // so the request would not be recorded until well after this line.
    await (await fetch(`${base}/api/export`)).arrayBuffer();
    await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lin@example.com', password: 'correct horse battery' }),
    });
    // Twice: the first call fills the cache, the second is the warm one the
    // panel shows — two hits of one key, one of them redundant.
    await fetch(`${base}/api/profile/1`);
    await fetch(`${base}/api/profile/1`);
    // A charge with the transaction still open, and five reports at once on a
    // pool that cannot serve five: a held transaction and a wait for a connection.
    await fetch(`${base}/api/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: 2 }),
    });
    await fetch(`${base}/api/reports/burst`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const { default: puppeteer } = await import('puppeteer-core');
    browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
    // Under the test timeout, not over it: a wait that never comes true then
    // fails on its own line, instead of the whole test timing out at its first.
    browser.on('targetcreated', (target) => {
      void target.page().then((created) => created?.setDefaultTimeout(15_000));
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    // Not `networkidle`: the panel holds an SSE connection open for the live
    // feed, so the network is never idle by design.
    await page.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
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

  it('the timeline says what is under the pointer, and when', async () => {
    // A strip that answers "how many, and when" without a click is the point
    // of drawing it; before this it could only say that something happened.
    const chart = await page.$('.timeline-chart');
    const box = await chart?.boundingBox();
    if (!box) throw new Error('the timeline did not render');

    // The axis it never had.
    const axis = await page.$$eval('.timeline-axis span', (nodes) =>
      nodes.map((node) => node.textContent ?? ''),
    );
    expect(axis.length).toBeGreaterThan(2);
    expect(axis.every((label) => /^\d{1,2}[ :]/.test(label))).toBe(true);

    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
    await page.waitForFunction(() =>
      /request/.test(document.querySelector('.timeline-label')?.textContent ?? ''),
    );
    const readout = await page.$eval('.timeline-label', (node) => node.textContent ?? '');
    expect(readout).toMatch(/\d+ requests?|1 request/);
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

    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string }>;
    };
    const invoice = list.requests.find((row) => row.path === '/api/invoice/1');

    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_reqray/#l/req/${invoice?.id}`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.findings');

      expect(await fresh.$eval('.findings-label', (node) => node.textContent ?? '')).toContain(
        'THE FIX',
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
    const har = (await (await fetch(`${base}/_reqray/api/export/har`)).json()) as {
      log: { entries: Array<{ request: { method: string }; _reqray: unknown }> };
    };
    expect(har.log.entries.length).toBeGreaterThan(3);
    expect(har.log.entries[0]?._reqray).toMatchObject({ sqlQueries: expect.any(Number) });

    const script = await (await fetch(`${base}/_reqray/api/export/curl`)).text();
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
    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string }>;
    };
    const orders = list.requests.find((row) => row.path === '/api/orders');

    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_reqray/#l/req/${orders?.id}`, { waitUntil: 'domcontentloaded' });
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

    // Clicking a row opens its charts; the list filter moved into them,
    // because opening a route to look at it is the commoner gesture than
    // being teleported to a filtered list.
    await (await page.$('.routes-row'))?.click();
    // The button arrives with the charts, which are fetched: the panel shows
    // "reading this route's history…" until they land.
    await page.waitForSelector('.route-charts-head .btn-secondary');
    await (await page.$('.route-charts-head .btn-secondary'))?.click();
    await page.waitForSelector('.route-filter');
    const paths = await page.$$eval('.row .ellipsis', (nodes) =>
      // A collapsed burst adds its note to the path cell; the question here
      // is path purity, so the note is stripped before judging.
      nodes.map((node) => (node.textContent ?? '').replace(' · identical calls · expand', '')),
    );
    expect(new Set(paths.map((path) => path.replace(/\d+/g, ':id'))).size).toBe(1);

    await (await page.$('.route-filter'))?.click();
    await page.waitForFunction(() => document.querySelector('.route-filter') === null);
  });

  it('routes name what fired on them, and the shape of their traffic', async () => {
    await page.goto(`${base}/_reqray/#l/routes`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.routes-row');

    // The column that is the reason to visit: a detector badge on the route
    // that has one, and nothing on the routes that do not.
    await page.waitForSelector('.route-findings .badge-nplus');
    const flagged = await page.$$eval('.routes-row', (rows) =>
      rows
        .filter((row) => row.querySelector('.route-findings .badge-nplus'))
        .map((row) => row.querySelector('.ellipsis')?.textContent ?? ''),
    );
    expect(flagged.some((label) => label.includes('/api/orders'))).toBe(true);

    // Every row draws the same ten columns of the same window.
    const bars = await page.$$eval('.routes-row .trend', (nodes) =>
      nodes.map((node) => node.querySelectorAll('.trend-bar').length),
    );
    expect(bars.length).toBeGreaterThan(0);
    expect(new Set(bars)).toEqual(new Set([10]));

    // Sorting by FINDINGS puts what costs the most on top.
    await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.routes-header .sort-head')];
      (heads.find((node) => node.textContent?.startsWith('FINDINGS')) as HTMLButtonElement).click();
    });
    await page.waitForFunction(
      () =>
        document.querySelector('.routes-row')?.querySelector('.route-findings .badge-nplus') !==
        null,
    );

    // Opening a route says what is already known about it, with the line of
    // code — beside the charts, in the row's own place, never over the rows.
    await page.evaluate(() => {
      (document.querySelector('.routes-row') as HTMLButtonElement).click();
    });
    await page.waitForSelector('.route-top-finding');
    const known = await page.$eval('.route-top-finding', (node) => node.textContent ?? '');
    expect(known).toMatch(/src\/\w+\.js:\d+/);

    await shoot('17-routes');

    // The expansion sits between its row and the next one rather than over
    // them: the row above it is still the route it belongs to. Measured after
    // the entrance settles — mid-animation the panel is four pixels above
    // where it lives, and geometry read then is geometry of a moment.
    await page.waitForFunction(() =>
      // The collector's pulse never finishes, and never moves anything.
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.effect?.getTiming().iterations === Infinity ||
            animation.playState === 'finished',
        ),
    );
    const inPlace = await page.evaluate(() => {
      const panel = document.querySelector('.route-charts')?.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.routes-row')].map((row) =>
        row.getBoundingClientRect(),
      );
      const owner = rows[0];
      const next = rows[1];
      if (!panel || !owner) return false;
      return panel.top >= owner.bottom - 1 && (!next || next.top >= panel.bottom - 1);
    });
    expect(inPlace).toBe(true);

    await page.evaluate(() => {
      (document.querySelector('.routes-row') as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => document.querySelector('.route-charts') === null);
  });

  it('draws three charts for one route, and answers what ran in a moment', async () => {
    // A route with one call spans no time, and a drag across no time is not a
    // zoom. Twelve calls spread over a couple of seconds give the charts a
    // window to be narrowed.
    for (let index = 0; index < 8; index++) {
      await fetch(`${base}/api/order`);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav button')];
      (nav.find((button) => button.textContent === 'Routes') as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.routes-row');
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.routes-row')];
      // The route cell, not the whole row: the row's text runs the numbers
      // straight on to the path, so `/api/order` matches `/api/orders` too.
      const wanted = rows.find(
        (row) => (row.querySelector('.ellipsis')?.textContent ?? '').trim() === 'GET /api/order',
      );
      (wanted ?? rows[0])?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForSelector('.chart-svg');

    const titles = await page.$$eval('.chart .label', (nodes) =>
      nodes.map((node) => node.textContent ?? ''),
    );
    expect(titles).toEqual(['LATENCY', 'ERRORS', 'THROUGHPUT']);

    // The chart covers the stretch the table above it was computed over: two
    // windows on one screen is two answers to one question.
    const head = await page.$eval('.route-charts-head', (node) => node.textContent ?? '');
    expect(head).toMatch(/per column/);

    // Every column is clickable, because a chart nobody can click is
    // decoration — and the answer is either a list or a sentence saying there
    // is nothing to list.
    // The plot is one control, and the column is resolved from where the
    // click landed: forty-eight hit targets on each of three charts would be
    // a hundred and forty-four tab stops for a keyboard user.
    const plot = await page.$('.chart-plot');
    const box = await plot?.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('.what-ran');
    await page.waitForFunction(
      () => !(document.querySelector('.what-ran')?.textContent ?? '').includes('asking'),
    );

    const answer = await page.$eval('.what-ran', (node) => node.textContent ?? '');
    expect(answer).toContain('WHAT RAN HERE');
    // Either routes that strayed from their own baseline, or the sentence
    // that admits none did.
    const listed = await page.$$eval('.outlier', (nodes) => nodes.length);
    // Three sentences are possible when the list is empty, and each is an
    // answer: nothing was unusual, everything rose together, or nothing ran
    // in this stretch at all.
    if (listed === 0) {
      expect(answer).toMatch(/Nothing here was unusual|rose across the board|Nothing ran here/);
    }

    // A long window cannot be read by aiming at one of forty-eight columns,
    // so a drag across the plot narrows what is drawn.
    const chartsHead = () => page.$eval('.route-charts-head', (node) => node.textContent ?? '');
    const beforeZoom = await chartsHead();
    const zoomPlot = await page.$('.chart-plot');
    const zoomBox = await zoomPlot?.boundingBox();
    if (zoomBox) {
      const y = zoomBox.y + zoomBox.height / 2;
      await page.mouse.move(zoomBox.x + zoomBox.width * 0.3, y);
      await page.mouse.down();
      await page.mouse.move(zoomBox.x + zoomBox.width * 0.6, y, { steps: 10 });
      await page.mouse.up();
    }
    await page.waitForFunction(() =>
      (document.querySelector('.route-charts-head')?.textContent ?? '').includes('zoomed in'),
    );
    expect(await chartsHead()).not.toBe(beforeZoom);

    // And the way back out is one click, not a reload.
    //
    // Dispatched rather than clicked at a coordinate: the head re-renders
    // when the zoomed range lands, the button shifts as the text beside it
    // changes width, and a click aimed at where it used to be hits the
    // sentence next to it.
    await page.evaluate(() => {
      document
        .querySelector('.route-charts-head .tl-scope')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForFunction(
      () =>
        !(document.querySelector('.route-charts-head')?.textContent ?? '').includes('zoomed in'),
    );

    // Back to Requests for the tests that follow.
    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav button')];
      (nav.find((button) => button.textContent === 'Requests') as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.row');
  }, 20_000);

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
      headers: { 'x-reqray-test': encodeURIComponent(name) },
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

    // Which request is actually the slowest is the store's answer, not this
    // test's assumption: asking it means the assertion is that the panel and
    // the collector agree, which is the thing worth checking.
    const slowest = (await (
      await fetch(`${base}/_reqray/api/requests?sort=slowest&limit=1`)
    ).json()) as { requests: Array<{ path: string }> };
    const top = slowest.requests[0]?.path ?? '';
    expect(top).not.toBe('');

    // First click: slowest on top.
    await durationHeader?.click();
    await page.waitForFunction(
      (path) => (document.querySelector('.row')?.textContent ?? '').includes(path),
      {},
      top,
    );

    // Second click flips to ascending: it sinks off the top.
    await durationHeader?.click();
    await page.waitForFunction(
      (path) => !(document.querySelector('.row')?.textContent ?? '').includes(path),
      {},
      top,
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
      await fresh.goto(`${base}/_reqray/#/req/${id}`, { waitUntil: 'domcontentloaded' });
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
    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string }>;
    };
    const slow = list.requests.find((row) => row.path === '/api/orders');
    const fast = list.requests.find((row) => row.path === '/api/orders/eager');
    expect(slow && fast).toBeTruthy();

    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_reqray/#/compare/${slow?.id}/${fast?.id}`, {
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
    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string }>;
    };
    const row = list.requests.find((item) => item.path === path);
    expect(row, `request ${path} did not reach the panel`).toBeDefined();

    const fresh = await browser.newPage();
    await fresh.goto(`${base}/_reqray/#/req/${row?.id}`, { waitUntil: 'domcontentloaded' });
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

  it('stacks the strips on a detail instead of stretching one of them', async () => {
    // The layout used to pin three grid rows — header, one strip, the body —
    // so every strip added above the body pushed another into the row that
    // takes the rest of the screen. A single line of text then floated in the
    // middle of four hundred empty pixels, which looks like a broken page and
    // was one.
    const fresh = await openDetail('/api/orders');
    try {
      const heights = await fresh.evaluate(() => {
        const height = (selector: string) =>
          Math.round(document.querySelector(selector)?.getBoundingClientRect().height ?? 0);
        return { head: height('.detail-head'), strip: height('.breakdown') };
      });

      expect(heights.head).toBeLessThan(60);
      // A strip is one line of text and its padding, whatever else is on the
      // screen beside it.
      expect(heights.strip).toBeGreaterThan(0);
      expect(heights.strip).toBeLessThan(60);
    } finally {
      await fresh.close();
    }
  });

  it('the header says where the time went, and how this call compares', async () => {
    // A verdict needs a history to be drawn from, and the setup calls this
    // endpoint once. Three more, so the store has something to compare
    // against — which is the rule the card is built on.
    for (let index = 0; index < 3; index++) await fetch(`${base}/api/orders`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The N+1 endpoint: most of its time is in the database, and the strip
    // has to say so in the same words the finding below it uses.
    const fresh = await openDetail('/api/orders');
    try {
      const split = await fresh.$eval('.split-bar', (node) => node.getAttribute('aria-label'));
      expect(split).toContain('sql');
      expect(split).toContain('your code');
      expect(await fresh.$$eval('.split-seg', (nodes) => nodes.length)).toBeGreaterThanOrEqual(2);

      // The verdict is drawn from the route's own history, and the traffic
      // this suite generates is more than enough of it to be asked.
      await fresh.waitForSelector('.verdict');
      const verdict = await fresh.$eval('.verdict', (node) => node.textContent ?? '');
      expect(verdict).toMatch(/calls to \/api\/orders/);
    } finally {
      await fresh.close();
    }
  });

  it('the fix comes first, with a diff it stands behind, and the rail beside it', async () => {
    // Fresh calls, so the route has neighbours in time and a baseline to be
    // judged against even when this test runs alone.
    for (let index = 0; index < 3; index++) await fetch(`${base}/api/orders`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // A *flagged* call, not the newest: on a warm pool the loop can cost
    // less than the detector's own floor, and its silence there is correct.
    const list = (await (await fetch(`${base}/_reqray/api/requests`)).json()) as {
      requests: Array<{ id: string; path: string; findingCount: number }>;
    };
    const flagged = list.requests.find((row) => row.path === '/api/orders' && row.findingCount > 0);
    expect(flagged, 'no flagged /api/orders reached the panel').toBeDefined();

    const fresh = await browser.newPage();
    try {
      await fresh.setViewport({ width: 1440, height: 900 });
      await fresh.goto(`${base}/_reqray/#l/req/${flagged?.id}`, {
        waitUntil: 'domcontentloaded',
      });
      // Fix first: the card leads the main column, before the waterfall.
      await fresh.waitForSelector('.fix-card');
      const card = await fresh.$eval('.fix-card', (node) => node.textContent ?? '');
      expect(card).toContain('identical queries ran in a loop');
      expect(card).toContain('recoverable');

      // The statement fits the pg template, so the diff is offered: the same
      // SELECT with the trailing equality folded into ANY.
      const added = await fresh.$eval('.fix-add', (node) => node.textContent ?? '');
      expect(added).toContain('ANY($1)');
      expect(await fresh.$eval('.fix-diff-head', (node) => node.textContent ?? '')).toContain(
        '1 query instead of',
      );

      await shoot('16-fix-first', fresh);

      // "show the calls" lands on the statement in the SQL tab, expanded.
      await fresh.evaluate(() => {
        const buttons = [...document.querySelectorAll('.fix-actions button')];
        (
          buttons.find((node) => node.textContent?.startsWith('show the')) as HTMLButtonElement
        ).click();
      });
      await fresh.waitForSelector('.sql-open');

      // The rail: this call marked against the route's own distribution…
      await fresh.waitForSelector('.detail-rail .vs-marker');
      expect(await fresh.$eval('.detail-rail', (node) => node.textContent ?? '')).toContain(
        'NEARBY IN TIME',
      );

      // …and the neighbours are doors: one click is another request.
      await fresh.waitForSelector('.nearby-row');
      const before = await fresh.evaluate(() => window.location.hash);
      await fresh.evaluate(() => {
        (document.querySelector('.nearby-row') as HTMLButtonElement).click();
      });
      await fresh.waitForFunction(
        (previous: string) => window.location.hash !== previous,
        {},
        before,
      );
      await fresh.waitForSelector('.detail-head');
    } finally {
      await fresh.close();
    }
  });

  it('ranks the spans by the time they spent in their own code', async () => {
    const fresh = await openDetail('/api/orders');
    try {
      await fresh.waitForSelector('.selftime-table');
      const number = (text: string) => Number.parseFloat(text.replace(/[^\d.]/g, ''));
      const rows = await fresh.$$eval('.selftime-table tbody tr', (nodes) =>
        nodes.map((node) => ({
          name: node.querySelector('.selftime-name')?.textContent ?? '',
          self: node.querySelector('td:nth-child(3)')?.textContent ?? '',
          total: node.querySelector('td:nth-child(4)')?.textContent ?? '',
        })),
      );
      expect(rows.length).toBeGreaterThan(1);

      // Sorted by self, descending — the ranking the table exists for.
      const selves = rows.map((row) => number(row.self));
      expect([...selves].sort((a, b) => b - a)).toEqual(selves);

      // And the handler's own time is a fraction of its duration: it holds
      // the whole request and spent most of it waiting. A column showing the
      // same two numbers would be the total wearing a different heading.
      const handler = rows.find((row) => row.name.includes('GET /api/orders'));
      expect(handler, 'the handler is on the list').toBeDefined();
      expect(number(handler?.self ?? '0')).toBeLessThan(number(handler?.total ?? '0'));
    } finally {
      await fresh.close();
    }
  });

  it('an export says how much it moved, and which query it came out of', async () => {
    const fresh = await openDetail('/api/export');
    try {
      const strip = await fresh.$eval('.breakdown', (node) => node.textContent ?? '');
      expect(strip).toMatch(/MB out/);
      expect(strip).toMatch(/rows/);

      const callouts = await fresh.$$eval('.callout', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      const heavy = callouts.find((text) => text.includes('HEAVY'));
      expect(heavy, 'the heavy-response finding').toBeDefined();
      // What it costs is bytes and rows, not milliseconds: a response's time
      // on somebody's phone is not something this process measured.
      expect(heavy).toMatch(/MB/);
      expect(heavy).not.toContain('recoverable');
      // And it names the query the rows came out of.
      expect(heavy).toContain('generate_series');
    } finally {
      await fresh.close();
    }
  });

  it('registration: says the loop was blocked, and whose doing it was not', async () => {
    // Hashing a password is synchronous and holds the loop for the length of
    // it. Nothing in the waterfall can show that — every span is fast and the
    // time is between them — which is the entire reason this number exists.
    const fresh = await openDetail('/api/register');
    try {
      const strip = await fresh.$eval('.breakdown', (node) => node.textContent ?? '');
      expect(strip).toContain('loop behind');

      const note = await fresh.$eval(
        '.breakdown-note.s-warn',
        (node) => node.getAttribute('title') ?? '',
      );
      // Said as a property of the process. Under load the code that blocked
      // the loop is usually somebody else's, and a panel that reads "this
      // request burned 270 ms of CPU" would be wrong often enough to make
      // every other number on the screen suspect.
      expect(note).toContain('the process, not this request');
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

  it('the cache tab shows the keys, the hits and the read made twice', async () => {
    const fresh = await openDetail('/api/profile/1');
    try {
      const cacheTab = await fresh.$$eval('.tabs button', (nodes) =>
        nodes.findIndex((node) => node.textContent === 'Cache'),
      );
      const buttons = await fresh.$$('.tabs button');
      await buttons[cacheTab]?.click();
      await fresh.waitForSelector('.cache-row');

      const rows = await fresh.$$eval('.cache-row:not(.label)', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      // The command is the driver's own, not a category: a reader who knows
      // Redis recognises the call.
      expect(rows[0]).toContain('GET');
      expect(rows[0]).toContain('user:1');
      expect(rows[0]).toContain('HIT');
      expect(rows.some((row) => row.includes('INCR'))).toBe(true);

      // The duplicate is marked where it happened, and explained above.
      expect(await fresh.$$eval('.dup-mark', (nodes) => nodes.length)).toBe(2);
      const findings = await fresh.$$eval('.callout', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      expect(findings.some((card) => card.includes('reads of the same cache key'))).toBe(true);

      await shoot('08-cache-tab', fresh);
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

  it('blames the project frames and opens them in an editor', async () => {
    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav button')];
      (nav.find((button) => button.textContent === 'Exceptions') as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.frame');

    // The summary counts what is worth reading in the stack.
    const head = await page.$eval('.exc-stack-head', (node) => node.textContent ?? '');
    expect(head).toMatch(/\d+ of \d+ frames in project code/);

    // The demo runs inside this repository, so blame has something to say —
    // and where it has nothing, the column shows a dash rather than blank.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.frame[data-project="true"] .frame-blame')].some(
          (node) => (node.textContent ?? '').length > 0,
        ),
      { timeout: 15_000 },
    );

    // node_modules frames are not click targets.
    const plain = await page.$('.frame[data-project="false"]');
    expect(await plain?.evaluate((node) => node.tagName)).toBe('DIV');

    const project = await page.$('.frame[data-clickable="true"]');
    expect(await project?.evaluate((node) => node.tagName)).toBe('BUTTON');
    await project?.click();
    await page.waitForSelector('.toast', { visible: true });
    expect(await page.$eval('.toast', (node) => node.textContent ?? '')).toContain('editor');
  });

  it('identical simultaneous calls collapse into one row, and the bar scales', async () => {
    // Six identical parallel calls: a burst by construction.
    await Promise.all(Array.from({ length: 6 }, () => fetch(`${base}/api/order`)));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
      // The setting may have been left off by another test; this one is
      // about the grouping, so it turns it on explicitly.
      await fresh.evaluate(() => localStorage.setItem('reqray.bursts', 'on'));
      await fresh.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });

      // The collapsed head: a multiplier tag, the note, the average.
      await fresh.waitForSelector('.burst-tag');
      expect(await fresh.$eval('.burst-tag', (node) => node.textContent ?? '')).toMatch(/^\d+×$/);

      // Magnitude encoding is on the same screen: duration bars everywhere,
      // and a severity gutter on the flagged rows the demo always has.
      await fresh.waitForSelector('.dur-fill');
      await fresh.waitForSelector('.row-gutter[data-grade]');

      // Expanding shows the members in place; the strip collapses them back.
      await fresh.evaluate(() => {
        const tag = document.querySelector('.burst-tag');
        (tag?.closest('.row') as HTMLButtonElement | null)?.click();
      });
      await fresh.waitForSelector('.burst-strip');
      await fresh.evaluate(() => {
        (document.querySelector('.burst-strip') as HTMLButtonElement).click();
      });
      await fresh.waitForFunction(() => document.querySelector('.burst-strip') === null);

      // The status bar's numbers are doors: errors applies the 5xx filter,
      // and clicking it again takes it off.
      const errorsLink = () =>
        fresh.evaluate(() => {
          const links = [...document.querySelectorAll('.statusbar .sb-link')];
          (
            links.find((node) => node.textContent?.startsWith('errors')) as HTMLButtonElement
          ).click();
        });
      await errorsLink();
      await fresh.waitForFunction(() => {
        const chip = [...document.querySelectorAll('.filter-chips .chip')].find(
          (node) => node.textContent === '5xx',
        );
        return chip?.getAttribute('aria-pressed') === 'true';
      });
      await errorsLink();
      await fresh.waitForFunction(() => {
        const chip = [...document.querySelectorAll('.filter-chips .chip')].find(
          (node) => node.textContent === '5xx',
        );
        return chip?.getAttribute('aria-pressed') === 'false';
      });
    } finally {
      await fresh.close();
    }
  });

  it('the search speaks tokens, a view keeps the question, and ⌘K runs it', async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.setViewport({ width: 1440, height: 900 });
      await fresh.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.row');

      // React owns the input, so typing goes through the native setter and
      // an input event — the same value path a keyboard takes.
      const type = (value: string) =>
        fresh.evaluate((text: string) => {
          const input = document.querySelector('.search input') as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);

      // status:5xx narrows to the one route that fails.
      await type('status:5xx');
      await fresh.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.row')];
        return rows.length > 0 && rows.every((row) => row.textContent?.includes('/api/boom'));
      });

      // sql>100 finds the N+1 and nothing else.
      await type('sql>100');
      await fresh.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.row .ellipsis')];
        return rows.length > 0 && rows.every((row) => row.textContent?.startsWith('/api/orders'));
      });

      // has:code finds the request whose time is in the application rather
      // than in the database. It outranks the budget finding on the same row:
      // "852 ms in your own code, at shop.js:308" is the more useful of the
      // two things true about that request.
      await type('has:code');
      await fresh.waitForFunction(() => {
        const paths = [...document.querySelectorAll('.row .ellipsis')].map(
          (row) => row.textContent ?? '',
        );
        // The report, whose heavy part is everything after the query, and the
        // registration, which hashes a password synchronously: the demo's
        // deliberate "the time is not in the database" routes. Not "these two
        // and nothing else" — on a slow machine serializing the export takes
        // a tenth of a second too, and the detector is right to say so. What
        // must not be here is a request that spent no time anywhere.
        return (
          paths.includes('/api/report') &&
          paths.includes('/api/register') &&
          !paths.includes('/api/boom')
        );
      });

      // A view keeps the whole question under a name…
      await type('status:5xx');
      await fresh.evaluate(() => {
        (document.querySelector('.views .chip') as HTMLButtonElement).click();
      });
      await fresh.waitForSelector('.views-save input');
      await fresh.evaluate(() => {
        const input = document.querySelector('.views-save input') as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'just the failures');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await fresh.evaluate(() => {
        (document.querySelector('.views-save button') as HTMLButtonElement).click();
      });
      await fresh.waitForSelector('.views-apply');

      // …survives the filter being cleared…
      await type('');
      await fresh.waitForFunction(() =>
        [...document.querySelectorAll('.row')].some(
          (row) => !row.textContent?.includes('/api/boom'),
        ),
      );

      // …and brings it back in one click.
      await fresh.evaluate(() => {
        (document.querySelector('.views-apply') as HTMLButtonElement).click();
      });
      await fresh.waitForFunction(
        () => (document.querySelector('.search input') as HTMLInputElement).value === 'status:5xx',
      );
      await fresh.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.row')];
        return rows.length > 0 && rows.every((row) => row.textContent?.includes('/api/boom'));
      });

      // ⌘K (as ctrl+k here): type a tab's name, Enter goes there.
      await fresh.keyboard.down('Control');
      await fresh.keyboard.press('KeyK');
      await fresh.keyboard.up('Control');
      await fresh.waitForSelector('.palette-input');
      await fresh.type('.palette-input', 'findings');
      await fresh.waitForFunction(
        () =>
          document
            .querySelector('.palette-row[data-active="true"]')
            ?.textContent?.includes('findings') ?? false,
      );
      await shoot('15-palette', fresh);
      await fresh.keyboard.press('Enter');
      await fresh.waitForSelector('.findings-head');

      // Esc closes it without leaving a mark.
      await fresh.keyboard.down('Control');
      await fresh.keyboard.press('KeyK');
      await fresh.keyboard.up('Control');
      await fresh.waitForSelector('.palette-input');
      await fresh.keyboard.press('Escape');
      await fresh.waitForFunction(() => document.querySelector('.palette-input') === null);
    } finally {
      await fresh.close();
    }
  });

  it('shows one page of a long list and fetches the rest on demand', async () => {
    // More requests than a page holds, made as fast as the app will take them.
    for (let batch = 0; batch < 6; batch++) {
      await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/api/order`)));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.load-more');

      // The batches above are bursts by construction; this test is about
      // paging, so grouping is switched off through its own setting first.
      await fresh.evaluate(() => {
        const links = [...document.querySelectorAll('.statusbar .sb-link')];
        (links.find((node) => node.textContent?.startsWith('bursts')) as HTMLButtonElement).click();
      });
      await fresh.waitForFunction(() => document.querySelectorAll('.row').length >= 100);

      const firstPage = await fresh.$$eval('.row', (nodes) => nodes.length);
      // A page, not the whole store: the point of paging is that the browser
      // is never handed everything at once.
      expect(firstPage).toBe(100);

      await (await fresh.$('.load-more'))?.click();
      await fresh.waitForFunction(() => document.querySelectorAll('.row').length > 100, {
        timeout: 10_000,
      });

      const grown = await fresh.$$eval('.row', (nodes) => nodes.length);
      expect(grown).toBeGreaterThan(firstPage);

      // And the older rows are older: the list stays in one order across the
      // seam between pages.
      const times = await fresh.$$eval('.row .cell-right:last-child', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      expect([...times].sort().reverse()).toEqual(times);
    } finally {
      await fresh.close();
    }
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

  it('narrows to a stretch of time, and offers the way back out of it', async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.setViewport({ width: 1440, height: 900 });
      await fresh.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.row');

      const openPill = async () => {
        await fresh.evaluate(() => {
          const pill = [...document.querySelectorAll('.chip')].find((node) =>
            node.textContent?.startsWith('time'),
          );
          (pill as HTMLButtonElement | undefined)?.click();
        });
        await fresh.waitForSelector('.timerange-pop');
      };
      const pick = async (label: string) => {
        await fresh.evaluate((text) => {
          const row = [...document.querySelectorAll('.timerange-pop .timerange-row')].find(
            (node) => node.textContent?.trim() === text,
          );
          (row as HTMLButtonElement | undefined)?.click();
        }, label);
      };
      const pill = () =>
        fresh.evaluate(
          () =>
            [...document.querySelectorAll('.chip')].find((node) =>
              node.textContent?.startsWith('time'),
            )?.textContent ?? '',
        );

      expect(await pill()).toContain('any time');

      // The demo started minutes ago, so yesterday holds nothing — which is
      // the interesting case, not the boring one.
      await openPill();
      await pick('yesterday');
      await fresh.waitForSelector('.rows-empty');

      expect(await pill()).toContain('yesterday');
      // The filters must survive a filter that matched nothing, or there is
      // no way back out of it.
      expect(await fresh.$('.filters')).not.toBeNull();
      expect(await fresh.$eval('.rows-empty', (node) => node.textContent ?? '')).toContain(
        'nothing matches',
      );

      await (await fresh.$('.rows-empty button'))?.click();
      await fresh.waitForFunction(() => document.querySelectorAll('.row').length > 0);

      expect(await pill()).toContain('any time');

      // And a stretch that covers everything brings everything back.
      await openPill();
      await pick('last 24 hours');
      await fresh.waitForFunction(() => document.querySelectorAll('.row').length > 0);
      expect(await pill()).toContain('last 24 h');

      // The calendar picks days without anybody typing a date. Today first,
      // then the day before it: one click is a day, two are a stretch.
      await openPill();
      await fresh.waitForSelector('.calendar');
      expect(await fresh.$$eval('.calendar-day', (nodes) => nodes.length)).toBe(42);
      expect(await fresh.$eval('.calendar-weekday', (node) => node.textContent ?? '')).toBe('Mo');

      await (await fresh.$('.calendar-day[data-today="true"]'))?.click();
      await fresh.waitForFunction(() => document.querySelectorAll('.row').length > 0);
      expect(await fresh.$$eval('.calendar-day[data-selected="true"]', (n) => n.length)).toBe(1);

      await fresh.evaluate(() => {
        const cells = [...document.querySelectorAll('.calendar-day')];
        const today = document.querySelector('.calendar-day[data-today="true"]');
        (cells[cells.indexOf(today as Element) - 1] as HTMLButtonElement | undefined)?.click();
      });
      await fresh.waitForFunction(
        () => document.querySelectorAll('.calendar-day[data-selected="true"]').length === 2,
      );
      // Yesterday holds nothing, so the stretch is still today's requests.
      expect(await fresh.$$eval('.row', (nodes) => nodes.length)).toBeGreaterThan(0);
    } finally {
      await fresh.close();
    }
  });

  it('the queue in front of a query is drawn, and named', async () => {
    const id = await page.evaluate(async (origin: string) => {
      const payload = (await (await fetch(`${origin}/_reqray/api/requests?limit=200`)).json()) as {
        requests: Array<{ id: string; path: string }>;
      };
      return payload.requests.find((row) => row.path === '/api/reports/burst')?.id ?? '';
    }, base);

    await page.goto(`${base}/_reqray/#l/req/${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.waterfall');

    // The lead-in on the bar: the stretch the query spent queueing, drawn
    // where it happened rather than as a row of its own.
    const waits = await page.$$eval('.wf-wait', (nodes) => nodes.length);
    expect(waits).toBeGreaterThan(0);

    const callout = await page.$eval('.findings', (node) => node.textContent ?? '');
    expect(callout).toContain('waited');
    expect(callout).toContain('for a free connection');
    // And the fix named is the pool, not the query.
    expect(callout).toContain('every connection was in use');

    await shoot('10-pool-wait');
  });

  it('a transaction held through a call says what it held, not what it saved', async () => {
    const id = await page.evaluate(async (origin: string) => {
      const payload = (await (await fetch(`${origin}/_reqray/api/requests?limit=200`)).json()) as {
        requests: Array<{ id: string; path: string }>;
      };
      return payload.requests.find((row) => row.path === '/api/pay')?.id ?? '';
    }, base);

    await page.goto(`${base}/_reqray/#l/req/${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.findings');

    const callout = await page.$eval('.findings', (node) => node.textContent ?? '');
    expect(callout).toContain('held a connection through');
    // The figure is the hold, in the place other findings print what comes
    // back: nothing here comes back to this request.
    expect(callout).toContain('holding a connection');
    expect(callout).not.toContain('0 ms recoverable');

    await shoot('11-transaction-hold');
  });

  it('findings: hundreds of occurrences read as a handful of patterns', async () => {
    await page.goto(`${base}/_reqray/#l/findings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.findings-row');

    // The whole argument of the tab: the demo has fired detectors hundreds
    // of times by now, and the work list stays a list a person can read to
    // the end — a couple of patterns per detector, not one row per firing.
    const head = await page.$eval('.findings-head', (node) => node.textContent ?? '');
    expect(head).toMatch(/patterns? · /);
    const patternCount = await page.$$eval('.findings-row', (nodes) => nodes.length);
    expect(patternCount).toBeGreaterThan(0);
    expect(patternCount).toBeLessThan(15);

    // Sorted by recoverable time: the first bar is the yardstick.
    const firstBar = await page.$eval(
      '.findings-row .findings-bar > span',
      (node) => (node as HTMLElement).style.width,
    );
    expect(firstBar).toBe('100%');

    // Unacknowledged patterns exist, and the tab's dot says so.
    await page.waitForSelector('.nav-dot');

    // A pattern expands into the requests behind it, and any of them opens.
    await page.evaluate(() => {
      (document.querySelector('.findings-line') as HTMLButtonElement).click();
    });
    await page.waitForSelector('.findings-open .peek-row');
    await shoot('14-findings');
    await page.evaluate(() => {
      (document.querySelector('.findings-open .peek-row') as HTMLButtonElement).click();
    });
    await page.waitForSelector('.detail');
    expect(page.url()).toContain('#l/req/');

    // Back for the state round-trip: mute quiets the pattern, unmute restores
    // it — put back exactly as found, because the store remembers.
    await page.goto(`${base}/_reqray/#l/findings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.findings-line');
    await page.evaluate(() => {
      (document.querySelector('.findings-line') as HTMLButtonElement).click();
    });
    await page.waitForSelector('.findings-actions');

    const act = (wanted: string) =>
      page.evaluate((label: string) => {
        const buttons = [...document.querySelectorAll('.findings-actions button')];
        (
          buttons.find((button) => button.textContent?.trim() === label) as HTMLButtonElement
        )?.click();
      }, wanted);

    await act('mute this pattern');
    await page.waitForFunction(
      () => document.querySelector('.findings-row')?.getAttribute('data-state') === 'muted',
    );
    await act('unmute');
    await page.waitForFunction(
      () => document.querySelector('.findings-row')?.getAttribute('data-state') === 'new',
    );

    // The status bar's findings count is a door to this tab — one of several
    // links now, so it is found by what it says.
    await page.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.statusbar .sb-link');
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('.statusbar .sb-link')];
      (links.find((node) => node.textContent?.startsWith('findings')) as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => window.location.hash === '#l/findings');
    await page.waitForSelector('.findings-head');
  });

  // The history plot's gestures, dispatched rather than driven with the
  // mouse. The plot is a control the size of the screen, and by this point in
  // the run the pointer has been dragged across several other charts; real
  // input aimed at a coordinate is delivered to whatever the browser still
  // thinks it is tracking. The component's own handlers are what these tests
  // are about, and this is the same reason the routes screen is clicked this
  // way a few tests above.
  const hoverHistoryAt = (fraction: number) =>
    page.evaluate((f: number) => {
      const node = document.querySelector('.history-plot') as HTMLElement;
      const rect = node.getBoundingClientRect();
      node.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: rect.left + rect.width * f,
          clientY: rect.top + rect.height / 2,
        }),
      );
    }, fraction);

  const clickHistoryAt = (fraction: number) =>
    page.evaluate((f: number) => {
      const node = document.querySelector('.history-plot') as HTMLElement | null;
      if (!node) throw new Error('the history chart did not render');
      const rect = node.getBoundingClientRect();
      const options = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        clientX: rect.left + rect.width * f,
        clientY: rect.top + rect.height / 2,
      };
      node.dispatchEvent(new PointerEvent('pointerdown', options));
      node.dispatchEvent(new PointerEvent('pointerup', options));
    }, fraction);

  /** Walks the plot until the readout names a column with traffic; the
   * store's window decides where the seeded requests landed. */
  const busyHistoryColumn = async (): Promise<number> => {
    for (const fraction of [0.95, 0.85, 0.7, 0.5, 0.3, 0.1]) {
      await hoverHistoryAt(fraction);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const foot = await page.$eval('.history-foot .mono', (node) => node.textContent ?? '');
      if (foot.includes('calls') && !foot.includes('nothing ran')) return fraction;
    }
    throw new Error('no busy column found on the history chart');
  };

  it('draws a period, and every point opens the requests behind it', async () => {
    await page.goto(`${base}/_reqray/#l/history`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.history');
    // The screen inherits the list's filter, and the tests before this one
    // leave theirs behind. Clearing it from here is also the assertion that
    // the pill saying so exists: an inherited filter nobody can see turns an
    // empty chart into a mystery about the whole application.
    await page.evaluate(() => {
      (document.querySelector('.history .route-filter') as HTMLButtonElement | null)?.click();
    });
    await page.waitForSelector('.history-svg');
    await page.waitForFunction(
      () => !(document.querySelector('.history')?.textContent ?? '').includes('reading the period'),
    );

    // The period's own numbers, above the shape: a chart answers "when" and
    // only a number answers "how much".
    const totals = await page.$eval('.history-totals', (node) => node.textContent ?? '');
    expect(totals).toContain('calls');
    expect(totals).toMatch(/p50 \/ p95 \/ p99/);
    expect(totals).toContain('busiest');

    // A line, and a scale that says what a height means.
    expect(
      await page.$$eval('.history-svg polyline, .history-svg circle', (n) => n.length),
    ).toBeGreaterThan(0);
    expect(await page.$$eval('.history-axis span', (n) => n.length)).toBe(3);
    expect(await page.$$eval('.history-ticks span', (n) => n.length)).toBe(5);

    // Two metrics at once, each on its own scale.
    await page.evaluate(() => {
      const selects = [...document.querySelectorAll('.history-pick select')];
      const companion = selects[1] as HTMLSelectElement;
      companion.value = 'loopDelay';
      companion.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.history-axis').length === 2, {
      timeout: 10_000,
    });

    await shoot('12-history');

    // And the whole point: a column is a way in, not a reading. Clicking one
    // pins its requests to the rail — navigating away would tear the reader
    // from the chart mid-thought — and the rail carries the way onward:
    // "open all" lands the list on exactly that stretch.
    const busy = await busyHistoryColumn();
    await clickHistoryAt(busy);
    await page.waitForFunction(
      () => document.querySelector('.history-rail')?.getAttribute('data-scope') === 'pinned',
    );
    await page.waitForSelector('.rail-open');
    await page.evaluate(() => {
      (document.querySelector('.rail-open') as HTMLButtonElement).click();
    });

    await page.waitForSelector('.timeline-label');
    const label = await page.$eval('.timeline-label', (node) => node.textContent ?? '');
    // The list is now scoped to the stretch that column stood for.
    expect(label).toContain('window');

    // And put it back: the tests after this share the page.
    await page.evaluate(() => {
      (document.querySelector('.tl-reset') as HTMLButtonElement | null)?.click();
    });
    await page.waitForSelector('.row');
  });

  it('waits as rows, says what emptied the screen, and fades between tabs', async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.setViewport({ width: 1440, height: 900 });

      // A table waits as a table: rows at the height the real ones will
      // have, so nothing jumps when the answer lands — and never the
      // welcome card, which is a claim that the store is empty.
      await fresh.evaluateOnNewDocument(() => {
        const real = window.fetch;
        window.fetch = async (...args: Parameters<typeof fetch>) => {
          if (/\/api\/requests(\?|$)/.test(String(args[0]))) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
          return real(...args);
        };
      });
      await fresh.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.skeleton-row');
      expect(await fresh.$('.empty-card')).toBeNull();

      const placeholder = await fresh.$eval(
        '.skeleton-row',
        (node) => node.getBoundingClientRect().height,
      );
      await fresh.waitForSelector('.row');
      const real = await fresh.$eval('.row', (node) => node.getBoundingClientRect().height);
      expect(placeholder).toBe(real);

      // A filter that matches nothing names the question rather than the
      // answer: a bare "no results" leaves the reader guessing which of six
      // narrowings emptied the screen.
      const type = (value: string) =>
        fresh.evaluate((text: string) => {
          const input = document.querySelector('.search input') as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);

      await type('status:5xx nothingmatchesthis');
      await fresh.waitForSelector('.rows-empty');
      const terms = await fresh.$$eval('.rows-empty-term', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      expect(terms).toContain('status:5xx');
      expect(terms).toContain('nothingmatchesthis');
      await fresh.waitForSelector('.rows-empty .btn-secondary');

      // And the detail's tabs cross-fade rather than jumping.
      await type('');
      await fresh.waitForSelector('.row');
      await fresh.evaluate(() => {
        (document.querySelector('.row') as HTMLButtonElement).click();
      });
      await fresh.waitForSelector('.tab-body');
      const faded = await fresh.evaluate(() => {
        const buttons = [...document.querySelectorAll('.tabs button')];
        (buttons.find((node) => node.textContent === 'Headers') as HTMLButtonElement).click();
        return document
          .getAnimations()
          .some((animation) => (animation as CSSAnimation).animationName === 'tab-in');
      });
      expect(faded).toBe(true);
    } finally {
      await fresh.close();
    }
  }, 45_000);

  it('a relative period holds still instead of blinking', async () => {
    // The regression this locks down: "today" computed its window from
    // `Date.now()` in render, so every answer moved the window, which asked
    // again, forever — the chart flashed "reading the period…" and never
    // settled. A fixed window settles in one round trip.
    await page.goto(`${base}/_reqray/#l/history`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.history-svg');

    for (const label of ['today', '7 days']) {
      await page.evaluate((wanted: string) => {
        const chips = [...document.querySelectorAll('.history-periods .chip')];
        (chips.find((chip) => chip.textContent === wanted) as HTMLButtonElement)?.click();
      }, label);
      // Long enough for the loop, if it existed, to be mid-flash.
      await new Promise((resolve) => setTimeout(resolve, 700));
      const text = await page.$eval('.history', (node) => node.textContent ?? '');
      expect(text).not.toContain('reading the period');
      expect(await page.$('.history-svg')).not.toBeNull();
      expect(text).toContain('calls');
    }
  });

  it('the wheel zooms under the cursor, and winds back out', async () => {
    await page.evaluate(() => {
      const chips = [...document.querySelectorAll('.history-periods .chip')];
      (chips.find((chip) => chip.textContent === 'everything') as HTMLButtonElement)?.click();
    });
    await page.waitForFunction(
      () => !(document.querySelector('.history')?.textContent ?? '').includes('reading the period'),
    );

    const spin = (options: { deltaY?: number; deltaX?: number; ctrlKey?: boolean }) =>
      page.evaluate((given: { deltaY?: number; deltaX?: number; ctrlKey?: boolean }) => {
        const node = document.querySelector('.history-plot') as HTMLElement;
        const rect = node.getBoundingClientRect();
        node.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width * 0.6,
            clientY: rect.top + rect.height / 2,
            ...given,
          }),
        );
      }, options);

    // In: the exit appears. A pinch arrives as a ctrl-wheel and counts too.
    await spin({ deltaY: -240 });
    await spin({ deltaY: -40, ctrlKey: true });
    await page.waitForSelector('.history-head .tl-scope');

    // Sideways: the window pans and stays zoomed.
    await spin({ deltaX: 200, deltaY: 0 });
    expect(await page.$('.history-head .tl-scope')).not.toBeNull();

    // Out past the whole period: the zoom clears itself, no button needed.
    for (let index = 0; index < 10; index++) await spin({ deltaY: 500 });
    await page.waitForFunction(() => document.querySelector('.history-head .tl-scope') === null);
  });

  it('the rail names the requests behind the chart, and any of them opens', async () => {
    // Docked beside the plot, never over it: idle it answers for the whole
    // period, hovering a column narrows it to that column, leaving widens it
    // back, clicking pins it — and every row is a way straight into the
    // detail.
    await page.waitForSelector('.history-rail .peek-row');
    expect(await page.$eval('.history-rail', (node) => node.getAttribute('data-scope'))).toBe(
      'period',
    );

    // The rail must not cover the plot — that is the reason it exists.
    const apart = await page.evaluate(() => {
      const plot = document.querySelector('.history-plot')?.getBoundingClientRect();
      const rail = document.querySelector('.history-rail')?.getBoundingClientRect();
      return plot && rail ? rail.left >= plot.right : false;
    });
    expect(apart).toBe(true);

    const busy = await busyHistoryColumn();
    await hoverHistoryAt(busy);

    await page.waitForFunction(
      () => document.querySelector('.history-rail')?.getAttribute('data-scope') === 'column',
    );
    expect(await page.$eval('.rail-title', (node) => node.textContent ?? '')).toContain(
      'under the pointer',
    );
    await page.waitForSelector('.history-rail .peek-row');

    // Leaving the plot widens the rail back to the period. React derives
    // pointerleave from pointerout, so that is what a synthetic leave sends.
    await page.evaluate(() => {
      document
        .querySelector('.history-plot')
        ?.dispatchEvent(
          new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
        );
    });
    await page.waitForFunction(
      () => document.querySelector('.history-rail')?.getAttribute('data-scope') === 'period',
    );

    // Hover alone cannot carry a hand to the rail: crossing the plot sweeps
    // the pointer through every column on the way, and each one would steal
    // the list before the hand arrived. Clicking pins the column — marked on
    // the chart, released by its own button — and the pointer is free.
    await clickHistoryAt(busy);
    await page.waitForFunction(
      () => document.querySelector('.history-rail')?.getAttribute('data-scope') === 'pinned',
    );
    expect(await page.$eval('.rail-title', (node) => node.textContent ?? '')).toContain('pinned');
    expect(await page.$('.chart-pin')).not.toBeNull();

    // Crossing the plot changes nothing now.
    await hoverHistoryAt(busy > 0.5 ? 0.1 : 0.95);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await page.$eval('.history-rail', (node) => node.getAttribute('data-scope'))).toBe(
      'pinned',
    );

    await shoot('13-history-peek');

    // Unpinning hands the rail back to the period…
    await page.evaluate(() => {
      (document.querySelector('.rail-unpin') as HTMLButtonElement).click();
    });
    await page.waitForFunction(
      () => document.querySelector('.history-rail')?.getAttribute('data-scope') === 'period',
    );
    expect(await page.$('.chart-pin')).toBeNull();

    // …and a pinned row opens the request, which is what the pin is for.
    await clickHistoryAt(busy);
    await page.waitForFunction(
      () => document.querySelector('.history-rail')?.getAttribute('data-scope') === 'pinned',
    );
    await page.waitForSelector('.history-rail .peek-row');
    await page.evaluate(() => {
      (document.querySelector('.history-rail .peek-row') as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.detail');
    expect(page.url()).toContain('#l/req/');

    // Back to the history screen for the tests that follow.
    await page.goto(`${base}/_reqray/#l/history`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.history-svg');
  });

  it('the period before, what changed in this one, and two columns compared', async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.setViewport({ width: 1440, height: 900 });

      // The ghost is drawn from the period immediately before the one on
      // screen, which in a minutes-old store is usually empty — the
      // arithmetic is pinned by unit tests. What the browser owns is the
      // drawing, so the answer is given a ghost on its way in.
      await fresh.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
      // The panel writes its own hash when it mounts, so a navigation issued
      // before that lands is overwritten a moment later. Wait for the list to
      // be up, then travel from inside the page — which also keeps the fetch
      // wrapper below alive, a document reload would take it with it.
      await fresh.waitForSelector('.row');
      await fresh.evaluate(() => {
        const real = window.fetch;
        window.fetch = async (...args: Parameters<typeof fetch>) => {
          const response = await real(...args);
          if (!String(args[0]).includes('/api/series')) return response;
          const payload = (await response.clone().json()) as {
            series: { calls: number[]; series: Array<{ values: Array<number | null> }> } | null;
          };
          if (payload.series) {
            // Half of the current line, so it sits under it rather than
            // rescaling the box.
            (payload.series as unknown as { ghost: Array<number | null> }).ghost = (
              payload.series.series[0]?.values ?? []
            ).map((value) => (value === null ? null : value / 2));
          }
          return new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json' },
          });
        };
      });
      await fresh.evaluate(() => {
        window.location.hash = '#l/history';
      });
      await fresh.waitForSelector('.history-svg');
      await fresh.waitForSelector('.chart-ghost');

      // And the control turns it off — a comparison nobody asked for is a
      // second line on a chart that promised at most two.
      await fresh.evaluate(() => {
        const selects = [...document.querySelectorAll('.history-pick select')];
        const against = selects[2] as HTMLSelectElement;
        against.value = '';
        against.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await fresh.waitForFunction(() => document.querySelector('.chart-ghost') === null);

      // What the panel witnessed inside the window: the patterns first seen
      // here, drawn as rules on the chart and named in the rail.
      await fresh.waitForSelector('.chart-event');
      await fresh.waitForSelector('.event-chip');
      // Thinned: a cluster of events inside one second is one rule, not
      // eight, or the layer is a hatch pattern rather than an annotation.
      expect(await fresh.$$eval('.chart-event', (nodes) => nodes.length)).toBeLessThanOrEqual(4);
      await fresh.waitForSelector('.rail-changed');
      const changed = await fresh.$eval('.rail-changed', (node) => node.textContent ?? '');
      expect(changed).toContain('first seen');

      // Two columns held side by side: pin one, shift-click another.
      const click = (fraction: number, shift: boolean) =>
        fresh.evaluate(
          ({ f, s }: { f: number; s: boolean }) => {
            const node = document.querySelector('.history-plot') as HTMLElement;
            const rect = node.getBoundingClientRect();
            const options = {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              shiftKey: s,
              clientX: rect.left + rect.width * f,
              clientY: rect.top + rect.height / 2,
            };
            node.dispatchEvent(new PointerEvent('pointerdown', options));
            node.dispatchEvent(new PointerEvent('pointerup', options));
          },
          { f: fraction, s: shift },
        );

      await click(0.95, false);
      await fresh.waitForFunction(
        () => document.querySelector('.history-rail')?.getAttribute('data-scope') === 'pinned',
      );
      await click(0.4, true);
      await fresh.waitForSelector('.rail-compare');
      await fresh.waitForSelector('.chart-pin-b');
      const compared = await fresh.$eval('.rail-compare', (node) => node.textContent ?? '');
      expect(compared).toContain('A');
      expect(compared).toContain('B');

      await shoot('18-history-compare', fresh);

      // Dropping B leaves the pin alone — one question at a time.
      await fresh.evaluate(() => {
        const buttons = [...document.querySelectorAll('.rail-compare button')];
        (buttons[0] as HTMLButtonElement).click();
      });
      await fresh.waitForFunction(() => document.querySelector('.chart-pin-b') === null);
      expect(await fresh.$eval('.history-rail', (node) => node.getAttribute('data-scope'))).toBe(
        'pinned',
      );
    } finally {
      await fresh.close();
    }
    // Longer than the default: this one loads two pages, waits out three
    // fetches and photographs the result, and the screenshot pass adds its
    // own wait for every animation on screen to finish.
  }, 45_000);

  it('the history chart follows the live toggle', async () => {
    // Still on the history screen, un-zoomed, on "everything". The live tick
    // slides the window forward every few seconds, and every slide is one
    // request — observable even with the demo traffic off, because the
    // window itself moves. Paused must mean *nothing* moves: the original
    // sin of this screen was a window that moved on its own schedule.
    await page.evaluate(() => {
      const counted = window as unknown as { __series: number; fetch: typeof fetch };
      counted.__series = 0;
      const original = window.fetch.bind(window);
      window.fetch = (...args: Parameters<typeof fetch>) => {
        if (String(args[0]).includes('/api/series')) counted.__series++;
        return original(...args);
      };
    });

    await page.evaluate(() =>
      (document.querySelector('.live-toggle') as HTMLButtonElement).click(),
    );
    await page.waitForFunction(
      () => document.querySelector('.live-toggle')?.textContent?.includes('paused') ?? false,
    );
    // The previous test's zoom-out scheduled one settled read; let it land
    // before the meter starts, or the pause is blamed for the past.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.evaluate(() => {
      (window as unknown as { __series: number }).__series = 0;
    });
    await new Promise((resolve) => setTimeout(resolve, 5_800));
    expect(await page.evaluate(() => (window as unknown as { __series: number }).__series)).toBe(0);

    await page.evaluate(() =>
      (document.querySelector('.live-toggle') as HTMLButtonElement).click(),
    );
    await page.waitForFunction(() => (window as unknown as { __series: number }).__series > 0, {
      timeout: 9_000,
    });
  }, 20_000);

  it('the routes screen re-reads while live, and its open charts stay up', async () => {
    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav button')];
      (nav.find((button) => button.textContent === 'Routes') as HTMLButtonElement)?.click();
    });
    await page.waitForSelector('.routes-row');
    // Dispatched, not clicked at a coordinate — the same reason as the other
    // chart tests: this late in the run, real input aimed at a row is
    // delivered to whatever the browser still thinks it is tracking.
    await page.evaluate(() => {
      document
        .querySelector('.routes-row')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForSelector('.chart-svg');

    await page.evaluate(() => {
      const counted = window as unknown as { __routes: number };
      counted.__routes = 0;
      const original = window.fetch.bind(window);
      window.fetch = (...args: Parameters<typeof fetch>) => {
        if (/\/api\/routes(\?|$)/.test(String(args[0]))) counted.__routes++;
        return original(...args);
      };
    });

    // The poll fires; the open route's charts ride the refresh instead of
    // resetting to "reading this route's history…" — the same anti-blink
    // promise the history screen makes.
    await page.waitForFunction(() => (window as unknown as { __routes: number }).__routes > 0, {
      timeout: 9_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await page.$$eval('.chart-svg', (nodes) => nodes.length)).toBe(3);
    expect(await page.$eval('.route-charts', (node) => node.textContent ?? '')).not.toContain(
      "reading this route's history",
    );
  }, 20_000);

  it('the project tab answers what is instrumented and how it is configured', async () => {
    const fresh = await browser.newPage();
    try {
      // A page of its own starts at the default 800×600; the rest of the panel
      // is looked at — and screenshotted — at the viewport set in beforeAll.
      await fresh.setViewport({ width: 1440, height: 900 });
      await fresh.goto(`${base}/_reqray/#l/project`, { waitUntil: 'domcontentloaded' });
      await fresh.waitForSelector('.instr-row');

      // The startup report, which until now existed only in a terminal line
      // that had long scrolled away.
      const instrumented = await fresh.$$eval('.instr-row', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      expect(
        instrumented.some((line) => line.includes('fastify') && line.includes('requests')),
      ).toBe(true);
      expect(instrumented.some((line) => line.includes('pg') && line.includes('SQL'))).toBe(true);
      expect(instrumented.some((line) => line.includes('ioredis') && line.includes('cache'))).toBe(
        true,
      );

      const facts = await fresh.$$eval('.fact', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      const text = facts.join('\n');
      // The application, the build it came from, and where its code lives.
      expect(text).toContain('@reqray/example-fastify-postgres');
      expect(text).toContain('examples/fastify-postgres');
      // What the panel would record, and what it would never store.
      expect(text).toContain('memory');
      expect(text).toContain('authorization');
      expect(text).toContain('cardnumber');

      // What no recorded request can say: how big the pool is and whether
      // anybody is queueing for it right now.
      expect(text).toMatch(/of \d+ connections open/);

      const detectors = await fresh.$$eval('.detector-row', (nodes) =>
        nodes.map((node) => node.textContent ?? ''),
      );
      expect(detectors.some((line) => line.includes('N+1') && line.includes('threshold'))).toBe(
        true,
      );

      await shoot('09-project', fresh);
    } finally {
      await fresh.close();
    }
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
