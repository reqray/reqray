/**
 * Snapshot helpers.
 *
 * Escape sequences are written out as `⟨33⟩…⟨/⟩` so a coloured snapshot is a
 * diff a person can read: the point of keeping these as text files is that a
 * change in colour shows up as a change in words rather than as a wall of
 * bytes a reviewer scrolls past.
 */

/**
 * Built rather than written as a literal: an escape byte in a regular
 * expression is exactly the mistake the linter is there to catch, and this is
 * the one place that means it.
 */
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[(\\d+)m`, 'g');

/** Turns a rendered screen into snapshot text. */
export function readable(lines: readonly string[]): string {
  return `${lines.join('\n').replace(SGR, (_, code) => (code === '0' ? '⟨/⟩' : `⟨${code}⟩`))}\n`;
}

/** Whether a rendered screen contains any escape sequence at all. */
export function hasColor(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes(ESC));
}

/** The same screen with every escape sequence taken back out. */
export function strip(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(SGR, ''));
}

/** Collects what a command wrote. */
export function capture(): { lines: string[]; write(chunk: string): void } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      // Commands write whole lines; a trailing newline would add an empty one.
      for (const line of chunk.replace(/\n$/, '').split('\n')) lines.push(line);
    },
  };
}
