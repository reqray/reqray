// Core loaded as CJS and as ESM at the same time. This happens in a real app:
// the adapter came in via import, the loader hook via require. Both copies must
// see the same request context.
const cjsCore = require('@reqray/core');

(async () => {
  const esmCore = await import('@reqray/core');

  const options = cjsCore.resolveOptions({ mode: 'development' });
  const scope = new cjsCore.RequestScope({ id: 'dual', method: 'GET', path: '/', options });

  console.log(
    JSON.stringify({
      separateCopies: esmCore.RequestScope !== cjsCore.RequestScope,
      esmSeesCjsScope: cjsCore.runInScope(scope, () => esmCore.current()?.id ?? null),
      cjsSeesEsmScope: esmCore.runInScope(scope, () => cjsCore.current()?.id ?? null),
    }),
  );
})();
