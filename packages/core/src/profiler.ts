/**
 * The sampling profiler: which function burned the time.
 *
 * `slow_code` can find the stretch of a request nothing accounts for and say
 * what brackets it. It cannot say what ran inside, because nothing was
 * recorded there — that is what makes it a stretch. The answer to "which line
 * is slow" needs samples of the stack, and V8 has had them all along.
 *
 * Off unless asked for. Sampling costs a few microseconds per request, which
 * is nothing; what it is not is free of consequence, because a profile names
 * the application's functions and files. That is a decision somebody makes,
 * not a default somebody discovers.
 *
 * ## How a sample becomes a line of code
 *
 * V8 reports a leaf frame, which for `pbkdf2Sync` or `JSON.parse` is C++ and
 * has no line at all. The caller chain is walked to the first frame inside
 * the project — the same rule `callsite.ts` applies to stack traces, and for
 * the same reason: a file in `node_modules` is not somewhere anybody can go
 * and change something.
 *
 * ## What a sample cannot tell you
 *
 * Two limits, both V8's rather than ours, and both worth knowing before
 * reading a number off this screen.
 *
 * A node carries the line a function is *defined* on, never the line running:
 * Node's profile omits the per-line tick counts the protocol allows for. So
 * the address is a function, and what recovers the rest is naming the call
 * inside it — `pbkdf2Sync`, `processChunkSync` — which is what `inside` is
 * for.
 *
 * And an optimised function that has been inlined into its caller is not on
 * the stack at all: its samples are attributed to the caller. A small helper
 * called in a loop can therefore be reported as the function that calls it.
 * This is why the answer is a share of samples rather than a measurement of a
 * function, and why the hint says where to look rather than what to delete.
 *
 * ## What the clock does
 *
 * Sample times are microseconds on V8's own clock. They are anchored to
 * `performance.now()` at the moment sampling starts, which measures true to
 * within a few milliseconds: against windows of known busy and idle work,
 * 96.8% of samples inside a busy window read as busy and none of those inside
 * an idle one do. Every drain re-anchors, so the error cannot accumulate.
 */

import { Session } from 'node:inspector';
import { relative as pathRelative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isProjectFrame } from './callsite.js';
import type { ResolvedStackOptions } from './config.js';
import { warnOnce } from './logger.js';

/** One place in the code, with how much of the window it held. */
export interface HotFrame {
  /** The function's name, or `(anonymous)`. */
  readonly functionName: string;
  /** Path relative to the project root. */
  readonly relative: string;
  readonly line: number;
  /**
   * What the frame was calling when the sample was taken, or `null`.
   *
   * V8 gives a function's definition line, never the line executing, so the
   * address stops at the function. The callee is what recovers the rest of
   * the answer: `registerUser` is where to look, and `pbkdf2Sync` is what to
   * look for once there.
   */
  readonly inside: string | null;
  readonly samples: number;
  /** Share of the window's busy samples, 0..1. */
  readonly share: number;
}

/** What a stretch of a request was doing. */
export interface HotSpots {
  /** The project's own frames, heaviest first. */
  readonly frames: readonly HotFrame[];
  /**
   * Share of the window's samples that were on a processor, 0..1.
   *
   * The distinction `slow_code` cannot make on its own: near one, the stretch
   * is code running; near zero, it is the process waiting on something — I/O
   * with no instrumentation behind it, or a timer.
   */
  readonly busyShare: number;
  /** Samples in the window, busy and idle together. */
  readonly samples: number;
}

/** A frame the profiler has resolved, kept once and referred to by index. */
interface KnownFrame {
  readonly functionName: string;
  readonly relative: string;
  readonly line: number;
}

/** A sample, as the ring keeps it. */
interface Sample {
  /** `performance.now()` when V8 took it. */
  readonly at: number;
  /** Index into the frame table, or `-1` for a sample that was not running. */
  readonly frame: number;
  /**
   * Index into the callee table, or `-1`.
   *
   * Kept beside the frame rather than folded into it: a function calling
   * three different things is one hot spot, not three, and keying the frame
   * by its callee would split the share that says how hot it is.
   */
  readonly callee: number;
}

