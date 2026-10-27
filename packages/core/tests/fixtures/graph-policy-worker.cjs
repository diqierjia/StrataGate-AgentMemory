// Real Core + SQLite in another OS process; the hook only transpiles TS imports.
const { registerHooks } = require('node:module');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const ts = require('typescript');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
(async () => {
  const { StrataGate } = await import(process.argv[4]);
  const memory = await StrataGate.open({ database: process.argv[2], namespace: process.argv[3], graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) });
  process.on('message', async ({ command, jobId }) => {
    try {
      if (command === 'complete') await memory.completeGraphProjection(jobId, { reason: 'none', nodes: [], edges: [] });
      else if (command === 'claim') {
        await memory.reloadFromStorage();
        const job = await memory.claimNextGraphProjection();
        process.send({ jobId: job?.jobId ?? null, ids: job?.events.map(event => event.id) ?? [] });
        return;
      } else throw new Error('Unknown test command');
      process.send({ jobId, ids: [] });
    } catch (error) { process.send({ error: String(error), jobId: null, ids: [] }); }
  });
  process.send({ ready: true });
})().catch(error => { process.stderr.write(String(error)); process.exit(1); });
