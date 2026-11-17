// Proves the product binary cannot be built with the dev-host feature.
// Node executes this file directly; keep the syntax erasable.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const checker = join(scriptDirectory, 'cargo-deterministic-qa.ts');
// cargo-deterministic-qa inherits this process's stdio, so rustc's compile_error
// text lands in the pipes captured here.
const result = spawnSync(
  process.execPath,
  [checker, 'check', '--features', 'dev-host', '--bin', 'capture-workbench-desktop'],
  {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
if (result.error) {
  console.error(output);
  throw result.error;
}
if ((result.status ?? 1) !== 0 && output.includes('must not be built with')) {
  process.exit(0);
}
console.error(output);
process.exit(1);
