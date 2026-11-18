import type { ReactNode } from 'react';

const KEYWORDS = new Set([
  'select',
  'from',
  'where',
  'inner',
  'left',
  'right',
  'outer',
  'join',
  'on',
  'and',
  'or',
  'order',
  'group',
  'by',
  'limit',
  'offset',
  'in',
  'as',
  'insert',
  'into',
  'values',
  'update',
  'set',
  'returning',
  'desc',
  'asc',
  'count',
  'not',
  'null',
  'is',
  'exists',
  'distinct',
  'having',
  'with',
  'delete',
  'case',
  'when',
  'then',
  'else',
  'end',
]);

/**
 * Splits SQL into coloured tokens.
 *
 * Deliberately not a parser: the goal is to make the shape of a query readable
 * at a glance, and a token-level split does that for every dialect without
 * knowing any of them.
 */
export function highlightSql(sql: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern =
    /(--[^\n]*)|('(?:[^']|'')*')|(\$\d+|\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$]*)|([^\sA-Za-z_$\d]+)|(\s+)/g;

  let match: RegExpExecArray | null = pattern.exec(sql);
  let key = 0;
  while (match !== null) {
    const [text, comment, literal, number, word, punct] = match;

    if (comment !== undefined || punct !== undefined) {
      out.push(
        <span key={key++} className="tok-punct">
          {text}
        </span>,
      );
    } else if (literal !== undefined || number !== undefined) {
      out.push(
        <span key={key++} className="tok-literal">
          {text}
        </span>,
      );
    } else if (word !== undefined && KEYWORDS.has(word.toLowerCase())) {
      out.push(
        <span key={key++} className="tok-keyword">
          {text}
        </span>,
      );
    } else {
      out.push(text);
    }

    match = pattern.exec(sql);
  }
  return out;
}
