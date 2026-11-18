/**
 * The version in the header line.
 *
 * Read from the manifest rather than baked in by the build, so a copy running
 * from source says the same thing as one installed from npm.
 */

import { readFileSync } from 'node:fs';

let cached: string | null = null;

/** This package's version, or `0.0.0` if the manifest cannot be read. */
export function cliVersion(): string {
  if (cached !== null) return cached;
  try {
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    cached = (JSON.parse(manifest) as { version?: string }).version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
