/**
 * What a command is handed.
 *
 * The same shape for every command, so `top` and `check` land here without
 * anything being rearranged: a client, the resolved globals, the parsed
 * flags, somewhere to write, and one signal that ends everything.
 */

import type { FlagSpec, ParsedArgs } from '../args.js';
import type { ReqrayClient } from '../client.js';
import type { Globals } from '../options.js';

/** Where output goes. A test collects the lines; a terminal prints them. */
export interface Writer {
  line(text: string): void;
}

/** Everything a command runs with. */
export interface CommandContext {
  readonly client: ReqrayClient;
  readonly globals: Globals;
  readonly args: ParsedArgs;
  readonly out: Writer;
  /** Aborted by Ctrl+C. Every request and the stream carry it. */
  readonly signal: AbortSignal;
  /** The version in the header line. */
  readonly version: string;
}

export interface Command {
  readonly name: string;
  /** One line for the usage screen. */
  readonly summary: string;
  /** What this command accepts on top of the global flags. */
  readonly flags: FlagSpec;
  /** @returns the exit code. */
  run(context: CommandContext): Promise<number>;
}

/** Writes to a stream, one line at a time. */
export function streamWriter(stream: { write(chunk: string): unknown }): Writer {
  return {
    line(text) {
      stream.write(`${text}\n`);
    },
  };
}
