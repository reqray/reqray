import {
  isSensitiveField,
  redactHeaders,
  redactQuery,
  redactValue,
  resolveOptions,
} from '@reqray/core';
import { describe, expect, it } from 'vitest';

const { redact } = resolveOptions();
const mask = redact.replaceWith;

describe('header redaction', () => {
  it('covers the default list', () => {
    const out = redactHeaders(
      {
        authorization: 'Bearer eyJhbGciOi',
        cookie: 'sid=abc',
        'set-cookie': ['sid=abc', 'theme=dark'],
        'content-type': 'application/json',
      },
      redact,
    );

    expect(out).toEqual({
      authorization: mask,
      cookie: mask,
      'set-cookie': mask,
      'content-type': 'application/json',
    });
  });

  it('ignores case and separators', () => {
    const out = redactHeaders({ Authorization: 'Bearer x', Set_Cookie: 'sid=abc' }, redact);
    expect(out['Authorization']).toBe(mask);
    expect(out['Set_Cookie']).toBe(mask);
  });

  it('the default header list is not widened with body patterns', () => {
    // `token` is redacted in bodies, but the `x-api-token` header is up to the
    // user to add: the documented list must not be silently widened.
    const out = redactHeaders({ 'x-api-token': 'abc' }, redact);
    expect(out['x-api-token']).toBe('abc');
  });

  it('joins multi-value headers and skips empty ones', () => {
    const out = redactHeaders(
      { accept: ['a', 'b'], vary: undefined, 'content-length': 42 },
      redact,
    );
    expect(out['accept']).toBe('a, b');
    expect(out['content-length']).toBe('42');
    expect(out).not.toHaveProperty('vary');
  });

  it('extends with a user list without losing the default one', () => {
    const custom = resolveOptions({ redact: { headers: ['x-internal'] } }).redact;
    const out = redactHeaders({ 'x-internal': 'v', cookie: 'sid=1', accept: 'json' }, custom);
    expect(out['x-internal']).toBe(mask);
    expect(out['cookie']).toBe(mask);
    expect(out['accept']).toBe('json');
  });
});

describe('body redaction', () => {
  it('covers nested sensitive fields at any depth', () => {
    const body = {
      email: 'a@b.c',
      password: 'hunter2',
      profile: { cardNumber: '4111111111111111', name: 'Ada' },
      sessions: [{ token: 'abc', ip: '10.0.0.1' }],
    };

    expect(redactValue(body, redact)).toEqual({
      email: 'a@b.c',
      password: mask,
      profile: { cardNumber: mask, name: 'Ada' },
      sessions: [{ token: mask, ip: '10.0.0.1' }],
    });
  });

  it('covers fields containing a pattern as a substring', () => {
    const out = redactValue(
      { accessToken: 'a', refresh_token: 'b', tokenizer: 'c' },
      redact,
    ) as Record<string, unknown>;
    expect(out['accessToken']).toBe(mask);
    expect(out['refresh_token']).toBe(mask);
    expect(out['tokenizer']).toBe(mask);
  });

  it('does not mutate the original value', () => {
    const body = { password: 'hunter2' };
    redactValue(body, redact);
    expect(body.password).toBe('hunter2');
  });

  it('survives a cycle', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;

    expect(redactValue(node, redact)).toEqual({ name: 'root', self: '[circular]' });
  });

  it('a repeated reference without a cycle is not treated as one', () => {
    const shared = { a: 1 };
    expect(redactValue({ left: shared, right: shared }, redact)).toEqual({
      left: { a: 1 },
      right: { a: 1 },
    });
  });

  it('cuts overly deep nesting', () => {
    const options = resolveOptions({ redact: { maxDepth: 2 } }).redact;
    const deep = { l1: { l2: { l3: { l4: 'bottom' } } } };
    expect(redactValue(deep, options)).toEqual({ l1: { l2: { l3: '[depth limit]' } } });
  });

  it('truncates long strings and large arrays', () => {
    const options = resolveOptions({
      redact: { maxStringLength: 5, maxArrayLength: 2 },
    }).redact;

    expect(redactValue('0123456789', options)).toBe('01234… [+5 chars]');
    expect(redactValue([1, 2, 3, 4], options)).toEqual([1, 2, '… [+2 items]']);
  });

  it('reduces awkward values to something displayable', () => {
    const out = redactValue(
      {
        when: new Date('2026-08-18T10:00:00.000Z'),
        blob: Buffer.from('hello'),
        big: 10n,
        fn: () => 1,
        nan: Number.NaN,
        boom: new Error('crashed'),
      },
      redact,
    ) as Record<string, unknown>;

    expect(out['when']).toBe('2026-08-18T10:00:00.000Z');
    expect(out['blob']).toBe('[binary 5 bytes]');
    expect(out['big']).toBe('10n');
    expect(out['fn']).toBeUndefined();
    expect(out['nan']).toBe('NaN');
    expect(out['boom']).toEqual({ name: 'Error', message: 'crashed' });
  });

  it('masks Map values by key', () => {
    const map = new Map<string, unknown>([
      ['password', 'hunter2'],
      ['login', 'ada'],
    ]);
    expect(redactValue(map, redact)).toEqual({ password: mask, login: 'ada' });
  });

  it('one breaking field does not cost the whole body', () => {
    const hostile = {
      ok: 'visible',
      get boom(): never {
        throw new Error('cannot be read');
      },
    };
    expect(redactValue(hostile, redact)).toEqual({ ok: 'visible', boom: '[unreadable]' });
  });
});

describe('isSensitiveField', () => {
  it('compares by normalized name', () => {
    expect(isSensitiveField('Card_Number', redact.body)).toBe(true);
    expect(isSensitiveField('card-number', redact.body)).toBe(true);
    expect(isSensitiveField('cardholder', redact.body)).toBe(false);
  });
});

describe('redactQuery', () => {
  it('masks by parameter name, in a bare query and in a whole URL', () => {
    expect(redactQuery('a=1&token=abc', redact)).toBe('a=1&token=[redacted]');
    expect(redactQuery('https://api.example.com/v1/x?access_token=abc&n=2#top', redact)).toBe(
      'https://api.example.com/v1/x?access_token=[redacted]&n=2#top',
    );
  });

  it('masks an API key and a presigned signature without being told to', () => {
    expect(redactQuery('api_key=abc&page=2', redact)).toBe('api_key=[redacted]&page=2');
    expect(
      redactQuery('https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Signature=abc', redact),
    ).toBe('https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Signature=[redacted]');
    expect(redactValue({ card: { cvv: '123', apiKey: 'k' } }, redact)).toEqual({
      card: { cvv: mask, apiKey: mask },
    });
  });

  it('leaves alone what holds nothing to mask', () => {
    // Including a path that merely mentions a pattern: masking is by
    // parameter name, and a path segment is not one.
    expect(redactQuery('page=2&sort=asc', redact)).toBe('page=2&sort=asc');
    expect(redactQuery('https://auth.example.com/oauth/token', redact)).toBe(
      'https://auth.example.com/oauth/token',
    );
    expect(redactQuery('q=tokenizer', redact)).toBe('q=tokenizer');
  });
});
