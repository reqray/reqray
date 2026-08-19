/**
 * Panel access.
 *
 * The panel exposes request bodies, headers and SQL. It is therefore never
 * mounted silently where the process may be reachable from outside: with no
 * explicit gate the application fails at startup with a clear error.
 *
 * Local development means `NODE_ENV` equal to `development`, `test` or unset
 * altogether — the same reading Express itself uses. Everything else
 * (`staging`, `production`, any custom value) requires a gate.
 */

import type { ResolvedOptions } from './config.js';

/** What is known about a panel request when access is checked. */
export interface PanelRequestContext {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip: string | null;
}

/**
 * Who is allowed into the panel.
 *
 * `'open'` is a deliberate "let everyone in": you can write it, but you can
 * never get it by default.
 */
export type PanelGate = 'open' | ((context: PanelRequestContext) => boolean);

/** Access error. A separate class so it can be caught in a test. */
export class PanelGateError extends Error {
  override readonly name = 'PanelGateError';
}

function gateErrorMessage(mode: string): string {
  return [
    `loupe: panel not mounted — NODE_ENV=${mode} does not count as local development.`,
    'The panel exposes request bodies, headers and SQL, so it must not open without a check.',
    'Set a gate:',
    "  loupe({ panel: { gate: (ctx) => ctx.headers['x-loupe-token'] === process.env.LOUPE_TOKEN } })",
    'Or disable the panel: loupe({ panel: false })',
    "Or, if open access is a deliberate decision: loupe({ panel: { gate: 'open' } })",
  ].join('\n');
}

/**
 * Checks that the panel may be mounted. Throws {@link PanelGateError} if a
 * gate is required but not set.
 */
export function assertPanelAllowed(options: ResolvedOptions): void {
  const panel = options.panel;
  if (!panel) return;
  if (panel.gate) return;
  if (options.isLocalDevelopment) return;

  throw new PanelGateError(gateErrorMessage(process.env['NODE_ENV'] ?? 'unset'));
}

/** Whether a particular request is let into the panel. */
export function isPanelRequestAllowed(
  gate: PanelGate | null,
  context: PanelRequestContext,
): boolean {
  if (!gate) return true;
  if (gate === 'open') return true;
  try {
    return gate(context) === true;
  } catch {
    // A gate that throws is treated as a denial: access must never be opened
    // silently.
    return false;
  }
}
