// An app that loads pg with a plain ESM import — that is, AFTER
// `--import @loupe/register` has installed the hooks.
import { getDiagnostics, renderDiagnostics } from '@loupe/core';
import pg from 'pg';

const PATCHED = Symbol.for('loupe.patched.pg');

console.log(
  JSON.stringify({
    patched: Boolean(pg.Client.prototype[PATCHED]),
    diagnostics: renderDiagnostics(getDiagnostics()),
  }),
);
