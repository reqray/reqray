// Same as esm-app.mjs, but a CommonJS app.
const { getDiagnostics, renderDiagnostics } = require('@loupe/core');
const pg = require('pg');

const PATCHED = Symbol.for('loupe.patched.pg');

console.log(
  JSON.stringify({
    patched: Boolean(pg.Client.prototype[PATCHED]),
    diagnostics: renderDiagnostics(getDiagnostics()),
  }),
);
