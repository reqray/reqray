/**
 * The screens that are text rather than data.
 *
 * Both of them — nothing recorded yet, and nothing answering — have to end in
 * something to do. A state that only states itself leaves the reader to guess
 * whether they are looking at a bug or at an empty afternoon.
 */

import type { PanelMeta } from '@reqray/protocol';
import { CliError, causeOf } from '../errors.js';
import type { Theme } from './theme.js';
import { padStart } from './width.js';

/** The line every command prints first. */
export function header(version: string, url: string, meta: PanelMeta, theme: Theme): string[] {
  const host = hostOf(url);
  return [
    theme.paint('plain', `reqray ${version}`) +
      theme.paint('dim', `   watching ${host}   pid ${meta.pid}   ctrl-c to stop`),
    '',
  ];
}

/**
 * The collector answered, and has nothing to show.
 *
 * Not an error, so nothing here is red: the header is the one a working
 * stream prints, and the only coloured thing on screen is a command that can
 * be copied into the next tab.
 */
export function emptyState(url: string, meta: PanelMeta, theme: Theme): string[] {
  const origin = new URL(url).origin;
  const waiting = '  waiting';
  const status = `buffer ${meta.bufferSize}, empty`;
  const gap = Math.max(2, theme.width - waiting.length - status.length - 1);

  return [
    theme.paint('plain', '  collector attached — no requests recorded yet'),
    '',
    theme.paint('dim', '  try   ') + theme.paint('cmd', `curl -s ${origin}/`),
    theme.paint('dim', '        or just reload the application in a browser'),
    '',
    theme.paint('dim', waiting) + ' '.repeat(gap) + theme.paint('dim', status),
  ];
}

/**
 * A failure, as a person reads it.
 *
 * One bright line, then what to check. The technical cause is a `--verbose`
 * away: it belongs in a bug report, and putting it above the hypotheses
 * would bury them.
 */
export function renderFailure(error: unknown, theme: Theme, verbose: boolean): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [theme.paint('errLoud', `reqray: ${message}`)];

  const cause = causeOf(error);
  if (verbose && cause) lines.push('', theme.paint('dim', `  ${cause}`));

  if (error instanceof CliError) lines.push(...error.hints.map((hint) => theme.paint('dim', hint)));

  if (!verbose && cause) {
    lines.push(
      '',
      theme.paint('dim', '  ') +
        theme.paint('cmd', 'reqray --verbose') +
        theme.paint('dim', '   prints what actually failed'),
    );
  }
  return lines;
}

/** A stream that dropped, or came back. Muted: it is not the reader's doing. */
export function noticeLine(text: string, theme: Theme): string {
  return theme.paint('dim', `   ${theme.glyph('ellipsis')} ${text}`);
}

/** The status line under a list that has been narrowed. */
export function countLine(shown: number, total: number, theme: Theme): string {
  const left = `  ${shown} shown`;
  const right = `${total} recorded`;
  const gap = Math.max(2, theme.width - left.length - right.length - 1);
  return theme.paint('dim', left) + ' '.repeat(gap) + theme.paint('dim', right);
}

/** Host and port, as the header names the thing being watched. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Right-aligns a trailing command against the terminal's edge. */
export function trailing(left: string, command: string, theme: Theme): string {
  const gap = theme.width - left.length - command.length - 1;
  if (gap < 2) return `${theme.paint('dim', left)}  ${theme.paint('cmd', command)}`;
  return theme.paint('dim', left) + ' '.repeat(gap) + theme.paint('cmd', command);
}

/** Used by `show` for the "N more" tail; kept here so padding lives together. */
export function rightAligned(text: string, width: number): string {
  return padStart(text, width);
}
