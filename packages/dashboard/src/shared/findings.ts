/** What a pattern's state means to the panel, said once. */

import type { FindingPattern } from '../api/index';

/** Nobody has looked at this one — what the dot on the Findings tab counts. */
export function isUnread(pattern: FindingPattern): boolean {
  return pattern.state === 'new';
}

/**
 * Still somebody's work.
 *
 * Muted is filed away on purpose, and `fixed?` is a guess the detector has
 * stopped seeing — neither belongs in a list of what is left to do.
 */
export function isOpen(pattern: FindingPattern): boolean {
  return pattern.state === 'new' || pattern.state === 'ack';
}

/** The count behind the dot, wherever it is read. */
export function unreadCount(patterns: readonly FindingPattern[]): number {
  return patterns.filter(isUnread).length;
}
