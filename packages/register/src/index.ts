/**
 * `@reqray/register` — automatic instrumentation.
 *
 * Importing this module installs the loader hooks, so the recommended way to
 * start an application is:
 *
 * ```
 * node --import @reqray/register app.js
 * ```
 *
 * The hooks must be in place before the application loads its drivers: there is
 * no way to intercept a module that was loaded before us — Reqray reports such a
 * case honestly in the startup report.
 *
 * For bundled applications (esbuild, tsup) automatic instrumentation cannot
 * work at all: the bundler resolves imports at build time, so no loader hook
 * ever happens. There, only explicit registration remains — an
 * instrumentation applied by hand to the module the bundle already holds:
 * `instrumentPg().apply(pg)`.
 */

export { register, resetRegistration } from './install.js';
export { type RegistryEntry, registry } from './registry.js';
export {
  enableStandalone,
  resetStandalone,
  type StandaloneOptions,
  standalonePanelUrl,
} from './standalone.js';

import { register } from './install.js';
import { enableStandalone } from './standalone.js';

register();
// Zero lines of code: with no adapter around, the panel comes up by itself.
enableStandalone();
