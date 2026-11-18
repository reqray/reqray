/**
 * What every command needs before it can do anything.
 *
 * The address of the panel, the token to get past its gate, and how this run
 * draws. Resolved once, in one place, so `watch` and `show` cannot disagree
 * about where the collector is or whether the terminal takes colour.
 */

import { boolFlag, type FlagSpec, type ParsedArgs, stringFlag } from './args.js';
import { UsageError } from './errors.js';
import { resolveTheme, type Theme } from './render/theme.js';

/**
 * Where a locally running application serves its panel.
 *
 * A collector on another machine is an ordinary URL: forward its port over
 * ssh and `--url http://localhost:4300/_reqray` needs nothing else.
 */
export const DEFAULT_URL = 'http://localhost:3000/_reqray';

/** The flags every command takes. */
export const GLOBAL_FLAGS: FlagSpec = {
  url: 'string',
  token: 'string',
  color: 'string',
  'no-color': 'boolean',
  ascii: 'boolean',
  verbose: 'boolean',
  help: 'boolean',
  version: 'boolean',
};

/** Settings shared by every command. */
export interface Globals {
  readonly url: string;
  readonly token: string | null;
  readonly verbose: boolean;
  readonly theme: Theme;
}

/** The environment and streams a run reads. Swapped out in tests. */
export interface Environment {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: { isTTY?: boolean; columns?: number };
}

/**
 * Normalizes a panel address.
 *
 * A bare origin gets the default mount point: someone who types the address
 * of their application means the panel on it, and answering that with a 404
 * from the application's own router would be a puzzle rather than an error.
 */
export function normalizeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError(`--url wants an address, not "${raw}"`, [
      '',
      `  for example    ${DEFAULT_URL}`,
    ]);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`--url speaks http or https, not ${parsed.protocol.replace(':', '')}`);
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path === '' ? '/_reqray' : path}`;
}

/** Resolves everything shared, from the flags and the environment. */
export function resolveGlobals(args: ParsedArgs, runtime: Environment): Globals {
  const url = normalizeUrl(stringFlag(args, 'url') ?? runtime.env['REQRAY_URL'] ?? DEFAULT_URL);
  const token = stringFlag(args, 'token') ?? runtime.env['REQRAY_TOKEN'] ?? null;

  const asked = stringFlag(args, 'color');
  if (asked !== null && asked !== 'always' && asked !== 'never' && asked !== 'auto') {
    throw new UsageError(`--color takes auto, always or never, not "${asked}"`);
  }
  const color = boolFlag(args, 'no-color') ? 'never' : ((asked ?? 'auto') as 'auto');

  return {
    url,
    token,
    verbose: boolFlag(args, 'verbose'),
    theme: resolveTheme(runtime.env, runtime.stdout, { color, ascii: boolFlag(args, 'ascii') }),
  };
}
