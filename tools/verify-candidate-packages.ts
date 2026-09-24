import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  assertPackedPackageIdentity,
  inspectPackedPackageManifest,
} from './verify-packed-package.ts';

function parseArguments(args: readonly string[]) {
  if (
    args.length !== 4 ||
    args[0] !== '--candidate' ||
    args[2] !== '--version'
  ) {
    throw new Error('Use --candidate <directory> --version <semver>.');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(args[3])) {
    throw new Error('Candidate package version is invalid.');
  }
  return { candidate: resolve(args[1]), version: args[3] };
}

const { candidate, version } = parseArguments(process.argv.slice(2));
const packageDirectory = join(candidate, 'package');
const expected = new Set([
  '@gx-capture/capture-workbench-ui',
  '@gx-capture/capture-runtime-client',
]);
const packageContractMetadataRequired = '@gx-capture/capture-runtime-client';
const candidateManifest = JSON.parse(
  readFileSync(join(candidate, 'candidate-manifest.json'), 'utf8'),
) as { contractSetSha256?: unknown };
if (
  typeof candidateManifest.contractSetSha256 !== 'string' ||
  !/^[0-9a-f]{64}$/u.test(candidateManifest.contractSetSha256)
) {
  throw new Error('Candidate contract-set digest is invalid.');
}
const contractSetSha256 = candidateManifest.contractSetSha256;
const contractSetShaPath = join(candidate, 'contracts', 'contract-set.sha256');
if (readFileSync(contractSetShaPath, 'utf8').trim() !== contractSetSha256) {
  throw new Error('Candidate contract-set digest differs from its manifest.');
}
const contractSetJsonPath = join(candidate, 'contracts', 'contract-set.json');
if (
  createHash('sha256')
    .update(readFileSync(contractSetJsonPath))
    .digest('hex') !== contractSetSha256
) {
  throw new Error('Candidate contract-set bundle digest differs.');
}
const archives = readdirSync(packageDirectory).filter((name) =>
  name.endsWith('.tgz'),
);
if (archives.length !== expected.size)
  throw new Error('Candidate package inventory is incomplete.');
const found = new Set<string>();
for (const archive of archives) {
  if (!statSync(join(packageDirectory, archive)).isFile())
    throw new Error('Candidate package is not a regular file.');
  const manifest = inspectPackedPackageManifest(
    join(packageDirectory, archive),
  );
  if (
    typeof manifest.name !== 'string' ||
    !expected.has(manifest.name) ||
    found.has(manifest.name)
  ) {
    throw new Error(`Candidate package identity is invalid: ${archive}.`);
  }
  assertPackedPackageIdentity(manifest, {
    name: manifest.name,
    version,
    contractSetSha256,
    requireContractSetSha256: manifest.name === packageContractMetadataRequired,
  });
  found.add(manifest.name);
  for (const dependency of [
    ...Object.values(manifest.dependencies ?? {}),
    ...Object.values(manifest.peerDependencies ?? {}),
  ]) {
    if (dependency === 'workspace:*')
      throw new Error(`Candidate package ${manifest.name} leaks workspace:*.`);
  }
}
if (found.size !== expected.size)
  throw new Error(
    'Candidate package inventory has missing package identities.',
  );
process.stdout.write(
  `Candidate package exports and dependency boundaries passed for ${version}.\n`,
);
