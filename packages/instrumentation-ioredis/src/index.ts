/**
 * `@reqray/instrumentation-ioredis` — interception of Redis calls made
 * through `ioredis`.
 *
 * **Interception method: prototype patching.** The more preferred option was
 * available and turned out to be insufficient: since 5.11 ioredis publishes a
 * `diagnostics_channel` tracing channel (`ioredis:command`), but the arguments
 * it carries are sanitized before publication, and the sanitizer keeps the key
 * only for the commands on its own list — `HGET`, `HGETALL` and `MGET` arrive
 * with the key replaced by `?`. Keys are the entire point of the cache view
 * and of the duplicate-read detector, and a detector that groups by `?` would
 * report every hash read in a request as one duplicate. So the arguments are
 * read where they are still real, and the value positions are dropped here
 * instead — see `commands.ts`, which decides what may be recorded.
 *
 * `sendCommand` is the single funnel every call goes through: `redis.get()`,
 * `pipeline.exec()` and `multi()` all end there, so one patch covers them and
 * none of them is recorded twice.
 *
 * Cache **values are never recorded**, in any mode and under any option. A
 * span holds the command, the key, how long it took and whether it hit.
 */

import {
  current,
  guarded,
  type Instrumentation,
  patchMethod,
  record,
  resolveCallsite,
  toSpanError,
  unpatchMethod,
} from '@reqray/core';
import { hitOf, keyOf, keyShape, shapeOf } from './commands.js';

/**
 * "This command is already being timed" marker, on the command itself.
 *
 * A command can pass through `sendCommand` more than once — the offline queue
 * is flushed on reconnect, the previous queue is resent — and each pass would
 * otherwise wrap the same callbacks again and record the same call twice. The
 * first pass wins, so the span spans the whole wait, queueing included.
 */
const TRACKED = Symbol.for('reqray.tracked.ioredis');

/**
 * The ioredis command object, in the part this depends on.
 *
 * `resolve` and `reject` are how a command finishes: ioredis hands them to the
 * reply handler, so wrapping them is what makes the end of the call
 * observable. Both are plain closures over the promise, so `this` is irrelevant
 * to them.
 */
interface RedisCommand {
  name?: unknown;
  args?: unknown;
  resolve?: unknown;
  reject?: unknown;
  [TRACKED]?: boolean;
}

function patchSendCommand(proto: any): void {
  patchMethod(
    proto,
    'sendCommand',
    (original: any) =>
      function reqraySendCommand(this: unknown, ...args: any[]) {
        const scope = current();
        // Outside a request nothing is touched: no allocations, no branching
        // beyond this check.
        if (!scope) return original.apply(this, args);

        const command = args[0] as RedisCommand | undefined;
        if (!command || typeof command !== 'object' || command[TRACKED]) {
          return original.apply(this, args);
        }

        const { name, resolve, reject } = command;
        // Without both hooks the end of the call is invisible, and a span with an
        // invented duration would be worse than no span.
        if (
          typeof name !== 'string' ||
          typeof resolve !== 'function' ||
          typeof reject !== 'function'
        ) {
          return original.apply(this, args);
        }

        const upper = name.toUpperCase();
        const key = keyOf(upper, Array.isArray(command.args) ? command.args : []);
        const startTime = performance.now();

        // In development every stack is captured and the fingerprint is unused, so
        // the key is not even shaped; elsewhere it groups the callsite budget.
        const fingerprint =
          scope.options.stack.maxPerFingerprint === Number.POSITIVE_INFINITY
            ? upper
            : `${upper} ${keyShape(key)}`;
        // The wrapper itself is the boundary: otherwise the top frame would be
        // Reqray code instead of the line the application called from.
        const callsite = resolveCallsite(scope, fingerprint, reqraySendCommand);

        command[TRACKED] = true;

        // ioredis settles a command once, but a driver is not a contract: a second
        // call must not turn into a second span.
        let recorded = false;
        const finish = (reply: unknown, error: unknown): void => {
          if (recorded) return;
          recorded = true;
          try {
            record(scope, {
              kind: 'cache',
              operation: shapeOf(upper).operation,
              command: upper,
              key,
              hit: error === undefined ? hitOf(upper, reply) : null,
              duration: performance.now() - startTime,
              startTime,
              callsite,
              error: toSpanError(error),
            });
          } catch {
            // Instrumentation must never break the host command.
          }
        };

        command.resolve = function reqrayResolve(this: unknown, reply: unknown) {
          finish(reply, undefined);
          return (resolve as (value: unknown) => unknown).call(this, reply);
        };
        command.reject = function reqrayReject(this: unknown, error: unknown) {
          finish(undefined, error);
          // The original error is passed on unchanged.
          return (reject as (error: unknown) => unknown).call(this, error);
        };

        return original.apply(this, args);
      },
  );
}

/**
 * Every class in the module that speaks to a server.
 *
 * The module object is both the `Redis` class and a namespace holding it, and
 * which of the two an application receives depends on how it imported: hence
 * the several paths to the same prototype. Patching is idempotent, so
 * arriving twice costs nothing.
 */
function prototypes(exports: any): any[] {
  return [
    exports?.prototype,
    exports?.default?.prototype,
    exports?.Redis?.prototype,
    exports?.Cluster?.prototype,
    exports?.default?.Cluster?.prototype,
  ].filter((proto) => proto && typeof proto.sendCommand === 'function');
}

export function instrumentIoredis(): Instrumentation {
  return {
    name: 'ioredis',
    // `<6` rather than `<7`: ioredis 6 does not exist, and an upper bound
    // that reaches past what has been tested would silently patch an
    // unvalidated major — the exact thing the version check is for.
    supportedVersions: '>=5 <6',
    captures: 'cache',

    apply(exports: any) {
      guarded('ioredis', () => {
        for (const proto of prototypes(exports)) patchSendCommand(proto);
      });
    },

    unapply(exports: any) {
      guarded('ioredis', () => {
        for (const proto of prototypes(exports)) unpatchMethod(proto, 'sendCommand');
      });
    },
  };
}
