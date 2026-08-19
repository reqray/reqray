/**
 * Registry of packages Loupe can instrument through loader hooks.
 *
 * Only those that require module interception are listed here. Instrumentations
 * built on `diagnostics_channel` (undici, and therefore built-in `fetch`) work
 * independently of the loader and are not part of the registry.
 */

import type { Instrumentation } from '@loupe/core';
import { instrumentPg } from '@loupe/instrumentation-pg';

/** One package the loader hooks watch for. */
export interface RegistryEntry {
  /** Module name exactly as the application requires it. */
  readonly module: string;
  /** Creates the instrumentation. The supported version range comes from it. */
  create(): Instrumentation;
}

/** Packages instrumented through loader hooks. */
export const registry: readonly RegistryEntry[] = [{ module: 'pg', create: instrumentPg }];
