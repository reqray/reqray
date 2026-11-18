/**
 * SQL normalization.
 *
 * The fingerprint is what repeats are grouped by: without it `SELECT * FROM
 * users WHERE id = 1` and `... id = 2` count as different queries and the N+1
 * detector finds nothing.
 *
 * Called on the hot path for every database query, hence a single-pass
 * character scanner (rather than a chain of regexes) plus a cache keyed by the
 * source string: the same SQL arrives thousands of times.
 */

/** SQL statement type. Detectors only look at `select`. */
export type SqlOperation = 'select' | 'insert' | 'update' | 'delete' | 'other';

import { globalSlot, TwoGenerationCache } from './state.js';

/**
 * Cache cap.
 *
 * Applications that build SQL dynamically can produce an unbounded set of
 * strings, so both caches have a ceiling. See {@link TwoGenerationCache} for
 * why hitting the ceiling is not a `clear()`: an application sitting just over
 * the limit would otherwise throw away its hottest entries with its coldest
 * and re-scan every statement until the cache refilled.
 */
const CACHE_LIMIT = 5_000;

const fingerprints = globalSlot(
  'sql.fingerprints',
  () => new TwoGenerationCache<string, string>(CACHE_LIMIT),
);

const operations = globalSlot(
  'sql.operations',
  () => new TwoGenerationCache<string, SqlOperation>(CACHE_LIMIT),
);

const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_QUOTE = 39; // '
const CHAR_DQUOTE = 34; // "
const CHAR_BACKTICK = 96;
const CHAR_BACKSLASH = 92;
const CHAR_DASH = 45; // -
const CHAR_SLASH = 47; // /
const CHAR_STAR = 42; // *
const CHAR_DOLLAR = 36;
const CHAR_QUESTION = 63;
const CHAR_COLON = 58;
const CHAR_AT = 64;
const CHAR_DOT = 46;
const CHAR_PLUS = 43;
const CHAR_LOWER_E = 101;
const CHAR_UPPER_E = 69;
const CHAR_LPAREN = 40;
const CHAR_RPAREN = 41;

function isSpace(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_TAB || code === CHAR_LF || code === CHAR_CR;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentStart(code: number): boolean {
  // Anything above ASCII counts as part of an identifier: table names can be anything.
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code > 127;
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code) || code === CHAR_DOLLAR;
}

/**
 * End of a dollar-quoted string tag `$tag$` (including the empty `$$`),
 * or -1 if this is not one.
 */
function dollarTagEnd(sql: string, start: number): number {
  for (let i = start + 1; i < sql.length; i++) {
    const code = sql.charCodeAt(i);
    if (code === CHAR_DOLLAR) return i;
    // A tag may only contain letters, digits and `_`; `$` closes it.
    if (!isIdentStart(code) && !isDigit(code)) return -1;
  }
  return -1;
}

