/**
 * What a Redis command means, and which of its arguments may be recorded.
 *
 * Two things are decided here, and both are safety decisions.
 *
 * **How many arguments are a key.** Everything after that is a value, and a
 * value never reaches a span: `SET session:9 <jwt>` is recorded as
 * `SET session:9`. An unknown command is treated as all-value — the same
 * safe-by-default rule the Redis clients use for their own tracing, and the
 * reason `AUTH` cannot leak a password through here.
 *
 * **Which operation it is.** Only a read that returns the value of a named
 * key counts as `get`, because that is the one the duplicate detector acts
 * on, and its advice — "read it once and pass the value down" — has to be
 * true for every command in the set.
 */

import type { CacheOperation } from '@reqray/core';

/** Every argument identifies what is read; none of them is a value. */
const ALL = -1;

interface Shape {
  readonly operation: CacheOperation;
  /** How many leading arguments may be recorded. {@link ALL} for all of them. */
  readonly keys: number;
}

const READ: Shape = { operation: 'get', keys: ALL };
const WRITE: Shape = { operation: 'set', keys: 1 };
const DELETE: Shape = { operation: 'del', keys: ALL };
/** The key may be recorded, but nothing that follows it, and it is no plain read. */
const TAKE: Shape = { operation: 'other', keys: 1 };

/**
 * Commands Reqray understands. Anything missing is `other` with no arguments
 * recorded — visible in the waterfall, never guessed about.
 */
const SHAPES = new Map<string, Shape>([
  // Reads of a value under a key. Their arguments select inside the key —
  // a field, a range, a second key — and are part of what was read.
  ...(
    [
      'GET',
      'GETEX',
      'GETRANGE',
      'MGET',
      'STRLEN',
      'EXISTS',
      'TTL',
      'PTTL',
      'TYPE',
      'HGET',
      'HMGET',
      'HGETALL',
      'HKEYS',
      'HVALS',
      'HLEN',
      'HEXISTS',
      'HSTRLEN',
      'LRANGE',
      'LINDEX',
      'LLEN',
      'SMEMBERS',
      'SCARD',
      'SDIFF',
      'SINTER',
      'SUNION',
      'ZRANGE',
      'ZRANGEBYSCORE',
      'ZREVRANGE',
      'ZREVRANGEBYSCORE',
      'ZCARD',
      'ZCOUNT',
      'BITCOUNT',
      'GETBIT',
    ] as const
  ).map((name) => [name, READ] as const),

  // Writes. Only the key is recorded — what is being stored is the user's data.
  ...(
    [
      'SET',
      'SETNX',
      'SETEX',
      'PSETEX',
      'SETRANGE',
      'SETBIT',
      'GETSET',
      'APPEND',
      'INCR',
      'INCRBY',
      'INCRBYFLOAT',
      'DECR',
      'DECRBY',
      'MSET',
      'MSETNX',
      'HSET',
      'HSETNX',
      'HMSET',
      'HINCRBY',
      'HINCRBYFLOAT',
      'LPUSH',
      'RPUSH',
      'LPUSHX',
      'RPUSHX',
      'LSET',
      'LINSERT',
      'SADD',
      'ZADD',
      'ZINCRBY',
      'EXPIRE',
      'PEXPIRE',
      'EXPIREAT',
      'PEXPIREAT',
      'PERSIST',
      'RESTORE',
    ] as const
  ).map((name) => [name, WRITE] as const),

  // Removals whose every argument is a key or a field name.
  ...(['DEL', 'UNLINK', 'HDEL'] as const).map((name) => [name, DELETE] as const),
  // Removals that name what to remove — `SREM banned <email>`, `LREM q 1
  // <payload>`. The key is enough; the rest is data.
  ...(['GETDEL', 'SREM', 'ZREM', 'LREM'] as const).map(
    (name) => [name, { operation: 'del', keys: 1 } as Shape] as const,
  ),

  // Reads that name a member: `ZSCORE leaderboard <user>`, `SISMEMBER
  // banned <email>`. The member is data, so it is not recorded — and without
  // it two of these cannot be told apart, so they are not offered to the
  // duplicate detector either.
  ...(['SISMEMBER', 'SMISMEMBER', 'ZSCORE', 'ZMSCORE', 'ZRANK', 'ZREVRANK', 'LPOS'] as const).map(
    (name) => [name, TAKE] as const,
  ),

  // Read and remove at once. Calling either half of that a duplicate would be
  // wrong, so they stay out of the detector's way.
  ...(['LPOP', 'RPOP', 'SPOP', 'BLPOP', 'BRPOP'] as const).map((name) => [name, TAKE] as const),
]);

