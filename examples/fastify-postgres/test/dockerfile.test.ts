/**
 * The image that runs this demo has to know about every workspace package.
 *
 * `pnpm install --frozen-lockfile` needs every manifest present before the
 * sources are copied, so the Dockerfile lists them one by one — that is what
 * keeps the dependency layer cached across edits to the code. The cost of that
 * list is that adding a package and forgetting a line breaks `docker compose
 * up --build`, and breaks it late, in a build log rather than in a test.
 *
 * So the list is checked here instead. It has already been forgotten twice.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dockerfile = readFileSync(`${repoRoot}Dockerfile`, 'utf8');

/** Every workspace package, as pnpm-workspace.yaml globs them. */
function workspaceManifests(): string[] {
  const found = ['bench/package.json'];
  for (const group of ['packages', 'examples']) {
    for (const entry of readdirSync(`${repoRoot}${group}`, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      found.push(`${group}/${entry.name}/package.json`);
    }
  }
  return found;
}

describe('the demo image', () => {
  it('copies the manifest of every workspace package', () => {
    const missing = workspaceManifests().filter((manifest) => !dockerfile.includes(manifest));

    expect(missing).toEqual([]);
  });

  it('installs before it copies the sources, or the layer cache is pointless', () => {
    const install = dockerfile.indexOf('pnpm install');
    const sources = dockerfile.indexOf('COPY . .');

    expect(install).toBeGreaterThan(0);
    expect(sources).toBeGreaterThan(install);
  });
});
