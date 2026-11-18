/**
 * When colour is on, and when the glyphs are safe.
 *
 * One check decides both for the whole client, so this is where the
 * conventions are pinned down: `NO_COLOR`, `TERM=dumb`, a pipe instead of a
 * terminal, and a locale that is not UTF-8.
 */

import { describe, expect, it } from 'vitest';
import { plainTheme, resolveTheme } from '../src/render/theme.js';

const tty = { isTTY: true, columns: 120 };
const pipe = { isTTY: false };

describe('colour', () => {
  it('is on for a terminal and off for a pipe', () => {
    expect(resolveTheme({}, tty).color).toBe(true);
    expect(resolveTheme({}, pipe).color).toBe(false);
  });

  it('is off when NO_COLOR says so, whatever the terminal is', () => {
    expect(resolveTheme({ NO_COLOR: '1' }, tty).color).toBe(false);
    // The convention is "set and not empty": an empty value is not a request.
    expect(resolveTheme({ NO_COLOR: '' }, tty).color).toBe(true);
  });

  it('is off for a terminal that cannot do it', () => {
    expect(resolveTheme({ TERM: 'dumb' }, tty).color).toBe(false);
  });

  it('follows the flags over everything else', () => {
    expect(resolveTheme({ NO_COLOR: '1' }, tty, { color: 'always' }).color).toBe(true);
    expect(resolveTheme({}, tty, { color: 'never' }).color).toBe(false);
    // `--color=always` is what makes piping into `less -R` work.
    expect(resolveTheme({}, pipe, { color: 'always' }).color).toBe(true);
  });

  it('wraps text only when it is on, and never wraps whitespace', () => {
    const painted = resolveTheme({}, tty);

    expect(painted.paint('warn', 'N+1')).toBe('\u001b[33mN+1\u001b[0m');
    expect(painted.paint('warn', '   ')).toBe('   ');
    expect(plainTheme().paint('warn', 'N+1')).toBe('N+1');
  });
});

describe('glyphs', () => {
  it('are box-drawing by default', () => {
    expect(resolveTheme({}, tty).glyph('barFull')).toBe('█');
  });

  it('fall back to ASCII when asked, or when the locale is not UTF-8', () => {
    expect(resolveTheme({}, tty, { ascii: true }).glyph('barFull')).toBe('#');
    expect(resolveTheme({ REQRAY_ASCII: '1' }, tty).glyph('barFull')).toBe('#');
    expect(resolveTheme({ LANG: 'C' }, tty).glyph('barFull')).toBe('#');
    expect(resolveTheme({ LC_ALL: 'POSIX' }, tty).glyph('barFull')).toBe('#');
  });

  it('stay box-drawing for a UTF-8 locale, however it is spelled', () => {
    expect(resolveTheme({ LANG: 'en_GB.UTF-8' }, tty).glyph('barFull')).toBe('█');
    expect(resolveTheme({ LC_CTYPE: 'ru_RU.utf8' }, tty).glyph('barFull')).toBe('█');
  });

  it('are one character each, so no column moves', () => {
    const ascii = resolveTheme({}, tty, { ascii: true });
    const names = ['barFull', 'barSliver', 'bracketOpen', 'bracketClose', 'rulerTick'] as const;

    for (const name of names) expect(ascii.glyph(name)).toHaveLength(1);
    // Except the ellipsis, which is three and is budgeted for where it is used.
    expect(ascii.glyph('ellipsis')).toBe('...');
  });
});

describe('width', () => {
  it('comes from the terminal, and falls back to 80', () => {
    expect(resolveTheme({}, tty).width).toBe(120);
    expect(resolveTheme({}, pipe).width).toBe(80);
  });

  it('lets COLUMNS override it, which is how a pipe gets a width', () => {
    expect(resolveTheme({ COLUMNS: '200' }, tty).width).toBe(200);
    expect(resolveTheme({ COLUMNS: 'wide' }, tty).width).toBe(120);
  });
});
