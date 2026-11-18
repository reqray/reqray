/**
 * The project report.
 *
 * Two things are worth guarding here: that it says what it knows, and that it
 * says nothing it should not. The panel is gated, but "gated" is not a licence
 * to hand over the gate itself.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportInstrumentation, resolveOptions } from '@reqray/core';
import { projectReport, storageOf } from '@reqray/core/panel';
import { clearDiagnostics, clearGitHead } from '@reqray/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];

function project(manifest: Record<string, unknown> | null = { name: 'shop', version: '2.1.0' }) {
  const dir = mkdtempSync(join(tmpdir(), 'reqray-project-'));
  dirs.push(dir);
  if (manifest) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

const optionsFor = (root: string, over: Parameters<typeof resolveOptions>[0] = {}) =>
  resolveOptions({ mode: 'development', ...over, stack: { projectRoot: root, ...over.stack } });

beforeEach(() => {
  clearDiagnostics();
  clearGitHead();
});

afterEach(() => {
  clearDiagnostics();
  clearGitHead();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('what it knows about the application', () => {
  it('names it from its own manifest', async () => {
    const root = project();

    const report = await projectReport(optionsFor(root), null);

    expect(report.app).toMatchObject({ name: 'shop', version: '2.1.0', root });
  });

  it('an application without a manifest is not an error', async () => {
    const report = await projectReport(optionsFor(project(null)), null);

    expect(report.app.name).toBeNull();
    expect(report.app.version).toBeNull();
  });

  it('says which commit is running, and whether it is dirty', async () => {
    const root = project();
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ada Lovelace',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_COMMITTER_NAME: 'Ada Lovelace',
          GIT_COMMITTER_EMAIL: 'ada@example.com',
        },
      });
    git('init', '-q', '-b', 'release');
    git('add', '.');
    git('-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-qm', 'first');

    const clean = await projectReport(optionsFor(root), null);
    expect(clean.app.git).toMatchObject({ branch: 'release', dirty: false });
    expect(clean.app.git?.sha).toMatch(/^[0-9a-f]{7,}$/);

    writeFileSync(join(root, 'index.js'), 'console.log(1)\n');
    clearGitHead();
    const dirty = await projectReport(optionsFor(root), null);
    expect(dirty.app.git?.dirty).toBe(true);
  });

  it('a directory that is not a checkout simply has no commit', async () => {
    const report = await projectReport(optionsFor(project()), null);

    expect(report.app.git).toBeNull();
  });
});

describe('what it knows about the recording', () => {
  it('carries the startup report the terminal used to own', async () => {
    reportInstrumentation({ name: 'pg', version: '8.23.0', captures: 'SQL', ok: true });
    reportInstrumentation({
      name: 'prisma',
      captures: 'SQL',
      ok: false,
      reason: 'found, but loaded before reqray',
      hint: 'start with `node --import @reqray/register`',
    });

    const report = await projectReport(optionsFor(project()), null);

    expect(report.instrumentation).toHaveLength(2);
    expect(report.instrumentation[1]).toMatchObject({
      name: 'prisma',
      ok: false,
      hint: 'start with `node --import @reqray/register`',
    });
  });

  it('reports the settings that decide what is recorded', async () => {
    const report = await projectReport(
      optionsFor(project(), { bufferSize: 250, collectSqlValues: true }),
      null,
    );

    expect(report.reqray).toMatchObject({
      mode: 'development',
      enabled: true,
      bufferSize: 250,
      collectSqlValues: true,
    });
    expect(report.reqray.redact.headers).toContain('authorization');
    expect(report.reqray.detect['nPlusOne']).toBeTruthy();
  });

  it('describes the process doing the recording', async () => {
    const report = await projectReport(optionsFor(project()), null);

    expect(report.runtime.node).toBe(process.version);
    expect(report.runtime.pid).toBe(process.pid);
    expect(report.runtime.rssMb).toBeGreaterThan(0);
    expect(report.runtime.startedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('what it must not say', () => {
  it('reports that the panel is gated, never the gate', async () => {
    const secret = 'a-real-staging-token';
    const report = await projectReport(
      optionsFor(project(), {
        mode: 'production',
        panel: { gate: (context) => context.headers['x-token'] === secret },
      }),
      null,
    );

    expect(report.reqray.panel?.gated).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('does not carry the environment along', async () => {
    process.env['REQRAY_TEST_SECRET'] = 'not-for-the-panel';
    try {
      const report = await projectReport(optionsFor(project()), null);

      expect(JSON.stringify(report)).not.toContain('not-for-the-panel');
    } finally {
      delete process.env['REQRAY_TEST_SECRET'];
    }
  });
});

describe('what the store says about itself', () => {
  it('takes the numbers a store offers', () => {
    const store = {
      name: 'sqlite',
      stats: () => ({
        size: 12,
        capacity: 500,
        evicted: 3,
        oldestAt: 1_000,
        pinned: 1,
        bytes: 900,
      }),
    };

    expect(storageOf(store)).toEqual({
      name: 'sqlite',
      size: 12,
      capacity: 500,
      evicted: 3,
      oldestAt: 1_000,
      pinned: 1,
      bytes: 900,
    });
  });

  it('a store that says nothing is not a store that failed', () => {
    // `stats()` is not part of the panel's contract, and a source without one
    // is still a valid source.
    expect(storageOf({ name: 'custom' })).toBeNull();
    expect(storageOf(null)).toBeNull();
  });

  it('a store that throws is not allowed to take the screen with it', () => {
    expect(
      storageOf({
        name: 'broken',
        stats: () => {
          throw new Error('the disk is gone');
        },
      }),
    ).toBeNull();
  });

  it('fills in what a partial answer leaves out', () => {
    expect(storageOf({ name: 'memory', stats: () => ({ size: 4 }) })).toMatchObject({
      size: 4,
      capacity: null,
      bytes: null,
    });
  });
});
