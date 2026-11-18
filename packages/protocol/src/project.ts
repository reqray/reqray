/**
 * `GET /api/project` — what Reqray knows about the application it watches.
 *
 * The startup report, served rather than only printed: "why do I not see my
 * SQL" is asked hours after the line has scrolled away.
 *
 * Nothing secret is on the wire here. Environment variables are not read, the
 * panel gate is reported as present or absent rather than by value, and the
 * masking lists are field *names*, which is what makes them safe to show and
 * useful to check.
 */

/** One report line: one package Reqray tried to instrument. */
export interface DiagnosticEntry {
  /** Package name as the application sees it: `fastify`, `pg`, `prisma`. */
  readonly name: string;
  /** Package version, if it could be resolved. */
  readonly version?: string | undefined;
  /** Package is built into Node — no version is printed. */
  readonly builtin?: boolean;
  /** What is captured: "requests", "SQL", "outgoing HTTP". */
  readonly captures: string;
  readonly ok: boolean;
  /** Why it failed. Printed instead of `captures` for failed entries. */
  readonly reason?: string | undefined;
  /** What the user should do to fix it. */
  readonly hint?: string | undefined;
}

/** A connection pool as it stands at the moment it is read. */
export interface PoolReading {
  /** Which driver it belongs to: `pg`, `mysql2`. */
  readonly source: string;
  /** Connections it is allowed to open. */
  readonly max: number;
  /** Connections open at this moment. */
  readonly total: number;
  /** Of those, sitting idle. */
  readonly idle: number;
  /** Acquires queued for a connection right now. */
  readonly waiting: number;
}

/** A reading, with the identity that makes two readings comparable. */
export interface PoolStats extends PoolReading {
  /**
   * Stable for as long as the pool lives.
   *
   * An application with two pools — one for reads, one for writes — shows two
   * rows, and without an id there would be nothing to tell them apart from
   * one reading to the next but their position in a list.
   */
  readonly id: number;
}

/** How long anything kept is kept for. Also the body of `POST /api/retention`. */
export interface RetentionLimits {
  /** How old a request may be, in days. */
  readonly days: number | null;
  /** How much disk everything kept may take, in bytes. */
  readonly maxBytes: number | null;
  /** How many requests to keep. */
  readonly maxRequests: number | null;
}

/**
 * When a request is kept, as the panel reports it.
 *
 * Here rather than in core's config so the runtime and the screen showing it
 * cannot drift: the panel is where somebody checks whether sampling explains a
 * missing request.
 */
export interface SamplingSettings {
  readonly rate: number;
  readonly slowMs: number;
  readonly alwaysOnError: boolean;
  readonly alwaysOnFinding: boolean;
}

/** How much stack is captured, and what counts as project code. @see SamplingSettings */
export interface StackSettings {
  readonly limit: number;
  readonly maxPerFingerprint: number;
  readonly projectRoot: string;
  readonly exclude: readonly string[];
}

/** The application, as its own manifest and repository describe it. */
export interface ProjectApp {
  readonly name: string | null;
  readonly version: string | null;
  /** Directory Reqray treats as project code. */
  readonly root: string;
  readonly git: GitHead | null;
}

/** Which build is running — the first thing asked of a staging panel. */
export interface GitHead {
  readonly branch: string | null;
  readonly sha: string | null;
  /** Uncommitted changes in the working tree. */
  readonly dirty: boolean;
}

/** The process doing the recording. */
export interface ProjectRuntime {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly pid: number;
  /** When the process started, epoch ms. */
  readonly startedAt: number;
  readonly rssMb: number;
  readonly heapUsedMb: number;
}

/** What the store holds right now. Absent for a store that does not say. */
export interface ProjectStorage {
  readonly name: string;
  readonly size: number;
  readonly capacity: number | null;
  readonly evicted: number | null;
  readonly oldestAt: number | null;
  readonly pinned: number | null;
  /** Bytes on disk, for a store that has any. */
  readonly bytes: number | null;
}

/** What the log on disk holds, when there is one. */
export interface ProjectLog {
  readonly dir: string;
  readonly files: number;
  readonly bytes: number;
  /** Local midnight of the oldest day still on disk. */
  readonly oldestAt: number | null;
  readonly written: number;
  readonly dropped: number;
  /** `false` once a write failed: the log is off, the application is not. */
  readonly writing: boolean;
}

/** How long anything kept is kept for, and whether that can be changed here. */
export interface ProjectRetention extends RetentionLimits {
  /** Whether the panel may change it. */
  readonly writable: boolean;
  /** Whether a change outlives the process. */
  readonly remembered: boolean;
}

/** Reqray's own settings, as the project screen shows them. */
export interface ProjectReqray {
  readonly version: string | null;
  readonly mode: string;
  readonly enabled: boolean;
  readonly isLocalDevelopment: boolean;
  readonly bufferSize: number;
  readonly maxSpansPerRequest: number;
  readonly sampling: SamplingSettings;
  readonly replay: boolean;
  readonly explain: boolean;
  readonly blame: boolean;
  readonly logs: boolean;
  readonly collectSqlValues: boolean;
  /** Mount path, and whether access is gated. Never the gate itself. */
  readonly panel: { readonly path: string; readonly gated: boolean } | null;
  readonly redact: { readonly headers: readonly string[]; readonly body: readonly string[] };
  readonly detect: Readonly<Record<string, unknown>>;
  readonly stack: StackSettings;
}

/** Everything the project screen shows. */
export interface ProjectReport {
  readonly app: ProjectApp;
  readonly runtime: ProjectRuntime;
  readonly reqray: ProjectReqray;
  readonly instrumentation: readonly DiagnosticEntry[];
  readonly storage: ProjectStorage | null;
  /** `null` — nothing is written to disk as a log. */
  readonly log: ProjectLog | null;
  /** `null` — every store keeps to its own limits. */
  readonly retention: ProjectRetention | null;
  /**
   * Every connection pool that has served a request, as it stands right now.
   *
   * Read at the moment the screen is opened rather than recorded with a
   * request: a pool's size and its queue are facts about this instant, and a
   * figure captured an hour ago would be a number that looks live and is not.
   */
  readonly pools: readonly PoolStats[];
}
