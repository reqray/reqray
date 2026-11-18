/**
 * Where a page of the request list stopped.
 *
 * The cursor is part of the panel's API, not of any one store: the in-memory
 * ring and the SQLite history hand out cursors the browser cannot tell apart,
 * and both continue from one the other could have written.
 *
 * The key is whatever the page is ordered by — the start time for the list as
 * it is normally read, the duration when the question is "what was slowest".
 * It is not a position on its own, because several requests can share a
 * millisecond and plenty share a duration, so the id rides along and breaks
 * the tie exactly the way the ordering does: largest first, among equals the
 * larger id first.
 */

/** A decoded cursor. */
export interface Cursor {
  /** Value of the column the page is ordered by. */
  readonly key: number;
  readonly id: string;
}

/** Writes the position of the last row on a page. */
export function encodeCursor(key: number, id: string): string {
  return `${key}.${id}`;
}

/**
 * Reads a cursor back.
 *
 * Split at the last dot rather than the first: a duration key is fractional,
 * and request ids are base36 with no dot in them.
 *
 * Anything unparseable means "start from the newest" rather than an error: a
 * stale link is a thing that happens, and answering it with a 400 helps
 * nobody.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const key = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (!Number.isFinite(key) || id === '') return null;
  return { key, id };
}

/**
 * Whether a row belongs on a page continuing from `cursor`.
 *
 * Strictly past it, so a row is never served twice and never skipped.
 */
export function isAfterCursor(cursor: Cursor, key: number, id: string): boolean {
  if (key !== cursor.key) return key < cursor.key;
  return id < cursor.id;
}
