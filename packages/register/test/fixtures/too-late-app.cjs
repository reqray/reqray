// Worst case: the app loaded the driver BEFORE it pulled in Reqray. The hook is
// powerless here — what matters is that this is reported honestly.
const pg = require('pg');
require('node:process').env.REQRAY_LOADED_PG = '1';

const registerPath = process.argv[2];
require(registerPath);

const { getDiagnostics, isPatched, renderDiagnostics } = require('@reqray/core');

console.log(
  JSON.stringify({
    patched: isPatched(pg.Client.prototype, 'query'),
    diagnostics: renderDiagnostics(getDiagnostics()),
  }),
);
