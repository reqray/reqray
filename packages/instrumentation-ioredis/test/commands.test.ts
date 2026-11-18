/**
 * The command table decides what leaves the process. Its rules are worth more
 * scrutiny than the patch around them: a mistake here writes somebody's
 * session token into a panel, or makes the duplicate detector cry wolf.
 */

import { describe, expect, it } from 'vitest';
import { hitOf, keyOf, keyShape, shapeOf } from '../src/commands.js';

describe('what may be recorded', () => {
  it('records the key of a read, arguments and all', () => {
    expect(keyOf('GET', ['user:1'])).toBe('user:1');
    expect(keyOf('HGET', ['user:1', 'email'])).toBe('user:1 email');
    expect(keyOf('MGET', ['user:1', 'user:2'])).toBe('user:1 user:2');
    expect(keyOf('LRANGE', ['feed:1', '0', '20'])).toBe('feed:1 0 20');
  });

  it('records the key of a write and never the value', () => {
    expect(keyOf('SET', ['session:9', 'eyJhbGciOi.secret.token'])).toBe('session:9');
    expect(keyOf('SETEX', ['session:9', '3600', 'secret'])).toBe('session:9');
    expect(keyOf('HSET', ['user:1', 'password', 'hunter2'])).toBe('user:1');
    expect(keyOf('MSET', ['a', 'first', 'b', 'second'])).toBe('a');
  });

  it('records nothing at all for a command it does not know', () => {
    // Safe by default: this is what keeps AUTH out of the panel, and any
    // custom or future command with it.
    expect(keyOf('AUTH', ['admin', 'hunter2'])).toBe('');
    expect(keyOf('HELLO', ['3', 'AUTH', 'admin', 'hunter2'])).toBe('');
    expect(keyOf('EVAL', ['return redis.call("get", KEYS[1])', '1', 'k'])).toBe('');
    expect(shapeOf('AUTH').operation).toBe('other');
  });

  it('keeps out the member a read names, because the member is data', () => {
    expect(keyOf('SISMEMBER', ['banned:emails', 'ada@example.com'])).toBe('banned:emails');
    expect(keyOf('ZSCORE', ['leaderboard', 'ada@example.com'])).toBe('leaderboard');
    expect(keyOf('SREM', ['banned:emails', 'ada@example.com'])).toBe('banned:emails');
    expect(keyOf('LREM', ['queue', '1', '{"card":"4111111111111111"}'])).toBe('queue');
  });

  it('cuts a long key and a long list of keys', () => {
    expect(keyOf('GET', [`user:${'x'.repeat(400)}`])).toHaveLength(201);
    expect(keyOf('GET', [`user:${'x'.repeat(400)}`]).endsWith('…')).toBe(true);

    const many = keyOf(
      'MGET',
      Array.from({ length: 30 }, (_, index) => `user:${index}`),
    );
    // Two lists that share a beginning must not end up looking like one call.
    expect(many).toContain('+18');
  });
});

describe('what a command means', () => {
  it('calls a value read a read', () => {
    expect(shapeOf('GET').operation).toBe('get');
    expect(shapeOf('HGETALL').operation).toBe('get');
    expect(shapeOf('EXISTS').operation).toBe('get');
  });

  it('calls a write a write and a removal a removal', () => {
    expect(shapeOf('SET').operation).toBe('set');
    expect(shapeOf('EXPIRE').operation).toBe('set');
    expect(shapeOf('DEL').operation).toBe('del');
    expect(shapeOf('UNLINK').operation).toBe('del');
  });

  it('will not call a read-and-remove a read', () => {
    // "Read it once and pass the value down" is wrong advice for a command
    // that also empties what it read.
    expect(shapeOf('LPOP').operation).toBe('other');
    expect(shapeOf('SPOP').operation).toBe('other');
    expect(shapeOf('GETDEL').operation).toBe('del');
  });

  it('will not call a read whose member it cannot record a read', () => {
    // Without the member two of these look identical, and the detector would
    // report a duplicate that never happened.
    expect(shapeOf('SISMEMBER').operation).toBe('other');
    expect(shapeOf('ZSCORE').operation).toBe('other');
  });
});

describe('hit or miss', () => {
  it('reads presence off a single reply', () => {
    expect(hitOf('GET', Buffer.from('value'))).toBe(true);
    expect(hitOf('GET', null)).toBe(false);
    expect(hitOf('HGET', null)).toBe(false);
  });

  it('reads presence off a count', () => {
    expect(hitOf('EXISTS', 1)).toBe(true);
    expect(hitOf('EXISTS', 0)).toBe(false);
    expect(hitOf('HEXISTS', 0)).toBe(false);
  });

  it('reads an empty hash as a miss', () => {
    expect(hitOf('HGETALL', [])).toBe(false);
    expect(hitOf('HGETALL', ['email', 'ada@example.com'])).toBe(true);
  });

  it('says nothing when half of a multi-key read was there', () => {
    expect(hitOf('MGET', ['a', 'b'])).toBe(true);
    expect(hitOf('MGET', [null, null])).toBe(false);
    // Neither "hit" nor "miss" is true of this one.
    expect(hitOf('MGET', ['a', null])).toBeNull();
  });

  it('says nothing about replies that do not answer the question', () => {
    expect(hitOf('SET', 'OK')).toBeNull();
    expect(hitOf('TTL', 42)).toBeNull();
    expect(hitOf('EVAL', 1)).toBeNull();
  });
});

describe('the shape of a key', () => {
  it('collapses the parts that vary per request', () => {
    expect(keyShape('user:42:cart')).toBe('user:?:cart');
    expect(keyShape('session:9f8a7b6c5d4e3f21')).toBe('session:?');
  });

  it('leaves a key with nothing variable in it alone', () => {
    expect(keyShape('settings')).toBe('settings');
  });
});
