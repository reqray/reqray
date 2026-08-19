// Worst case: the app loaded the driver BEFORE it pulled in Loupe. The hook is
// powerless here — what matters is that this is reported honestly.
const pg = require('pg');
require('node:process').env.LOUPE_LOADED_PG = '1';

const registerPath = process.argv[2];
require(registerPath);

const { getDiagnostics, renderDiagnostics } = require('@loupe/core');
const PATCHED = Symbol.for('loupe.patched.pg');

console.log(
  JSON.stringify({
    patched: Boolean(pg.Client.prototype[PATCHED]),
    diagnostics: renderDiagnostics(getDiagnostics()),
  }),
);
