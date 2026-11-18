import type { RequestFilterQuery } from '../../api/index';

/**
 * The search field speaks tokens.
 *
 * `status:5xx`, `>100ms`, `sql>10`, `has:n+1` — each word is tried as a token,
 * and what is not one stays free text. Tokens narrow the same filter the chips
 * do, so the two compose: a `POST` chip plus `>100ms` is "slow POSTs".
 *
 * Only the known prefixes count as tokens, so a path with a colon still works.
 */

/** What a query string means, tokens unfolded. */
export interface ParsedQuery {
  /** The words that were not tokens, joined back — the free-text needle. */
  readonly text: string;
  /** `path:` — substring of the path alone. */
  readonly path: string | null;
  /** `method:` — upper-cased. */
  readonly methods: readonly string[];
  /** `status:5xx` — classes. */
  readonly statusClasses: readonly number[];
  /** `status:404` — exactly this code. */
  readonly status: number | null;
  /** `>100ms`, `>2s` — at least this slow. */
  readonly minDurationMs: number | null;
  /** `sql>10` — at least this many queries. */
  readonly minSql: number | null;
  /** `has:seq`, `has:dup` — rows flagged with one of these detectors. */
  readonly flagged: readonly string[];
  /** `has:n+1` — judged by the findings, not the flag. */
  readonly nPlusOne: boolean;
  /** `has:findings`. */
  readonly onlyFindings: boolean;
  /** `has:error`. */
  readonly onlyErrors: boolean;
  /** `test:` — issued by any test (empty) or one whose name contains this. */
  readonly test: string | null;
}

const EMPTY: ParsedQuery = {
  text: '',
  path: null,
  methods: [],
  statusClasses: [],
  status: null,
  minDurationMs: null,
  minSql: null,
  flagged: [],
  nPlusOne: false,
  onlyFindings: false,
  onlyErrors: false,
  test: null,
};

const METHOD_NAMES = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * What `has:` accepts, in the reader's words rather than detector ids.
 *
 * `n+1` goes through the findings (the dedicated flag on every row), the
 * rest through the list's flag — the badge being pointed at.
 */
const HAS: Record<string, Partial<ParsedQuery>> = {
  'n+1': { nPlusOne: true },
  nplus: { nPlusOne: true },
  findings: { onlyFindings: true },
  finding: { onlyFindings: true },
  error: { onlyErrors: true },
  errors: { onlyErrors: true },
  slow: { flagged: ['slow_budget'] },
  code: { flagged: ['slow_code'] },
  seq: { flagged: ['sequential_http'] },
  dup: { flagged: ['dup_http', 'dup_cache'] },
  wait: { flagged: ['pool_wait'] },
  tx: { flagged: ['transaction_hold'] },
  heavy: { flagged: ['heavy_response'] },
};

/** `>100ms`, `>1.5s` — milliseconds, or `null` when it is not a duration. */
function thresholdOf(word: string): number | null {
  const match = /^>(\d+(?:\.\d+)?)(ms|s)$/.exec(word);
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] === 's' ? value * 1000 : value;
}

/** The tokens the palette offers, with what they are for. */
export const TOKEN_HINTS: ReadonlyArray<{ token: string; hint: string }> = [
  { token: 'path:', hint: 'substring of the path alone' },
  { token: 'method:', hint: 'GET, POST — combines with the chips' },
  { token: 'status:', hint: 'a class (5xx) or an exact code (404)' },
  { token: 'has:', hint: 'n+1, seq, dup, slow, code, wait, tx, heavy, findings, error' },
  { token: 'test:', hint: 'issued by a test, optionally matching a name' },
  { token: '>100ms', hint: 'at least this slow — any figure, ms or s' },
  { token: 'sql>10', hint: 'at least this many queries' },
];

/** Reads a query string into its tokens and its free text. */
export function parseQuery(raw: string): ParsedQuery {
  const out = {
    ...EMPTY,
    text: '',
    methods: [] as string[],
    statusClasses: [] as number[],
    flagged: [] as string[],
  };
  const free: string[] = [];

  for (const word of raw.trim().split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase();

    if (lower.startsWith('path:')) {
      const value = word.slice('path:'.length);
      if (value) out.path = value;
      continue;
    }

    if (lower.startsWith('method:')) {
      for (const name of word.slice('method:'.length).split(',')) {
        const method = name.trim().toUpperCase();
        if (METHOD_NAMES.has(method)) out.methods.push(method);
      }
      continue;
    }

    if (lower.startsWith('status:')) {
      const value = lower.slice('status:'.length);
      const asClass = /^([1-5])xx$/.exec(value);
      if (asClass) {
        out.statusClasses.push(Number(asClass[1]));
        continue;
      }
      const asCode = /^\d{3}$/.exec(value);
      if (asCode) {
        out.status = Number(value);
        continue;
      }
      // `status:` with nothing usable yet — half-typed, exclude nothing.
      continue;
    }

    if (lower.startsWith('has:')) {
      const meaning = HAS[lower.slice('has:'.length)];
      if (meaning) {
        if (meaning.flagged) out.flagged.push(...meaning.flagged);
        if (meaning.nPlusOne) out.nPlusOne = true;
        if (meaning.onlyFindings) out.onlyFindings = true;
        if (meaning.onlyErrors) out.onlyErrors = true;
      }
      continue;
    }

    if (lower.startsWith('test:')) {
      // Bare `test:` means "any test"; a word after it narrows by name.
      out.test = word.slice('test:'.length);
      continue;
    }

    const threshold = thresholdOf(lower);
    if (threshold !== null) {
      out.minDurationMs = Math.max(out.minDurationMs ?? 0, threshold);
      continue;
    }

    const sql = /^sql>(\d+)$/.exec(lower);
    if (sql) {
      // `sql>10` reads as "more than ten", so the floor is eleven.
      out.minSql = Math.max(out.minSql ?? 0, Number(sql[1]) + 1);
      continue;
    }

    free.push(word);
  }

  out.text = free.join(' ');
  return out;
}

/**
 * The parsed query as API parameters — for every screen that forwards the
 * search text to the server. Sending the raw string as `q` would make
 * `status:5xx` a substring nobody's path contains.
 */
export function apiQueryOf(parsed: ParsedQuery): Partial<RequestFilterQuery> {
  return {
    q: parsed.text || undefined,
    path: parsed.path ?? undefined,
    methods: parsed.methods.length > 0 ? [...parsed.methods] : undefined,
    statusClasses: parsed.statusClasses.length > 0 ? [...parsed.statusClasses] : undefined,
    status: parsed.status ?? undefined,
    minDurationMs: parsed.minDurationMs ?? undefined,
    minSql: parsed.minSql ?? undefined,
    flagged: parsed.flagged.length > 0 ? [...parsed.flagged] : undefined,
    onlyNPlusOne: parsed.nPlusOne || undefined,
    onlyFindings: parsed.onlyFindings || undefined,
    onlyErrors: parsed.onlyErrors || undefined,
    onlyTests: parsed.test === '' || undefined,
    test: parsed.test ? parsed.test : undefined,
  };
}
