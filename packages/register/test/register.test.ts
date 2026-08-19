/**
 * Loader hooks cannot be tested honestly inside the test runner: it sets up
 * its own module pipeline and loads everything before we get a chance. So each
 * scenario runs in its own process, started exactly the way a user would start
 * it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distEntry = `${packageRoot}dist/index.js`;
const fixtures = `${packageRoot}test/fixtures`;

interface FixtureResult {
  readonly patched: boolean;
  readonly diagnostics: string;
}

function run<T = FixtureResult>(args: string[]): T {
  const stdout = execFileSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: packageRoot,
    timeout: 30_000,
  });
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as T;
}

beforeAll(() => {
  // The hooks are installed via `--import`, which needs the built file, not
  // the sources. Build once, on demand, if there is no build yet.
  if (existsSync(distEntry)) return;
  execFileSync('pnpm', ['--filter', '@loupe/register', 'build'], {
    cwd: `${packageRoot}../..`,
    stdio: 'inherit',
    timeout: 180_000,
  });
}, 200_000);

describe('auto-instrumentation via node --import', () => {
  it('intercepts pg in an ESM application', () => {
    const result = run(['--import', distEntry, `${fixtures}/esm-app.mjs`]);

    expect(result.patched).toBe(true);
  });

  it('intercepts pg in a CommonJS application', () => {
    const result = run(['--import', distEntry, `${fixtures}/cjs-app.cjs`]);

    expect(result.patched).toBe(true);
  });

  it('prints a report with the package version and the built-in undici', () => {
    const { diagnostics } = run(['--import', distEntry, `${fixtures}/esm-app.mjs`]);

    expect(diagnostics).toContain('instrumentation active');
    expect(diagnostics).toMatch(/✔ pg@\d+\.\d+\.\d+\s+SQL/);
    expect(diagnostics).toContain('✔ undici (built-in)');
  });

  it('honestly reports a driver loaded before Loupe', () => {
    const result = run([`${fixtures}/too-late-app.cjs`, distEntry]);

    expect(result.patched).toBe(false);
    expect(result.diagnostics).toContain('✘ pg');
    expect(result.diagnostics).toContain('found, but loaded before loupe');
    expect(result.diagnostics).toContain('node --import @loupe/register');
  });
});

describe('core loaded twice', () => {
  it('ESM and CJS copies of core share one request context', () => {
    // Two copies of core in one process is a normal situation: the adapter
    // arrives via import, while the loader hook or a third-party package
    // arrives via require. If each copy had its own AsyncLocalStorage, the
    // instrumentation would not see the scope created by the adapter and no
    // spans would be written at all.
    const result = run<{
      separateCopies: boolean;
      esmSeesCjsScope: string | null;
      cjsSeesEsmScope: string | null;
    }>([`${fixtures}/dual-load.cjs`]);

    expect(result.separateCopies).toBe(true);
    expect(result.esmSeesCjsScope).toBe('dual');
    expect(result.cjsSeesEsmScope).toBe('dual');
  });
});
