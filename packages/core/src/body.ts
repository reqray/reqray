/**
 * Capturing request and response bodies into the buffer.
 *
 * A body is stored as masked, serialized, size-capped **text**, never as a
 * parsed object tree. Trees are what made retained requests expensive: V8
 * spends several times the JSON's size on object headers and fields, and every
 * record promoted the whole tree into old space. Flat text costs one string.
 *
 * Masking still happens before the buffer write — the text is produced from a
 * masked value, or proven to contain nothing worth masking.
 */

import type { ResolvedRedactOptions } from './config.js';
import { redactValue, sensitivePatternIn } from './redact.js';
import type { RecordedBody } from './types.js';

function cap(text: string, options: ResolvedRedactOptions): RecordedBody {
  if (text.length <= options.maxBodyLength) return { text, truncated: false };
  return { text: text.slice(0, options.maxBodyLength), truncated: true };
}

function serializeMasked(value: unknown, options: ResolvedRedactOptions): RecordedBody | null {
  const masked = redactValue(value, options);
  if (masked === undefined) return null;
  // A masked value that is itself a string is stored as-is: it is already
  // text, and quoting it would only get in the way of reading it.
  const text = typeof masked === 'string' ? masked : JSON.stringify(masked);
  if (text === undefined) return null;
  return cap(text, options);
}

/**
 * Turns a body into the form the buffer stores.
 *
 * Strings that provably contain no sensitive field are stored verbatim — for
 * a typical JSON response this skips parse, mask and re-serialization
 * entirely. Everything else goes through {@link redactValue} first. Never
 * throws; an unserializable body becomes a marker string.
 */
export function recordBody(value: unknown, options: ResolvedRedactOptions): RecordedBody | null {
  try {
    if (value === undefined || value === null) return null;

    if (typeof value === 'string') {
      const hit = sensitivePatternIn(value, options.body);
      if (!hit) return cap(value, options);

      // Fastify hands `onSend` the body already serialized. Masking fields
      // inside JSON is impossible without parsing it.
      const trimmed = value.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return serializeMasked(JSON.parse(trimmed), options);
        } catch {
          // Not JSON after all — withheld below.
        }
      }
      // Text that mentions a sensitive pattern but cannot be parsed — a
      // urlencoded form, prose, broken JSON. Fields cannot be told apart from
      // values in it, so masking is impossible; storing it raw would put
      // `password=hunter2` into the buffer. Withholding loses some innocent
      // bodies, and over-masking is the side this project errs on.
      return { text: `[body withheld: mentions "${hit}" and cannot be masked]`, truncated: false };
    }

    return serializeMasked(value, options);
  } catch {
    return { text: '[unserializable]', truncated: false };
  }
}
