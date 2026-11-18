/**
 * `@reqray/cli` — the terminal client.
 *
 * Exported so the pieces can be used from a script: the client speaks the
 * panel API, and the renderers turn what it returns into lines. The command
 * line itself is `run`.
 */

export { type Runtime, run } from './app.js';
export { type ClientOptions, type ListQuery, ReqrayClient, type StreamHandlers } from './client.js';
export {
  CliError,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  UnreachableError,
  UsageError,
} from './errors.js';
export { matches, type StreamFilter } from './filter.js';
export { DEFAULT_URL, type Globals, normalizeUrl } from './options.js';
export { failureLines, streamHead, streamRow } from './render/row.js';
export { emptyState, header, renderFailure } from './render/screens.js';
export { plainTheme, resolveTheme, type Theme } from './render/theme.js';
export { fitPath, MIN_WIDTH, streamColumns } from './render/width.js';