const UNKNOWN: Shape = { operation: 'other', keys: 0 };

/** Operation and recordable key for one command. */
export function shapeOf(command: string): Shape {
  return SHAPES.get(command) ?? UNKNOWN;
}

const MAX_KEY_ARGS = 12;
const MAX_KEY_CHARS = 200;

/**
 * The recordable part of a command's arguments, as one string.
 *
 * Long lists and long keys are cut: a span is a label on a screen, not a copy
 * of the traffic.
 */
export function keyOf(command: string, args: readonly unknown[]): string {
  const { keys } = shapeOf(command);
  if (keys === 0 || args.length === 0) return '';

  const wanted = keys === ALL ? Math.min(args.length, MAX_KEY_ARGS) : Math.min(keys, args.length);
  let key = '';
  for (let index = 0; index < wanted; index++) {
    const argument = args[index];
    // Buffers are how ioredis carries binary keys; `String()` on one is the
    // text it holds, which is what a key normally is.
    key += (index === 0 ? '' : ' ') + String(argument);
    if (key.length > MAX_KEY_CHARS) break;
  }
  // The count keeps two different long lists from looking like one call.
  if (args.length > wanted && keys === ALL) key += ` … +${args.length - wanted}`;
  return key.length > MAX_KEY_CHARS ? `${key.slice(0, MAX_KEY_CHARS)}…` : key;
}

/** Long hexadecimal runs — a uuid, a hash, a session id. */
const HEX_RUN = /[0-9a-f]{8,}/gi;
const DIGITS = /\d+/g;

/**
 * The shape of a key, for grouping stacks in production: `user:42:cart`
 * becomes `user:?:cart`.
 *
 * Without this every key would be its own fingerprint and the callsite budget
 * would be spent on the first request.
 */
export function keyShape(key: string): string {
  return key.replace(HEX_RUN, '?').replace(DIGITS, '?');
}

/** Commands whose reply says, on its own, whether the value was there. */
const PRESENCE = new Set(['GET', 'GETEX', 'GETDEL', 'HGET', 'LINDEX', 'ZSCORE', 'LPOP', 'RPOP']);
/** Commands that answer with a count of what exists. */
const COUNTING = new Set(['EXISTS', 'HEXISTS', 'SISMEMBER']);
/** Commands that read several keys at once, so a reply can be a partial hit. */
const MULTI = new Set(['MGET', 'HMGET']);

/**
 * Whether the reply means the value was in the cache.
 *
 * `null` is the honest answer for everything the reply does not settle — a
 * partial `MGET`, a write, a command that returns a count. The panel prints
 * that as "OK" rather than inventing a miss.
 *
 * The reply here is raw, straight off the wire: strings arrive as buffers and
 * a missing key as `null`, which is exactly what this needs.
 */
export function hitOf(command: string, reply: unknown): boolean | null {
  if (PRESENCE.has(command)) return reply !== null && reply !== undefined;
  if (COUNTING.has(command)) return Number(reply) > 0;
  if (command === 'HGETALL') return Array.isArray(reply) ? reply.length > 0 : null;
  if (MULTI.has(command) && Array.isArray(reply)) {
    const present = reply.filter((value) => value !== null && value !== undefined).length;
    if (present === reply.length) return true;
    if (present === 0) return false;
    // Some of it was there and some was not: neither word is true.
    return null;
  }
  return null;
}
