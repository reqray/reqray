// An app that loads pg with a plain ESM import — that is, AFTER
// `--import @reqray/register` has installed the hooks.
import { getDiagnostics, isPatched, renderDiagnostics } from '@reqray/core';
import pg from 'pg';

console.log(
  JSON.stringify({
    // Asked through core rather than by naming a symbol here: how a patch is
    // marked is the kit's business, and a fixture that spells the marker out
    // is a second copy of that rule.
    patched: isPatched(pg.Client.prototype, 'query'),
    diagnostics: renderDiagnostics(getDiagnostics()),
  }),
);
