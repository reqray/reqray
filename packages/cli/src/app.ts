/**
 * One run of the client.
 *
 * Separated from the executable so a test can run a whole command — argv in,
 * lines and an exit code out — without a subprocess and without the signal
 * handling that only makes sense around a real process.
 */

import { parseArgs } from './args.js';
import { ReqrayClient } from './client.js';
import { streamWriter } from './commands/context.js';
import { COMMANDS, commandNamed } from './commands/index.js';
import { CliError, EXIT_FAILED, EXIT_OK, EXIT_USAGE, UsageError } from './errors.js';
import { DEFAULT_URL, GLOBAL_FLAGS, resolveGlobals } from './options.js';
import { renderFailure } from './render/screens.js';
import { resolveTheme } from './render/theme.js';
import { MIN_WIDTH } from './render/width.js';
import { cliVersion } from './version.js';

/** The process a run reads and writes. */
export interface Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: { isTTY?: boolean; columns?: number; write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
  /** Aborted on Ctrl+C. */
  readonly signal?: AbortSignal;
}

/**
 * Runs one command.
 *
 * @returns the exit code. Failures are printed here and never thrown at the
 * caller: an exception reaching a terminal is a stack trace, and a stack
 * trace is what a tool prints when it has nothing useful to say.
 */
export async function run(argv: readonly string[], runtime: Runtime): Promise<number> {
  const version = cliVersion();
  const out = streamWriter(runtime.stdout);
  const errors = streamWriter(runtime.stderr);

  try {
    const first = argv[0];

    if (first === undefined || first === '--help' || first === '-h') {
      for (const line of usage(version, runtime)) out.line(line);
      return first === undefined ? EXIT_USAGE : EXIT_OK;
    }
    if (first === '--version' || first === '-V') {
      out.line(version);
      return EXIT_OK;
    }
    if (first.startsWith('-')) {
      throw new UsageError(`reqray needs a command before ${first}`, [
        '',
        `  commands       ${COMMANDS.map((command) => command.name).join('   ')}`,
      ]);
    }

    const command = commandNamed(first);
    if (!command) {
      throw new UsageError(`there is no command called "${first}"`, [
        '',
        `  commands       ${COMMANDS.map((entry) => entry.name).join('   ')}`,
      ]);
    }

    const args = parseArgs(argv.slice(1), { ...GLOBAL_FLAGS, ...command.flags });
    if (args.flags['help'] === true) {
      for (const line of usage(version, runtime)) out.line(line);
      return EXIT_OK;
    }

    const globals = resolveGlobals(args, runtime);
    // A grid cannot be drawn narrower than this, and a wrapped grid is worse
    // than an explanation.
    if (globals.theme.width < MIN_WIDTH && args.flags['json'] !== true) {
      throw new UsageError(
        `this terminal is ${globals.theme.width} columns wide; reqray needs ${MIN_WIDTH}`,
        ['', '  widen the window, or pipe the output somewhere that has room'],
      );
    }

    const client = new ReqrayClient({ url: globals.url, token: globals.token });
    return await command.run({
      client,
      globals,
      args,
      out,
      version,
      signal: runtime.signal ?? new AbortController().signal,
    });
  } catch (error) {
    if (isAbort(error)) return EXIT_OK;
    const theme = resolveTheme(runtime.env, runtime.stderr as { isTTY?: boolean });
    for (const line of renderFailure(error, theme, argv.includes('--verbose'))) errors.line(line);
    return error instanceof CliError ? error.exitCode : EXIT_FAILED;
  }
}

/** Ctrl+C, not a failure. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** The usage screen, built from the command list. */
function usage(version: string, runtime: Runtime): string[] {
  const theme = resolveTheme(runtime.env, runtime.stdout);
  const command = (name: string, summary: string) =>
    theme.paint('cmd', `  reqray ${name}`.padEnd(22)) + theme.paint('dim', summary);
  const flag = (name: string, summary: string) =>
    theme.paint('dim', `  ${name.padEnd(20)}${summary}`);

  return [
    theme.paint('plain', `reqray ${version}`) +
      theme.paint('dim', '   the panel, from the terminal'),
    '',
    command('watch', 'follow requests as they happen'),
    command('show <id>', 'one request, whole'),
    '',
    flag('--ids', 'watch: print the identifier show takes'),
    flag('--last --path <s>', 'show: the last request to a path'),
    '',
    flag('--url <address>', `where the panel is (${DEFAULT_URL})`),
    flag('--token <token>', 'for a collector started with one'),
    flag('--no-color', 'no escape codes, whatever the terminal is'),
    flag('--ascii', 'no box-drawing characters'),
    flag('--verbose', 'print what actually failed'),
    '',
    theme.paint('dim', '  REQRAY_URL and REQRAY_TOKEN say the same as the two flags.'),
  ];
}
