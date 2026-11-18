/**
 * `@reqray/core/testing` — putting the process back the way it was found.
 *
 * Core keeps state on `globalThis` — the request context, the caches, the
 * learned callsites, which detectors disabled themselves — because one process
 * must have one of each whether core arrives once or twice. The cost is that a
 * test file leaves marks on the next one; these scrub them off.
 *
 * Here rather than on the main entry because they are not part of what the
 * library does.
 */

export { resetLearnedCallsites } from './callsite.js';
export { resetDetectors } from './detectors/index.js';
export { clearDiagnostics, resetDiagnosticsPrinted } from './diagnostics.js';
export { resetExplainTargets } from './explain-targets.js';
export { clearHttpFingerprints } from './http-fingerprint.js';
export { resetWarnings } from './logger.js';
export { clearBlameCache } from './panel/blame.js';
export { clearGitHead } from './panel/project.js';
export { resetPools } from './pools.js';
export { resetAdapterActive } from './presence.js';
export { clearSqlCaches } from './sql.js';
