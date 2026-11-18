// Same as esm-app.mjs, but a CommonJS app.
const { getDiagnostics, isPatched, renderDiagnostics } = require('@reqray/core');
const pg = require('pg');

console.log(
  JSON.stringify({
    patched: isPatched(pg.Client.prototype, 'query'),
    diagnostics: renderDiagnostics(getDiagnostics()),
  }),
);