/**
 * How many samples are kept.
 *
 * Twenty seconds at a millisecond apart. A request is attributed the moment
 * it finishes, so the ring only has to outlive the gap between a request
 * ending and its record being built — the rest is slack for a process that
 * went quiet.
 */
const MAX_SAMPLES = 20_000;

/** V8's names for samples that are not running anybody's code. */
const NOT_RUNNING = new Set(['(idle)', '(program)', '(root)']);

/** How many frames a hot-spot answer names. */
const TOP_FRAMES = 5;

/**
 * Running samples a window needs before its frames are worth showing.
 *
 * Three samples of somebody else's code in an idle stretch is not a hot spot;
 * it is the sampler catching whatever else the process was doing. Below this
 * the window still reports how busy it was — that much is honest at any
 * count — but names nothing.
 */
const MIN_BUSY_SAMPLES = 10;

export interface ProfilerOptions {
  readonly stack: ResolvedStackOptions;
  /** Microseconds between samples. */
  readonly intervalUs: number;
}

export interface RequestProfiler {
  /**
   * What ran between two moments of `performance.now()`.
   *
   * `null` when the window holds no samples at all, which is not the same as
   * an idle window and must not be shown as one.
   */
  read(from: number, to: number): HotSpots | null;
  stop(): void;
}

interface V8CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

interface V8Node {
  id: number;
  callFrame: V8CallFrame;
  children?: number[];
}

