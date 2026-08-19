/**
 * Masking of sensitive data.
 *
 * Runs **before** the buffer write, not at display time: nothing that cannot
 * be shown may reach the buffer. Long strings and large arrays are trimmed
 * here as well — the buffer lives in someone else's application memory.
 */

import { normalizeFieldName, type ResolvedRedactOptions } from './config.js';

const CIRCULAR = '[circular]';
const DEPTH_LIMIT = '[depth limit]';
const UNREADABLE = '[unreadable]';

/**
 * Whether a field name matches one of the masking patterns.
 *
 * Matching is substring containment against the normalized name: the pattern
 * `token` covers `accessToken`, `x-api-token` and `refresh_token`. Over-masking
 * is safer than letting a password through into the buffer.
 */
export function isSensitiveField(name: string, patterns: readonly string[]): boolean {
  const normalized = normalizeFieldName(name);
  for (const pattern of patterns) {
    if (normalized.includes(pattern)) return true;
  }
  return false;
}

/** Truncates with an honest marker of how much was cut. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}… [+${value.length - maxLength} chars]`;
}

/** Mirrors `normalizeFieldName` over a whole text: no separators, lower case. */
function normalizeText(text: string): string {
  return text.replace(/[-_ .]/g, '').toLowerCase();
}

/**
 * The first sensitive pattern occurring anywhere in the text, or `null`.
 *
 * The check is deliberately coarse: a hit anywhere — in a key, a value or a
 * word like "tokens" — is a reason to treat the text carefully. A miss is a
 * proof: patterns match normalized field names by substring, so a text whose
 * normalized form contains no pattern cannot contain a matching field either.
 */
export function sensitivePatternIn(text: string, patterns: readonly string[]): string | null {
  const normalized = normalizeText(text);
  for (const pattern of patterns) {
    if (normalized.includes(pattern)) return pattern;
  }
  return null;
}

function walk(
  value: unknown,
  options: ResolvedRedactOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return truncate(value, options.maxStringLength);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value}n`;
    case 'function':
    case 'symbol':
      return undefined;
  }

  if (depth > options.maxDepth) return DEPTH_LIMIT;

  const object = value as object;
  if (seen.has(object)) return CIRCULAR;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message, options.maxStringLength) };
  }
  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;

  seen.add(object);
  try {
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, options.maxArrayLength);
      const out: unknown[] = [];
      for (let i = 0; i < limit; i++) out.push(walk(value[i], options, depth + 1, seen));
      if (value.length > limit) out.push(`… [+${value.length - limit} items]`);
      return out;
    }

    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value) {
        const name = String(key);
        out[name] = isSensitiveField(name, options.body)
          ? options.replaceWith
          : walk(item, options, depth + 1, seen);
      }
      return out;
    }

    if (value instanceof Set) {
      return walk([...value], options, depth, seen);
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (isSensitiveField(key, options.body)) {
        out[key] = options.replaceWith;
        continue;
      }
      // Reading a property may hit a getter with side effects that throws.
      // One broken field must not cost the whole body.
      let item: unknown;
      try {
        item = (value as Record<string, unknown>)[key];
      } catch {
        out[key] = UNREADABLE;
        continue;
      }
      const masked = walk(item, options, depth + 1, seen);
      if (masked !== undefined || item === undefined) out[key] = masked;
    }
    return out;
  } finally {
    // Unmark on the way out: the same object met twice in different branches
    // is not a cycle.
    seen.delete(object);
  }
}

/**
 * Returns a copy of the value with sensitive fields masked.
 *
 * The original is left untouched. Cycles, excessive nesting, long strings and
 * large arrays are trimmed according to the options.
 */
export function redactValue(value: unknown, options: ResolvedRedactOptions): unknown {
  try {
    return walk(value, options, 0, new WeakSet());
  } catch {
    // Masking has no right to break recording the request.
    return '[unserializable]';
  }
}

/**
 * Flattens headers into `name → value` pairs with masking applied.
 *
 * Arrays of values (several `set-cookie`) are joined with commas — the panel
 * shows headers as text.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | number | undefined>>,
  options: ResolvedRedactOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers)) {
    const raw = headers[key];
    if (raw === undefined) continue;
    if (isSensitiveField(key, options.headers)) {
      out[key] = options.replaceWith;
      continue;
    }
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
    out[key] = truncate(value, options.maxStringLength);
  }
  return out;
}
