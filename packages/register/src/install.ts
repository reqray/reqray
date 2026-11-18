/**
 * Installation of the loader hooks.
 *
 * The priority order is strict and fixed:
 * 1. explicit registration by the user — always wins;
 * 2. loader hooks for packages from the registry, with a semver range check;
 * 3. `diagnostics_channel` where it exists natively — preferred over patching;
 * 4. nothing, but with a clear message at startup.
 *
 * The hooks must be installed before the drivers are loaded, hence the
 * recommended startup: `node --import @reqray/register`.
 */

import { readFileSync } from 'node:fs';
import { createRequire, register as registerLoader } from 'node:module';
import { join, sep } from 'node:path';
import { type Instrumentation, reportInstrumentation, warnOnce } from '@reqray/core';
import { Hook as EsmHook, type HookFn as EsmHookFn } from 'import-in-the-middle';
import { Hook as CjsHook } from 'require-in-the-middle';
import { satisfies } from 'semver';
import { channelInstrumentations, registry } from './registry.js';

const requireFrom = createRequire(import.meta.url);

let installed = false;

/** Version of the loaded module — resolved from the module's own directory. */
function versionAt(basedir: string | undefined): string | undefined {
  if (!basedir) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(basedir, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The module is already in the CJS cache — meaning the application loaded it
 * before us, and a hook on it will never fire.
 *
 * Modules loaded through ESM are not visible this way: the loader does not
 * expose their state. So this is a best-effort check, not a guarantee.
 */
function alreadyLoaded(moduleName: string): boolean {
  const needle = `${sep}node_modules${sep}${moduleName}${sep}`;
  for (const key of Object.keys(requireFrom.cache)) {
    if (key.includes(needle)) return true;
  }
  return false;
}

const LOADED_TOO_LATE_HINT = 'start with `node --import @reqray/register`';

function applyTo(
  instrumentation: Instrumentation,
  exports: unknown,
  version: string | undefined,
): void {
  // Silently patching an unknown major version is not allowed.
  if (version && !satisfies(version, instrumentation.supportedVersions, { loose: true })) {
    reportInstrumentation({
      name: instrumentation.name,
      version,
      captures: instrumentation.captures ?? '',
      ok: false,
      reason: `version outside the supported range ${instrumentation.supportedVersions}`,
      hint: 'update Reqray, or patch the module yourself: `instrumentation.apply(module)` checks no version',
    });
    return;
  }

  try {
    instrumentation.apply(exports);
    reportInstrumentation({
      name: instrumentation.name,
      version,
      captures: instrumentation.captures ?? '',
      ok: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    reportInstrumentation({
      name: instrumentation.name,
      version,
      captures: instrumentation.captures ?? '',
      ok: false,
      reason: `failed to patch: ${reason}`,
    });
    warnOnce(`register.${instrumentation.name}`, `${instrumentation.name}: ${reason}`);
  }
}

/**
 * Installs the loader hooks and activates the instrumentations.
 *
 * Idempotent: a repeated call does nothing. Never throws — the application has
 * to start even if Reqray could not attach.
 *
 * Takes no options. It used to accept a list of instrumentations to register
 * explicitly, and never could honour it: importing this package calls
 * `register()` on the spot, so a later call with a list returned at the first
 * line. Explicit registration is an instrumentation's own `apply` — it needs
 * no loader hook, which is exactly why it works in a bundle:
 * `instrumentPg().apply(pg)`.
 */
export function register(): void {
  if (installed) return;
  installed = true;

  try {
    const wanted = new Map<string, Instrumentation>();
    for (const entry of registry) wanted.set(entry.module, entry.create());

    // diagnostics_channel does not depend on the loader — enable it right away.
    for (const create of channelInstrumentations) {
      const instrumentation = create();
      instrumentation.apply(undefined);
      reportInstrumentation({
        name: instrumentation.name,
        builtin: true,
        captures: instrumentation.captures ?? '',
        ok: true,
      });
    }

    const moduleNames = [...wanted.keys()];
    if (moduleNames.length === 0) return;

    // 4. Packages loaded before us cannot be hooked any more — report that
    //    honestly instead of silently doing nothing.
    for (const name of moduleNames) {
      if (!alreadyLoaded(name)) continue;
      const target = wanted.get(name);
      if (!target) continue;
      wanted.delete(name);
      reportInstrumentation({
        name,
        captures: target.captures ?? '',
        ok: false,
        reason: 'found, but loaded before reqray',
        hint: LOADED_TOO_LATE_HINT,
      });
    }

    const hookable = [...wanted.keys()];
    if (hookable.length === 0) return;

    // The exports object is returned unchanged: instrumentation patches it in
    // place, the module object itself must not be substituted.
    // `import-in-the-middle` declares basedir as `string | void`, so the
    // signature accepts both that and `string | undefined` from the CJS hook.
    const onLoad = <T>(exports: T, name: string, basedir?: string): T => {
      const target = wanted.get(name);
      if (target) applyTo(target, exports, versionAt(basedir));
      return exports;
    };

    // 2. Loader hooks: CJS and ESM are installed independently of each other.
    new CjsHook(hookable, onLoad);

    try {
      registerLoader('import-in-the-middle/hook.mjs', import.meta.url);
      new EsmHook(hookable, onLoad as EsmHookFn);
    } catch (error) {
      // ESM hooks require Reqray to be loaded via `--import`. Without them the
      // CJS interception remains — not a reason to fail.
      const reason = error instanceof Error ? error.message : String(error);
      warnOnce('register.esm', `ESM hooks not installed (${reason}); ${LOADED_TOO_LATE_HINT}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnOnce('register.install', `automatic instrumentation did not attach: ${reason}`);
  }
}

/** Resets the installed flag. Needed by tests. */
export function resetRegistration(): void {
  installed = false;
}