interface V8Profile {
  nodes: V8Node[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/**
 * Starts sampling.
 *
 * Returns `null` when the inspector is unavailable — a runtime built without
 * it, or a process where the session cannot be opened. A panel then simply
 * has no hot spots to show, which is what an unmeasured thing looks like.
 */
export function startProfiler(options: ProfilerOptions): RequestProfiler | null {
  let session: Session;
  try {
    session = new Session();
    session.connect();
  } catch (error) {
    warnOnce('profiler.connect', `the sampling profiler is not available: ${reasonOf(error)}`);
    return null;
  }

  /** Every inspector call answers synchronously, which is why a drain can happen inline. */
  const post = <T>(method: string, params?: object): T | null => {
    let result: T | null = null;
    session.post(method, params as never, (error: Error | null, value: unknown) => {
      if (!error) result = value as T;
    });
    return result;
  };

  const samples: Sample[] = [];
  const frames: KnownFrame[] = [];
  const frameIds = new Map<string, number>();
  const callees: string[] = [];
  const calleeIds = new Map<string, number>();

  /** Callee names are few and repeat constantly; the table keeps them once. */
  function internCallee(name: string): number {
    const known = calleeIds.get(name);
    if (known !== undefined) return known;
    const id = callees.length;
    callees.push(name);
    calleeIds.set(name, id);
    return id;
  }
  let anchor = 0;
  let drainedAt = 0;
  let running = false;

  /** The frame table is shared across drains: the same function recurs constantly. */
  function intern(functionName: string, file: string, line: number): number {
    const key = `${functionName} ${file} ${line}`;
    const known = frameIds.get(key);
    if (known !== undefined) return known;
    const id = frames.length;
    frames.push({
      functionName: functionName || '(anonymous)',
      relative: pathRelative(options.stack.projectRoot, file).replaceAll('\\', '/'),
      line,
    });
    frameIds.set(key, id);
    return id;
  }

  /**
   * The nearest frame in the project, walking outwards from the leaf.
   *
   * A leaf in C++ — `pbkdf2Sync`, `JSON.parse`, a regexp — has no line of its
   * own, and the caller is what somebody can actually go and change.
   */
  function resolve(
    nodeId: number,
    nodes: Map<number, V8Node>,
    parents: Map<number, number>,
  ): { frame: number; callee: number } {
    // What the project frame was calling, kept as the walk passes it. The
    // leaf itself is usually C++ with a name like `run`; the frame directly
    // under the project's own is the one worth naming.
    let callee: string | null = null;
    for (let id: number | undefined = nodeId; id !== undefined; id = parents.get(id)) {
      const frame = nodes.get(id)?.callFrame;
      if (!frame) continue;
      const file = frame.url ? fileOf(frame.url) : null;
      if (!file || !isProjectFrame(file, options.stack)) {
        if (frame.functionName) callee = frame.functionName;
        continue;
      }
      // V8 counts lines from zero; every other number a reader sees is
      // one-based, including the callsites beside this on the same screen.
      return {
        frame: intern(frame.functionName, file, frame.lineNumber + 1),
        callee: callee === null ? -1 : internCallee(callee),
      };
    }
    return { frame: -1, callee: -1 };
  }

  function start(): void {
    post('Profiler.start');
    anchor = performance.now();
    running = true;
  }

  /** Empties V8's buffer into the ring, and starts a fresh one. */
  function drain(): void {
    if (!running) return;
    const stopped = post<{ profile: V8Profile }>('Profiler.stop');
    const profile = stopped?.profile;
    const anchoredAt = anchor;
    start();
    drainedAt = performance.now();
    if (!profile?.samples || !profile.timeDeltas) return;

    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const parents = new Map<number, number>();
    for (const node of profile.nodes) {
      for (const child of node.children ?? []) parents.set(child, node.id);
    }

    let at = profile.startTime;
    for (let i = 0; i < profile.samples.length; i++) {
      at += profile.timeDeltas[i] ?? 0;
      const nodeId = profile.samples[i];
      if (nodeId === undefined) continue;
      const name = nodes.get(nodeId)?.callFrame?.functionName ?? '';
      const resolved = NOT_RUNNING.has(name)
        ? { frame: -1, callee: -1 }
        : resolve(nodeId, nodes, parents);
      samples.push({ at: anchoredAt + (at - profile.startTime) / 1000, ...resolved });
    }
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  }

  try {
    post('Profiler.enable');
    post('Profiler.setSamplingInterval', { interval: options.intervalUs });
    start();
  } catch (error) {
    warnOnce('profiler.start', `the sampling profiler did not start: ${reasonOf(error)}`);
    return null;
  }

  return {
    read(from: number, to: number): HotSpots | null {
      try {
        // A window reaching past the last drain cannot be in the ring yet:
        // its samples are still in V8's buffer, and answering from what is in
        // hand would name whichever function happened to be sampled early.
        // A wrong line of code is worse than half a millisecond.
        //
        // This is also the whole rate limit. Requests finishing together are
        // attributed one after another, so the first read drains and the rest
        // find their windows already covered.
        if (to > drainedAt) drain();

        let total = 0;
        let busy = 0;
        const counts = new Map<number, number>();
        /** Per frame, how often each callee was under it. */
        const inside = new Map<number, Map<number, number>>();
        for (const sample of samples) {
          if (sample.at < from || sample.at > to) continue;
          total++;
          if (sample.frame < 0) continue;
          busy++;
          counts.set(sample.frame, (counts.get(sample.frame) ?? 0) + 1);
          if (sample.callee < 0) continue;
          const seen = inside.get(sample.frame) ?? new Map<number, number>();
          seen.set(sample.callee, (seen.get(sample.callee) ?? 0) + 1);
          inside.set(sample.frame, seen);
        }
        if (total === 0) return null;
        // Busy enough to name something, or the answer is only how busy it was.
        if (busy < MIN_BUSY_SAMPLES) return { frames: [], busyShare: busy / total, samples: total };

        const hot = [...counts]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_FRAMES)
          .map(([id, count]) => {
            const frame = frames[id] as KnownFrame;
            // The call it was mostly in — one name, not a list: the point is
            // what to look for in the function, not an inventory of it.
            const top = [...(inside.get(id) ?? [])].sort((a, b) => b[1] - a[1])[0];
            return {
              ...frame,
              inside: top ? (callees[top[0]] ?? null) : null,
              samples: count,
              share: count / busy,
            };
          });

        return { frames: hot, busyShare: busy / total, samples: total };
      } catch (error) {
        warnOnce('profiler.read', `the sampling profiler stopped reporting: ${reasonOf(error)}`);
        return null;
      }
    },

    stop() {
      try {
        if (running) post('Profiler.stop');
        running = false;
        session.disconnect();
      } catch {
        // A session that will not close is not worth an exception on shutdown.
      }
      samples.length = 0;
      frames.length = 0;
      frameIds.clear();
      callees.length = 0;
      calleeIds.clear();
    },
  };
}

/** A frame's `url` is a file URL, a bare path, or something that is neither. */
function fileOf(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  return url.startsWith('node:') || url === '' ? null : url;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
