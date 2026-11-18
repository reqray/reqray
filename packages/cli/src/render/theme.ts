/**
 * Colour and glyphs, decided once.
 *
 * Every renderer asks the theme rather than reading the environment itself:
 * one place decides whether this output is going to a terminal, a pipe or a
 * CI log, and one place knows what to draw when the font cannot be trusted.
 *
 * Sixteen colours, no backgrounds, no emoji. Colour is a second layer over
 * glyphs that already carry the meaning — turning it off must lose nothing.
 */

/** What a piece of output means, not what colour it is. */
export type Style =
  /** Coordinates: time, units, rules, column heads. */
  | 'dim'
  /** The data itself. */
  | 'plain'
  /** Cache spans — the one thing 37 white carries. */
  | 'faint'
  /** SQL, and improvements. */
  | 'ok'
  /** Slow, and the context around a finding. */
  | 'warn'
  /** A finding. At most two of these on a screen. */
  | 'warnLoud'
  /** 5xx context, regressions. */
  | 'err'
  /** A 500, and the headline of a failure. */
  | 'errLoud'
  /** A handler span, and any command that can be copied and run. */
  | 'cmd'
  /** Reverse video. One verdict, nowhere else. */
  | 'invert';

const SGR: Readonly<Record<Style, number>> = {
  dim: 90,
  plain: 39,
  faint: 37,
  ok: 32,
  warn: 33,
  warnLoud: 93,
  err: 31,
  errLoud: 91,
  cmd: 36,
  invert: 7,
};

/** Things drawn with characters a non-UTF-8 terminal cannot show. */
export type GlyphName =
  | 'barFull'
  | 'barSliver'
  | 'bracketOpen'
  | 'bracketClose'
  | 'bracketFill'
  | 'rulerTick'
  | 'ellipsis'
  | 'corner'
  | 'times'
  | 'none';

const UNICODE: Readonly<Record<GlyphName, string>> = {
  barFull: '█',
  barSliver: '▏',
  bracketOpen: '├',
  bracketClose: '┤',
  bracketFill: '─',
  rulerTick: '┼',
  ellipsis: '…',
  corner: '└',
  times: '×',
  none: '—',
};

/**
 * ASCII stand-ins.
 *
 * One character each, so no column moves — except the ellipsis, which is
 * three and is accounted for wherever truncation is measured.
 */
const ASCII: Readonly<Record<GlyphName, string>> = {
  barFull: '#',
  barSliver: '|',
  bracketOpen: '[',
  bracketClose: ']',
  bracketFill: '-',
  rulerTick: '+',
  ellipsis: '...',
  corner: '\\_',
  times: 'x',
  none: '-',
};

/** How this run draws. */
export interface Theme {
  readonly color: boolean;
  readonly unicode: boolean;
  /** Terminal width in columns. */
  readonly width: number;
  paint(style: Style, text: string): string;
  glyph(name: GlyphName): string;
}

/** What the command line asked for, before the environment is consulted. */
export interface ThemeFlags {
  /** `auto` follows the terminal; the other two are the explicit flags. */
  readonly color?: 'auto' | 'always' | 'never';
  readonly ascii?: boolean;
  /** Overrides the detected width. Tests need a stable one. */
  readonly width?: number;
}

/** The stream a theme is resolved for. */
export interface OutputStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

/** Width used when nothing says otherwise. */
export const FALLBACK_WIDTH = 80;

/** Start of an SGR sequence, written as an escape so no control byte lives in the source. */
const ESC = '\u001b[';

/**
 * Whether colour is wanted.
 *
 * `NO_COLOR` and `TERM=dumb` are conventions worth honouring even when the
 * output is a terminal; a pipe or a file gets no escape codes at all, so what
 * lands in a log stays greppable.
 */
function wantsColor(env: NodeJS.ProcessEnv, stdout: OutputStream, flags: ThemeFlags): boolean {
  if (flags.color === 'always') return true;
  if (flags.color === 'never') return false;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['TERM'] === 'dumb') return false;
  return stdout.isTTY === true;
}

/**
 * Whether the box-drawing characters are safe to use.
 *
 * A locale that names an encoding other than UTF-8 is taken at its word. No
 * locale at all is taken as UTF-8: that is what modern terminals are, and
 * drawing a waterfall out of hyphens because a variable is unset would be a
 * downgrade nobody asked for.
 */
function wantsUnicode(env: NodeJS.ProcessEnv, flags: ThemeFlags): boolean {
  if (flags.ascii) return false;
  if (env['REQRAY_ASCII'] === '1') return false;
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'];
  if (!locale) return true;
  return /utf-?8/i.test(locale);
}

/** Resolves how this run draws, once, at startup. */
export function resolveTheme(
  env: NodeJS.ProcessEnv,
  stdout: OutputStream,
  flags: ThemeFlags = {},
): Theme {
  const color = wantsColor(env, stdout, flags);
  const unicode = wantsUnicode(env, flags);
  const glyphs = unicode ? UNICODE : ASCII;
  const columns = Number(env['COLUMNS']);
  const detected =
    Number.isFinite(columns) && columns > 0
      ? Math.floor(columns)
      : (stdout.columns ?? FALLBACK_WIDTH);

  return {
    color,
    unicode,
    width: flags.width ?? detected,
    // Whitespace is painted only by reverse video, which is the one style
    // that shows on a space. Everything else would be an escape sequence
    // around nothing — invisible on screen and noise in a pipe.
    paint: (style, text) =>
      color && text.trim() !== '' && style !== 'invert'
        ? `${ESC}${SGR[style]}m${text}${ESC}0m`
        : style === 'invert' && color && text !== ''
          ? `${ESC}${SGR.invert}m${text}${ESC}0m`
          : text,
    glyph: (name) => glyphs[name],
  };
}

/** A theme for tests and for measuring: no colour, a width that holds still. */
export function plainTheme(width = FALLBACK_WIDTH, unicode = true): Theme {
  return resolveTheme({}, {}, { color: 'never', width, ascii: !unicode });
}
