// Loaded with `node --import ./test/helpers/setup.mjs --test ...` (scripts/test.mjs does this).
// A process warning raised from motionex's own code fails the run (contavex: filterwarnings=error).
// Warnings from dependencies (node_modules, vendor/) and ExperimentalWarning are ignored.
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning') return;
  const stack = String(w.stack ?? '');
  const ours = /[\\/](src|tools|bin|lib|scripts|test)[\\/]/.test(stack) && !/node_modules|[\\/]vendor[\\/]/.test(stack);
  if (ours) throw w;
});
