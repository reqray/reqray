/**
 * Command line, parsed.
 *
 * Fifty lines instead of a dependency: an `npx` user waits for every package
 * in the tree, and what this needs — long flags, values attached or separate,
 * one command word — is smaller than the README of anything that would do it
 * for us. `node:util`'s `parseArgs` is close, but its errors are addressed to
 * a programmer and half the work here is the error.
 */

import { UsageError } from './errors.js';

/**
 * What a flag carries.
 *
 * `list` accumulates — `--method GET --method POST` means both — while
 * `string` takes the last value given, which is what anyone repeating
 * `--url` means. `optional` is for a flag that says one thing on its own and
 * something narrower with a value: `--sql` is every query, `--sql q2` is one.
 */
export type FlagKind = 'boolean' | 'string' | 'optional' | 'list';

/** The flags a command accepts. */
export type FlagSpec = Readonly<Record<string, FlagKind>>;

/**
 * What the command line said.
 *
 * The command word is picked off before this runs — a parser that also
 * decides which command it is parsing for cannot know which flags are legal.
 */
export interface ParsedArgs {
  /** Everything that is not a flag or the value of one. */
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/** Short forms worth having. Nothing else is abbreviated. */
const ALIASES: Readonly<Record<string, string>> = {
  h: 'help',
  V: 'version',
};

/** Reads `argv`, or explains what is wrong with it. */
export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    const bare = token.replace(/^--?/, '');
    const equals = bare.indexOf('=');
    const rawName = equals === -1 ? bare : bare.slice(0, equals);
    const name = ALIASES[rawName] ?? rawName;
    const kind = spec[name];

    if (kind === undefined) throw unknownFlag(token, spec);

    if (kind === 'boolean') {
      if (equals !== -1) {
        throw new UsageError(`${token.split('=')[0]} takes no value`);
      }
      flags[name] = true;
      continue;
    }

    const attached = equals === -1 ? undefined : bare.slice(equals + 1);
    const next = argv[index + 1];
    const separate = next !== undefined && !next.startsWith('-') ? next : undefined;

    if (kind === 'optional') {
      // Present with no value is an answer in itself, so nothing is required
      // and the next token is only taken when it cannot be anything else.
      if (attached === undefined && separate !== undefined) index++;
      flags[name] = attached ?? separate ?? '';
      continue;
    }

    if (attached === undefined && separate !== undefined) index++;
    const value = attached ?? separate;
    if (value === undefined) throw new UsageError(`--${name} needs a value`);

    const existing = flags[name];
    flags[name] = kind === 'list' && typeof existing === 'string' ? `${existing},${value}` : value;
  }

  return { positionals, flags };
}

/** An unknown flag, with the nearest thing that would have worked. */
function unknownFlag(token: string, spec: FlagSpec): UsageError {
  const typed = token.replace(/^--?/, '').split('=')[0] ?? '';
  const known = Object.keys(spec).sort();
  const near = known.filter(
    (flag) => flag.startsWith(typed.slice(0, 3)) || typed.startsWith(flag.slice(0, 3)),
  );

  const hints = near.length
    ? ['', `  did you mean   ${near.map((flag) => `--${flag}`).join('   ')}`]
    : ['', `  flags here     ${known.map((flag) => `--${flag}`).join('   ')}`];
  return new UsageError(`unknown flag ${token}`, hints);
}

/** Reads a flag that must be a string, if it was given at all. */
export function stringFlag(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === 'string' ? value : null;
}

/** Reads a flag that must be a number. */
export function numberFlag(args: ParsedArgs, name: string): number | null {
  const raw = stringFlag(args, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError(`--${name} wants a number of milliseconds, not "${raw}"`);
  }
  return value;
}

/** Whether a boolean flag was given. */
export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

/** Splits a comma-separated flag into its parts. */
export function listFlag(args: ParsedArgs, name: string): string[] {
  const raw = stringFlag(args, name);
  if (raw === null) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
