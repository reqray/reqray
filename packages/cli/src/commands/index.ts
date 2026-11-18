/**
 * The commands this client has.
 *
 * A list rather than a switch: the usage screen is generated from it, and a
 * new command is one entry plus a file.
 */

import type { Command } from './context.js';
import { show } from './show.js';
import { watch } from './watch.js';

export const COMMANDS: readonly Command[] = [watch, show];

/** The command with this name, or `null`. */
export function commandNamed(name: string): Command | null {
  return COMMANDS.find((command) => command.name === name) ?? null;
}

export type { Command, CommandContext, Writer } from './context.js';
