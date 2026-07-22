import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  stageProvenance,
  stagedExecutable,
  stagedManifest,
  stagedSchema,
  validateRuntime,
} from './stage-runtime.ts';

export async function assertStagedRuntime(expectedSource) {
  if (!['release', 'deterministic'].includes(expectedSource)) {
    throw new Error('Expected stage source must be release or deterministic.');
  }
  const provenance = JSON.parse(await readFile(stageProvenance, 'utf8'));
  if (provenance.source !== expectedSource) {
    throw new Error(
      `Refusing to build: staged runtime source is ${String(provenance.source)}, expected ${expectedSource}.`,
    );
  }
  const verified = await validateRuntime(
    stagedManifest,
    stagedExecutable,
    stagedSchema,
  );
  if (verified.manifest.runtimeVersion !== provenance.runtimeVersion) {
    throw new Error(
      'Runtime staging provenance version does not match its manifest.',
    );
  }
  if (verified.schemaDigest !== provenance.schemaSha256) {
    throw new Error(
      'Runtime staging provenance schema digest does not match its manifest.',
    );
  }
  if (
    (verified.manifest.runtimeRequirements?.['windowsml-ocr']?.sha256 ??
      null) !== provenance.windowsmlBundleSha256
  ) {
    throw new Error(
      'Runtime staging provenance WindowsML digest does not match its manifest.',
    );
  }
  if (
    verified.manifest.runtimeRequirements['windowsml-ocr'].bytes !==
    provenance.windowsmlBundleBytes
  ) {
    throw new Error(
      'Runtime staging provenance WindowsML byte count does not match its manifest.',
    );
  }
  return { provenance, ...verified };
}

function expectedSource(args) {
  if (
    args.length !== 1 ||
    !['--release', '--deterministic'].includes(args[0])
  ) {
    throw new Error('Use exactly one of --release or --deterministic.');
  }
  return args[0] === '--release' ? 'release' : 'deterministic';
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  Promise.resolve()
    .then(() => expectedSource(process.argv.slice(2)))
    .then(assertStagedRuntime)
    .then(({ provenance }) => {
      process.stdout.write(
        `Verified ${provenance.source} staged runtime provenance.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
