/**
 * What Reqray knows about the application it is watching.
 *
 * The startup report — what was instrumented and what was not — has so far
 * existed only in the terminal, printed once. That is the wrong place for it:
 * "why do I not see my SQL" is a question asked hours later, by which point
 * the line has scrolled away, and in a container it was never on screen at
 * all. So the same facts are served to the panel, together with the settings
 * that decide what gets recorded and the shape of the process doing the
 * recording.
 *
 * Nothing secret goes in here. Environment variables are not read, the panel
 * gate is reported as present or absent rather than by value, and the masking
 * lists are field *names*, which is what makes them safe to show and useful
 * to check.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  GitHead,
  ProjectApp,
  ProjectLog,
  ProjectReport,
  ProjectRetention,
  ProjectRuntime,
  ProjectStorage,
} from '@reqray/protocol';
import type { ResolvedOptions } from '../config.js';
import { getDiagnostics } from '../diagnostics.js';
import { poolStats } from '../pools.js';

export type {
  GitHead,
  ProjectApp,
  ProjectLog,
  ProjectReport,
  ProjectRetention,
  ProjectRuntime,
  ProjectStorage,
};

/** The log's own account of itself, or `null` when there is no log. */
export function logOf(options: ResolvedOptions): ProjectLog | null {
  const log = options.requestLog;
  if (!log) return null;
  try {
    return { dir: log.dir, ...log.stats() };
  } catch {
    // A log that cannot describe itself is still not the panel's problem.
    return null;
  }
}

/** The retention policy as the panel sees it. */
export function retentionOf(options: ResolvedOptions): ProjectRetention | null {
  const policy = options.retention;
  if (!policy) return null;
  return {
    ...policy.current(),
    writable: policy.writable,
    remembered: policy.file !== null,
  };
}

function readManifest(directory: string): { name?: unknown; version?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
  } catch {
    // No manifest where the project root points: unusual, not an error.
    return null;
  }
}

/** Version of `@reqray/core` itself — the first thing a bug report needs. */
function reqrayVersion(): string | null {
  try {
    const manifest = createRequire(import.meta.url).resolve('@reqray/core/package.json');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    // Running from source, or packaged without the manifest.
    return null;
  }
}

function git(args: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim()),
    );
  });
}

interface CachedHead {
  readonly at: number;
  readonly head: GitHead | null;
}

let cached: CachedHead | null = null;
/** Short enough to survive a branch switch, long enough to cost nothing. */
const GIT_TTL_MS = 10_000;

/**
 * The commit the running code came from.
 *
 * `null` for anything that is not a git checkout — a container built from a
 * tarball, an installed package, a machine without git. All ordinary, none of
 * them an error.
 */
export async function gitHead(cwd: string, now = Date.now()): Promise<GitHead | null> {
  if (cached && now - cached.at < GIT_TTL_MS) return cached.head;

  const [branch, sha, status] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['rev-parse', '--short', 'HEAD'], cwd),
    git(['status', '--porcelain'], cwd),
  ]);

  const head = branch === null && sha === null ? null : { branch, sha, dirty: status !== '' };
  cached = { at: now, head };
  return head;
}

/** Forgets the cached commit. Needed by tests. */
export function clearGitHead(): void {
  cached = null;
}

/** Anything a store may choose to report about itself. */
interface StoreStats {
  size?: unknown;
  capacity?: unknown;
  evicted?: unknown;
  oldestAt?: unknown;
  pinned?: unknown;
  bytes?: unknown;
}

const numberOr = (value: unknown, fallback: number | null): number | null =>
  typeof value === 'number' ? value : fallback;

/**
 * What the store will say about itself.
 *
 * `stats()` is not part of the panel's contract — the memory ring and the
 * SQLite history both have one, a third-party store need not — so everything
 * here is optional and nothing is assumed.
 */
export function storageOf(source: unknown): ProjectStorage | null {
  const store = source as { name?: unknown; stats?: () => StoreStats };
  if (typeof store?.stats !== 'function') return null;
  try {
    const stats = store.stats();
    return {
      name: typeof store.name === 'string' ? store.name : 'unknown',
      size: numberOr(stats.size, 0) ?? 0,
      capacity: numberOr(stats.capacity, null),
      evicted: numberOr(stats.evicted, null),
      oldestAt: numberOr(stats.oldestAt, null),
      pinned: numberOr(stats.pinned, null),
      bytes: numberOr(stats.bytes, null),
    };
  } catch {
    return null;
  }
}

/** Collects everything the project screen shows. */
export async function projectReport(
  options: ResolvedOptions,
  source: unknown,
): Promise<ProjectReport> {
  const root = options.stack.projectRoot;
  const manifest = readManifest(root);
  const memory = process.memoryUsage();

  return {
    app: {
      name: typeof manifest?.name === 'string' ? manifest.name : null,
      version: typeof manifest?.version === 'string' ? manifest.version : null,
      root,
      git: await gitHead(root),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      startedAt: Date.now() - Math.round(process.uptime() * 1000),
      rssMb: memory.rss / 1024 / 1024,
      heapUsedMb: memory.heapUsed / 1024 / 1024,
    },
    reqray: {
      version: reqrayVersion(),
      mode: options.mode,
      enabled: options.enabled,
      isLocalDevelopment: options.isLocalDevelopment,
      bufferSize: options.bufferSize,
      maxSpansPerRequest: options.maxSpansPerRequest,
      sampling: options.sampling,
      replay: options.replay,
      explain: options.explain,
      blame: options.blame,
      logs: options.logs,
      collectSqlValues: options.collectSqlValues,
      // The gate is a function or a rule; either way it is a credential, and
      // the panel only needs to know that one is in place.
      panel: options.panel
        ? { path: options.panel.path, gated: options.panel.gate !== null }
        : null,
      redact: { headers: options.redact.headers, body: options.redact.body },
      detect: options.detect as unknown as Readonly<Record<string, unknown>>,
      stack: options.stack,
    },
    instrumentation: getDiagnostics(),
    storage: storageOf(source),
    log: logOf(options),
    retention: retentionOf(options),
    pools: poolStats(),
  };
}
