/**
 * Registry of packages Reqray can instrument.
 *
 * Two lists, because there are two ways in. Packages that need module
 * interception are watched by the loader hooks. Instrumentations built on
 * `diagnostics_channel` — undici, and therefore built-in `fetch` — need no
 * loader at all and are simply switched on.
 */

import type { Instrumentation } from '@reqray/core';
import { instrumentIoredis } from '@reqray/instrumentation-ioredis';
import { instrumentPg } from '@reqray/instrumentation-pg';
import { instrumentUndici } from '@reqray/instrumentation-undici';

/** One package the loader hooks watch for. */
export interface RegistryEntry {
  /** Module name exactly as the application requires it. */
  readonly module: string;
  /**
   * Versions this instrumentation has been tested against.
   *
   * Data, so deciding whether to watch a module does not mean building the
   * thing that would watch it.
   */
  readonly supportedVersions: string;
  /** Creates the instrumentation, once there is a module worth patching. */
  create(): Instrumentation;
}

/** Packages instrumented through loader hooks. */
export const registry: readonly RegistryEntry[] = [
  { module: 'pg', supportedVersions: '>=8 <9', create: instrumentPg },
  { module: 'ioredis', supportedVersions: '>=5 <6', create: instrumentIoredis },
];

/**
 * Instrumentations that need no loader hook.
 *
 * They subscribe to a channel the runtime already publishes, so there is no
 * module to intercept and no version to check — the channel is the contract.
 */
export const channelInstrumentations: readonly (() => Instrumentation)[] = [instrumentUndici];
