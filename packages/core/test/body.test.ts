import { recordBody, resolveOptions } from '@reqray/core';
import { describe, expect, it } from 'vitest';

const { redact } = resolveOptions();
const mask = redact.replaceWith;

describe('recording bodies into the buffer', () => {
  it('no body means no record', () => {
    expect(recordBody(undefined, redact)).toBeNull();
    expect(recordBody(null, redact)).toBeNull();
  });

  it('text without sensitive fields is stored verbatim', () => {
    // The fast path: nothing to mask is proven by a substring scan, so the
    // text must come through byte-for-byte, without a parse/serialize cycle.
    const text = '{"orders":[{"id":1,"total":"12.50"}],"count":1}';
    expect(recordBody(text, redact)).toEqual({
      text,
      truncated: false,
      bytes: Buffer.byteLength(text),
    });
  });

  it('masks a field in serialized JSON', () => {
    const stored = recordBody('{"login":"ada","password":"hunter2"}', redact);
    expect(JSON.parse(stored?.text ?? '')).toEqual({ login: 'ada', password: mask });
  });

  it('finds a field with a separator in its name', () => {
    // `card_number` normalizes to `cardnumber` — both the scan and the masking
    // must agree on that, otherwise the scan would wave the body through.
    const stored = recordBody('{"card_number":"4111111111111111"}', redact);
    expect(JSON.parse(stored?.text ?? '')).toEqual({ card_number: mask });
  });

  it('a pattern in a value, not a field name, leaves the body alone', () => {
    // "tokenizer" trips the coarse scan; masking is by field name and must
    // leave the value alone. The round trip may reformat, not alter.
    const stored = recordBody('{"user":"tokenizer"}', redact);
    expect(JSON.parse(stored?.text ?? '')).toEqual({ user: 'tokenizer' });
  });

  it('plain text without sensitive words is stored as is', () => {
    const text = 'plain text response, nothing to hide';
    expect(recordBody(text, redact)).toEqual({
      text,
      truncated: false,
      bytes: Buffer.byteLength(text),
    });
  });

  it('an urlencoded body with a password never reaches the buffer raw', () => {
    // Fields cannot be told apart from values in unparseable text, so the
    // body is withheld entirely — over-masking is the side to err on.
    const stored = recordBody('login=ada&password=hunter2', redact);
    expect(stored?.text).not.toContain('hunter2');
    expect(stored?.text).toContain('password');
  });

  it('an already parsed body is serialized with masking', () => {
    // Express hands bodies over as objects, not strings.
    const stored = recordBody({ login: 'ada', token: 'abc' }, redact);
    expect(stored?.text).toBe(JSON.stringify({ login: 'ada', token: mask }));
  });

  it('truncates text at the cap and marks it', () => {
    const options = { ...redact, maxBodyLength: 10 };
    const stored = recordBody('0123456789ABCDEF', options);
    // The size is of the body, not of the cap: a panel that reports its own
    // limit back as a measurement is reporting its settings.
    expect(stored).toEqual({ text: '0123456789', truncated: true, bytes: 16 });
  });

  it('a binary body becomes a marker, not megabytes', () => {
    const stored = recordBody(Buffer.alloc(1024), redact);
    expect(stored?.text).toBe('[binary 1024 bytes]');
  });

  it('broken JSON with a sensitive word is not stored raw', () => {
    const stored = recordBody('{"password": "hunter2', redact);
    expect(stored?.text).not.toContain('hunter2');
  });
});

describe('a stream is not a body', () => {
  it('records nothing for a Node stream or a web stream', async () => {
    // Walking one would serialize its internals: an incoming request carries
    // `rawHeaders`, authorization and cookies included, under a key no
    // masking pattern matches.
    const { Readable } = await import('node:stream');
    const node = Object.assign(Readable.from(['x']), {
      rawHeaders: ['authorization', 'Bearer secret-value'],
    });

    expect(recordBody(node, redact)).toBeNull();
    expect(recordBody(new ReadableStream(), redact)).toBeNull();
  });
});
