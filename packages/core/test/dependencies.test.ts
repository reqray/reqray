/**
 * The dependency claim, made checkable.
 *
 * Core promises no third-party runtime dependencies and declares one: types
 * that emit nothing. Honest only while protocol stays types-only, so the built
 * bundle is the witness — that is what a consumer installs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function manifest(name: string): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, '..', name, 'package.json'), 'utf8'));
}

describe('what core depends on', () => {
  it('declares no third-party dependency', () => {
    const declared = Object.keys(manifest('core').dependencies ?? {});
    expect(declared.filter((name) => !name.startsWith('@reqray/'))).toEqual([]);
  });

  it('the protocol it depends on brings nothing of its own', () => {
    expect(Object.keys(manifest('protocol').dependencies ?? {})).toEqual([]);
  });

  for (const bundle of ['index.js', 'index.cjs']) {
    it(`loads nothing from @reqray/protocol at runtime (${bundle})`, () => {
      const built = join(root, 'dist', bundle);
      // Building is CI's job and a local `pnpm test` may run without one; an
      // absent bundle is not a failing claim, it is an unbuilt tree.
      if (!existsSync(built)) return;
      expect(readFileSync(built, 'utf8')).not.toContain('@reqray/protocol');
    });
  }
});

describe('what the recording entry carries', () => {
  /**
   * The two entries exist so an instrumentation timing a query does not link
   * the panel with it. One convenient import would undo that silently.
   *
   * Checked against the CJS bundle: the ESM build code-splits, so what
   * `index.js` contains says less than what it pulls in. Spelled the way tsup
   * emits it — it drops the `node:` prefix, and the prefixed name would match
   * nothing and pass for the wrong reason.
   */
  const primitives = [
    // Spawning `git`, for blame and the project screen.
    'require("child_process")',
    // Streaming the dashboard's files off disk.
    'createReadStream',
  ];

  for (const primitive of primitives) {
    it(`does not reach for ${primitive}`, () => {
      const built = join(root, 'dist', 'index.cjs');
      if (!existsSync(built)) return;
      expect(readFileSync(built, 'utf8')).not.toContain(primitive);
    });
  }

  it('and the panel entry does, which is the point of separating them', () => {
    const built = join(root, 'dist', 'panel', 'index.cjs');
    if (!existsSync(built)) return;
    const text = readFileSync(built, 'utf8');
    for (const primitive of primitives) expect(text).toContain(primitive);
  });
});
