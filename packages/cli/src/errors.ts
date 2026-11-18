/**
 * Failures, as a person reads them.
 *
 * Every way this client can fail ends in one of these: a headline in plain
 * words, hypotheses about what to do next, and — only under `--verbose` — the
 * technical cause. A stack trace is what a tool prints when it has nothing
 * useful to say.
 */

/** Exit codes, as documented in DESIGN.md. */
export const EXIT_OK = 0;
/** Something went wrong, including a collector that cannot be reached. */
export const EXIT_FAILED = 1;
/** The arguments, or the terminal, made the command impossible to run. */
export const EXIT_USAGE = 2;

/** A failure with an exit code and something to say about it. */
export class CliError extends Error {
  readonly exitCode: number;
  /**
   * Lines printed under the headline: what to check, what to run next.
   *
   * Rendered as given, so they carry their own indentation.
   */
  readonly hints: readonly string[];

  constructor(
    message: string,
    options: { exitCode?: number; hints?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? EXIT_FAILED;
    this.hints = options.hints ?? [];
  }
}

/** Bad arguments, a missing value, a terminal too narrow to print in. */
export class UsageError extends CliError {
  constructor(message: string, hints: readonly string[] = []) {
    super(message, { exitCode: EXIT_USAGE, hints });
    this.name = 'UsageError';
  }
}

/**
 * The collector did not answer.
 *
 * The three hypotheses are ordered by how often each one turns out to be the
 * answer, and the concrete values sit on the right because they get copied.
 */
export class UnreachableError extends CliError {
  constructor(url: string, cause: unknown) {
    super('cannot reach the collector', {
      exitCode: EXIT_FAILED,
      hints: [
        '',
        '  the panel is served by your app. check that',
        '    1  reqray is attached      reqray({ panel: true }) before the routes',
        '    2  the app is running     and that NODE_ENV is not production',
        `    3  the address matches    REQRAY_URL=${url}`,
      ],
      cause,
    });
    this.name = 'UnreachableError';
  }
}

/**
 * The technical cause, for `--verbose`. Never shown by default.
 *
 * `null` when there is nothing underneath — a mistyped flag has no cause, and
 * offering `--verbose` for one would promise something that is not there.
 */
export function causeOf(error: unknown): string | null {
  const cause = error instanceof Error ? (error.cause ?? null) : null;
  if (cause instanceof Error) {
    // `fetch failed` on its own says nothing; the reason underneath does.
    const inner = cause.cause;
    return inner instanceof Error ? `${cause.message} — ${inner.message}` : cause.message;
  }
  return cause === null ? null : String(cause);
}
