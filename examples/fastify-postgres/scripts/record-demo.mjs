/**
 * Records the README's demo: a request arrives, it is flagged N+1, one click
 * shows the line it came from and the query to write instead.
 *
 *   node scripts/record-demo.mjs <output.gif>
 *
 * Needs Chrome and ffmpeg. Frames come from Chrome's own screencast, so what
 * is recorded is what the panel paints, animations included; the cursor is a
 * drawn one, because a headless browser has none.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? 'demo.gif');
// The width the README's screenshots are taken at: narrower, and the panel
// clips its right-hand columns.
const WIDTH = 1440;
const HEIGHT = 810;

const chromePath = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error('Chrome not found');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 450; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Still starting: seeding the embedded database takes a moment.
    }
    await sleep(200);
  }
  throw new Error('the demo application did not come up');
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ['--import', '@reqray/register', 'src/index.js'], {
  cwd: exampleRoot,
  env: { ...process.env, PORT: String(port), DEMO_TRAFFIC: 'off' },
  stdio: 'ignore',
});
const frames = mkdtempSync(join(tmpdir(), 'reqray-demo-'));
let browser;

try {
  await waitFor(`${base}/api/orders/eager`);
  // A few ordinary requests, so the flagged one arrives into a list.
  for (const path of ['/api/order', '/api/profile/1', '/api/orders/eager', '/api/order']) {
    await fetch(`${base}${path}`);
  }
  await sleep(400);

  browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
  await page.goto(`${base}/_reqray/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');

  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 3l14 8.5-6.2 1.6L9.6 19z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    cursor.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform';
    document.body.append(cursor);
    document.addEventListener('mousemove', (event) => {
      cursor.style.transform = `translate(${event.clientX - 4}px, ${event.clientY - 2}px)`;
    });
  });

  let at = { x: WIDTH - 140, y: HEIGHT - 90 };
  await page.mouse.move(at.x, at.y);

  /** Moves the drawn cursor the way a hand does: eased, over real time. */
  async function glide(to, ms = 650) {
    const steps = Math.round(ms / 16);
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await page.mouse.move(at.x + (to.x - at.x) * eased, at.y + (to.y - at.y) * eased);
      await sleep(16);
    }
    at = to;
  }

  /** The centre of the first element matching `selector` whose text passes `wanted`. */
  async function centreOf(selector, wanted) {
    const box = await page.evaluate(
      (css, text) => {
        const found = [...document.querySelectorAll(css)].find((node) =>
          (node.textContent ?? '').includes(text),
        );
        if (!found) return null;
        const rect = found.getBoundingClientRect();
        return { x: rect.left + Math.min(rect.width / 2, 260), y: rect.top + rect.height / 2 };
      },
      selector,
      wanted,
    );
    if (!box) throw new Error(`nothing matching ${selector} with "${wanted}"`);
    return box;
  }

  const session = await page.createCDPSession();
  const shots = [];
  session.on('Page.screencastFrame', (frame) => {
    const file = join(frames, `${String(shots.length).padStart(5, '0')}.png`);
    writeFileSync(file, Buffer.from(frame.data, 'base64'));
    shots.push({ file, at: frame.metadata.timestamp });
    session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
  });
  await session.send('Page.startScreencast', { format: 'png', everyNthFrame: 2 });

  // 1. The list as it is.
  await sleep(1200);

  // 2. The request with the loop in it arrives.
  await fetch(`${base}/api/orders`);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.row')].some((node) => node.textContent?.includes('N+1')),
  );
  await sleep(1300);

  // 3. One click on it.
  await glide(await centreOf('.row', 'N+1'));
  await sleep(350);
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector('.fix-card');
  await sleep(2600);

  // 4. The line it came from, then what to write instead.
  await glide(await centreOf('.fix-card a, .fix-card button', 'orders.js'), 550);
  await sleep(1400);
  await glide(await centreOf('.fix-add', 'ANY'), 500);
  await sleep(2400);

  await session.send('Page.stopScreencast');
  const endedAt = shots.at(-1).at + 1.2;

  // Each frame is shown until the next one was painted; the screencast only
  // sends a frame when something changed, so stillness costs nothing.
  const list = shots
    .map((shot, index) => {
      const until = shots[index + 1]?.at ?? endedAt;
      return `file '${shot.file}'\nduration ${Math.max(until - shot.at, 0.01).toFixed(3)}`;
    })
    .join('\n');
  const listFile = join(frames, 'frames.txt');
  writeFileSync(listFile, `${list}\nfile '${shots.at(-1).file}'\n`);

  mkdirSync(dirname(output), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-vf',
      // One palette for the whole clip: the panel has few colours, and a
      // palette per frame makes flat surfaces shimmer.
      `fps=12,scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      output,
    ],
    { stdio: 'inherit' },
  );
  console.log(`${output}: ${shots.length} frames captured`);
} finally {
  await browser?.close();
  app.kill('SIGKILL');
  rmSync(frames, { recursive: true, force: true });
}
