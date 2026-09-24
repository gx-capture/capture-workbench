import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeAcceptanceNsis } from './acceptance-nsis.ts';

function parseArguments(args: readonly string[]): {
  readonly targetDir: string;
  readonly sourceHead: string;
  readonly stagedRuntimeSha256: string;
  readonly runtimeManifestSha256: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || !name.startsWith('--')) {
      throw new Error('Acceptance NSIS finalizer arguments are invalid.');
    }
    values.set(name, value);
  }
  const targetDir = values.get('--target-dir');
  const sourceHead = values.get('--source-head');
  const stagedRuntimeSha256 = values.get('--staged-runtime-sha256');
  const runtimeManifestSha256 = values.get('--runtime-manifest-sha256');
  if (!targetDir || !sourceHead || !stagedRuntimeSha256 || !runtimeManifestSha256) {
    throw new Error('Acceptance NSIS finalizer requires target and identity arguments.');
  }
  return {
    targetDir: resolve(targetDir),
    sourceHead,
    stagedRuntimeSha256,
    runtimeManifestSha256,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  finalizeAcceptanceNsis(parseArguments(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`Acceptance NSIS bundle finalized at ${result.outputDirectory}.\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
