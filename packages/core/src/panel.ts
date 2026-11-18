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
import type { PanelGate, PanelRequestContext } from './types.js';

export type { PanelGate, PanelRequestContext };

/** Access error. A separate class so it can be caught in a test. */
export class PanelGateError extends Error {
  override readonly name = 'PanelGateError';
}

function gateErrorMessage(mode: string): string {
  return [
    `reqray: panel not mounted — NODE_ENV=${mode} does not count as local development.`,
    'The panel exposes request bodies, headers and SQL, so it must not open without a check.',
    'Set a gate:',
    "  reqray({ panel: { gate: (ctx) => ctx.headers['x-reqray-token'] === process.env.REQRAY_TOKEN } })",
    'Or disable the panel: reqray({ panel: false })',
    "Or, if open access is a deliberate decision: reqray({ panel: { gate: 'open' } })",
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

const LOOPBACK_IP = /^(?:::ffff:)?127\.|^::1$/;
const LOCAL_HOST = /^(?:localhost|[^.]+\.localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?$/i;

/**
 * Whether a request came from this machine, addressed to this machine.
 *
 * What stands in for a gate when none is set. "No gate" is granted to local
 * development, and `NODE_ENV` is a poor witness of that: a server deployed
 * without it reads as a laptop. The peer address is a better one. The `Host`
 * check is for the page in the developer's own browser: a hostile domain
 * re-pointed at 127.0.0.1 arrives from loopback, but still names itself.
 */
export function isLocalRequest(context: PanelRequestContext): boolean {
  if (!context.ip || !LOOPBACK_IP.test(context.ip)) return false;
  const host = context.headers['host'];
  // HTTP/1.0 sends none, and no browser speaks it.
  return host === undefined || (typeof host === 'string' && LOCAL_HOST.test(host));
}

/** Whether a particular request is let into the panel. */
export function isPanelRequestAllowed(
  gate: PanelGate | null,
  context: PanelRequestContext,
): boolean {
  if (!gate) return isLocalRequest(context);
  if (gate === 'open') return true;
  try {
    return gate(context) === true;
  } catch {
    // A gate that throws is treated as a denial: access must never be opened
    // silently.
    return false;
  }
}