function scan(sql: string): string {
  const length = sql.length;
  let out = '';
  let pendingSpace = false;
  let i = 0;

  const push = (text: string): void => {
    if (pendingSpace && out.length > 0) out += ' ';
    pendingSpace = false;
    out += text;
  };

  while (i < length) {
    const code = sql.charCodeAt(i);

    if (isSpace(code)) {
      pendingSpace = true;
      i++;
      continue;
    }

    // Comments are dropped entirely: they do not affect what gets executed.
    if (code === CHAR_DASH && sql.charCodeAt(i + 1) === CHAR_DASH) {
      while (i < length && sql.charCodeAt(i) !== CHAR_LF) i++;
      pendingSpace = true;
      continue;
    }
    if (code === CHAR_SLASH && sql.charCodeAt(i + 1) === CHAR_STAR) {
      i += 2;
      while (
        i < length &&
        !(sql.charCodeAt(i) === CHAR_STAR && sql.charCodeAt(i + 1) === CHAR_SLASH)
      )
        i++;
      i += 2;
      pendingSpace = true;
      continue;
    }

    // String literal: neither its value nor its length may affect the fingerprint.
    if (code === CHAR_QUOTE) {
      i++;
      while (i < length) {
        const inner = sql.charCodeAt(i);
        if (inner === CHAR_BACKSLASH) {
          i += 2;
          continue;
        }
        if (inner === CHAR_QUOTE) {
          if (sql.charCodeAt(i + 1) === CHAR_QUOTE) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push('?');
      continue;
    }

    // A quoted identifier is a table or column name — it is significant.
    if (code === CHAR_DQUOTE || code === CHAR_BACKTICK) {
      const start = i;
      i++;
      while (i < length && sql.charCodeAt(i) !== code) i++;
      i++;
      push(sql.slice(start, Math.min(i, length)));
      continue;
    }

    if (code === CHAR_DOLLAR) {
      if (isDigit(sql.charCodeAt(i + 1))) {
        i++;
        while (i < length && isDigit(sql.charCodeAt(i))) i++;
        push('?');
        continue;
      }
      const tagEnd = dollarTagEnd(sql, i);
      if (tagEnd !== -1) {
        const tag = sql.slice(i, tagEnd + 1);
        const close = sql.indexOf(tag, tagEnd + 1);
        i = close === -1 ? length : close + tag.length;
        push('?');
        continue;
      }
      push('$');
      i++;
      continue;
    }

    if (code === CHAR_QUESTION) {
      push('?');
      i++;
      continue;
    }

    if (code === CHAR_COLON) {
      // `::` is a Postgres cast, not a named parameter.
      if (sql.charCodeAt(i + 1) === CHAR_COLON) {
        push('::');
        i += 2;
        continue;
      }
      if (isIdentStart(sql.charCodeAt(i + 1))) {
        i++;
        while (i < length && isIdentPart(sql.charCodeAt(i))) i++;
        push('?');
        continue;
      }
      push(':');
      i++;
      continue;
    }

    if (code === CHAR_AT && isIdentStart(sql.charCodeAt(i + 1))) {
      i++;
      while (i < length && isIdentPart(sql.charCodeAt(i))) i++;
      push('?');
      continue;
    }

    if (isDigit(code) || (code === CHAR_DOT && isDigit(sql.charCodeAt(i + 1)))) {
      i++;
      while (i < length) {
        const next = sql.charCodeAt(i);
        if (isDigit(next) || next === CHAR_DOT) {
          i++;
          continue;
        }
        if (next === CHAR_LOWER_E || next === CHAR_UPPER_E) {
          const after = sql.charCodeAt(i + 1);
          const signed =
            (after === CHAR_PLUS || after === CHAR_DASH) && isDigit(sql.charCodeAt(i + 2));
          if (isDigit(after) || signed) {
            i += 2;
            continue;
          }
        }
        break;
      }
      push('?');
      continue;
    }

    if (isIdentStart(code)) {
      const start = i;
      i++;
      while (i < length && isIdentPart(sql.charCodeAt(i))) i++;
      push(sql.slice(start, i));
      continue;
    }

    push(sql[i] ?? '');
    i++;
  }

  return out;
}

// After normalization there is never more than one space between tokens, so
// `\s?` is enough in these patterns — which also rules out catastrophic
// backtracking.
const IN_LIST = /\bIN\s?\(\s?\?(?:,\s?\?)*\s?\)/gi;
const VALUES_TUPLES = /\bVALUES\s?(\((?:\?,\s?)*\?\))(?:,\s?\((?:\?,\s?)*\?\))+/gi;

/**
 * Collapses variable-length lists.
 *
 * `IN (?, ?, ?)` and `IN (?)` are the same query with a different number of
 * parameters; otherwise every list length yields its own fingerprint. Same for
 * batched `VALUES`.
 */
function collapseLists(sql: string): string {
  return sql.replace(IN_LIST, 'IN (?)').replace(VALUES_TUPLES, 'VALUES $1');
}

/**
 * Normalized SQL fingerprint.
 *
 * Literals, numbers, placeholders and `IN (...)` lists of any length collapse
 * to `?`, comments are dropped and whitespace is reduced to single spaces.
 */
export function fingerprintSql(sql: string): string {
  const cache = fingerprints();
  const cached = cache.get(sql);
  if (cached !== undefined) return cached;

  const result = collapseLists(scan(sql));
  cache.set(sql, result);
  return result;
}

const STATEMENT_KEYWORDS: Readonly<Record<string, SqlOperation>> = {
  select: 'select',
  insert: 'insert',
  update: 'update',
  delete: 'delete',
};

/**
 * Statement type: what the query does at the top level.
 *
 * Subqueries are ignored, so `WITH x AS (SELECT …) DELETE FROM …` is a
 * `delete`, not a `select`. Otherwise the N+1 detector would read a delete in
 * a loop as a repeated read and fire a false positive.
 *
 * Accepts a fingerprint or any SQL — comments and literals are handled.
 */
export function sqlOperation(sql: string): SqlOperation {
  const cache = operations();
  const cached = cache.get(sql);
  if (cached !== undefined) return cached;

  // The scan is idempotent: on an already normalized fingerprint it changes
  // nothing, while on raw SQL it strips comments and literals that could
  // otherwise contain keywords.
  const normalized = scan(sql);
  const length = normalized.length;
  let result: SqlOperation = 'other';
  let depth = 0;
  let insideCte = false;
  let i = 0;

  while (i < length) {
    const code = normalized.charCodeAt(i);
    if (code === CHAR_LPAREN) {
      depth++;
      i++;
      continue;
    }
    if (code === CHAR_RPAREN) {
      depth--;
      i++;
      continue;
    }
    if (!isIdentStart(code)) {
      i++;
      continue;
    }

    const start = i;
    while (i < length && isIdentPart(normalized.charCodeAt(i))) i++;
    if (depth > 0) continue;

    const word = normalized.slice(start, i).toLowerCase();
    if (word === 'with') {
      insideCte = true;
      continue;
    }
    const statement = STATEMENT_KEYWORDS[word];
    if (statement) {
      result = statement;
      break;
    }
    // First word is neither WITH nor a statement: nothing left to parse.
    if (!insideCte) break;
  }

  cache.set(sql, result);
  return result;
}

/** Clears the caches. Needed by tests and benchmarks. */
export function clearSqlCaches(): void {
  fingerprints().clear();
  operations().clear();
}
