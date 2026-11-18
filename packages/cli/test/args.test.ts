/**
 * The command line, and what happens when it is wrong.
 *
 * Half of a parser's job is the error it prints, so most of this is about
 * flags nobody meant to type.
 */

import { describe, expect, it } from 'vitest';
import {
  boolFlag,
  type FlagSpec,
  listFlag,
  numberFlag,
  parseArgs,
  stringFlag,
} from '../src/args.js';
import { EXIT_USAGE, UsageError } from '../src/errors.js';

const SPEC: FlagSpec = {
  url: 'string',
  method: 'list',
  sql: 'optional',
  full: 'boolean',
  'slower-than': 'string',
};

describe('reading flags', () => {
  it('takes a value attached or separate', () => {
    expect(parseArgs(['--url=http://a'], SPEC).flags['url']).toBe('http://a');
    expect(parseArgs(['--url', 'http://a'], SPEC).flags['url']).toBe('http://a');
  });

  it('keeps everything that is not a flag', () => {
    const args = parseArgs(['8974', '--full', 'extra'], SPEC);

    expect(args.positionals).toEqual(['8974', 'extra']);
    expect(boolFlag(args, 'full')).toBe(true);
  });

  it('lets the last value win, because that is what repeating means', () => {
    expect(stringFlag(parseArgs(['--url', 'a', '--url', 'b'], SPEC), 'url')).toBe('b');
  });

  it('accumulates a list flag instead', () => {
    const args = parseArgs(['--method', 'GET', '--method', 'POST,PATCH'], SPEC);

    expect(listFlag(args, 'method')).toEqual(['GET', 'POST', 'PATCH']);
  });

  it('an optional flag means one thing alone and another with a value', () => {
    expect(parseArgs(['--sql'], SPEC).flags['sql']).toBe('');
    expect(parseArgs(['--sql', 'q2'], SPEC).flags['sql']).toBe('q2');

    // And it does not swallow the flag after it.
    const both = parseArgs(['--sql', '--full'], SPEC);
    expect(both.flags['sql']).toBe('');
    expect(boolFlag(both, 'full')).toBe(true);
  });

  it('stops reading flags after --', () => {
    expect(parseArgs(['--', '--url'], SPEC).positionals).toEqual(['--url']);
  });

  it('refuses a value for a flag that takes none', () => {
    expect(() => parseArgs(['--full=yes'], SPEC)).toThrow(/takes no value/);
  });

  it('says which flag is missing its value', () => {
    expect(() => parseArgs(['--url'], SPEC)).toThrow(/--url needs a value/);
  });

  it('an unknown flag is a usage error, with the nearest one that would work', () => {
    let failure: UsageError | null = null;
    try {
      parseArgs(['--slow-than', '100'], SPEC);
    } catch (error) {
      failure = error as UsageError;
    }

    expect(failure).toBeInstanceOf(UsageError);
    expect(failure?.exitCode).toBe(EXIT_USAGE);
    expect(failure?.message).toBe('unknown flag --slow-than');
    expect(failure?.hints.join(' ')).toContain('--slower-than');
  });

  it('reads a number, and refuses one that is not', () => {
    expect(numberFlag(parseArgs(['--slower-than', '250'], SPEC), 'slower-than')).toBe(250);
    expect(numberFlag(parseArgs([], SPEC), 'slower-than')).toBeNull();
    expect(() => numberFlag(parseArgs(['--slower-than', 'soon'], SPEC), 'slower-than')).toThrow(
      /not "soon"/,
    );
  });
});
