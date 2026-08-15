import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { verifyRuntimeCandidate } from './verify-runtime-candidate.ts';

const VERSION = '0.4.0';
const SOURCE_COMMIT = 'a'.repeat(40);
const PACKAGE_CANDIDATE_ID = 'b'.repeat(64);

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createCandidate() {
  const root = await mkdtemp(join(tmpdir(), 'capture-runtime-candidate-'));
  for (const directory of [
    'runtime',
    'python',
    'crate',
    'contracts',
    'checksums',
  ])
    await mkdir(join(root, directory));
  const schema = Buffer.from('{"title":"CaptureDocument"}\n');
  await writeFile(
    join(root, 'runtime/capture-document-v2.schema.json'),
    schema,
  );
  await writeFile(
    join(root, 'runtime/capture-runtime-manifest.json'),
    JSON.stringify({
      runtimeVersion: VERSION,
      schemaFileName: 'capture-document-v2.schema.json',
      schemaSha256: digest(schema),
    }),
  );
  await writeFile(
    join(root, 'runtime/capture-engine-catalog.json'),
    JSON.stringify({ runtimeVersion: VERSION, requirements: [] }),
  );
  await writeFile(join(root, 'runtime/capture-runtime-x64.exe'), 'runtime');
  const packageFiles = [
    'capture_runtime_client-0.4.0-py3-none-any.whl',
    'capture_runtime_client-0.4.0.tar.gz',
    'capture_structuring-0.4.0-py3-none-any.whl',
    'capture_structuring-0.4.0.tar.gz',
  ];
  for (const name of packageFiles)
    await writeFile(join(root, 'python', name), name);
  await writeFile(
    join(root, 'crate/capture-sidecar-launcher-0.4.0.crate'),
    'crate',
  );
  await writeFile(
    join(root, 'contracts/contract-snapshot.json'),
    '{"schemaVersion":"1"}\n',
  );
  const contractSet = Buffer.from('{"contractSetVersion":"2"}\n');
  const contractSetSha256 = digest(contractSet);
  await writeFile(join(root, 'contracts/contract-set.json'), contractSet);
  await writeFile(
    join(root, 'contracts/contract-set.sha256'),
    `${contractSetSha256}\n`,
  );

  const artifacts = [];
  for (const directory of ['runtime', 'python', 'crate', 'contracts']) {
    const names = await (
      await import('node:fs/promises')
    ).readdir(join(root, directory));
    for (const name of names) {
      const path = `${directory}/${name}`;
      const bytes = await readFile(join(root, path));
      const item = { path, bytes: bytes.byteLength, sha256: digest(bytes) };
      artifacts.push(item);
      await writeFile(
        join(root, 'checksums', `${path.replaceAll('/', '__')}.sha256`),
        `${item.sha256}  ${path}\n`,
      );
    }
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const baseManifest = {
    schemaVersion: '1',
    candidateKind: 'runtime',
    sourceCommit: SOURCE_COMMIT,
    releaseVersion: VERSION,
    releaseMode: 'core-only',
    producerRunId: 42,
    packageCandidateId: PACKAGE_CANDIDATE_ID,
    contractSetSha256,
    artifacts,
    toolchains: { node: 'v24.0.0', python: '3.12', runtime: 'capture-runtime' },
  };
  const candidateId = digest(Buffer.from(JSON.stringify(baseManifest)));
  await writeFile(
    join(root, 'candidate-manifest.json'),
    JSON.stringify({ ...baseManifest, candidateId }),
  );
  const manifestBytes = await readFile(join(root, 'candidate-manifest.json'));
  await writeFile(
    join(root, 'runtime-product.json'),
    JSON.stringify({
      schemaVersion: '1',
      candidateId,
      verification: 'runtime-product',
      status: 'success',
    }),
  );
  return {
    root,
    candidateId,
    manifestSha256: digest(manifestBytes),
    contractSetSha256,
  };
}

test('runtime candidate verification binds runtime and reusable producer artifacts', async () => {
  const candidate = await createCandidate();
  try {
    await verifyRuntimeCandidate({
      candidate: candidate.root,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      producerRunId: 42,
      candidateId: candidate.candidateId,
      candidateManifestSha256: candidate.manifestSha256,
      packageCandidateId: PACKAGE_CANDIDATE_ID,
      contractSetSha256: candidate.contractSetSha256,
      requireEvidence: true,
    });
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('runtime candidate verification rejects changed runtime bytes', async () => {
  const candidate = await createCandidate();
  try {
    await writeFile(
      join(candidate.root, 'runtime/capture-runtime-x64.exe'),
      'tampered',
    );
    await assert.rejects(
      verifyRuntimeCandidate({
        candidate: candidate.root,
        version: VERSION,
        sourceCommit: SOURCE_COMMIT,
        producerRunId: 42,
        candidateId: candidate.candidateId,
        candidateManifestSha256: candidate.manifestSha256,
        packageCandidateId: PACKAGE_CANDIDATE_ID,
        contractSetSha256: candidate.contractSetSha256,
      }),
      /Expected values|digest differs|checksum mismatch/u,
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('runtime candidate verification rejects a different requested contract set', async () => {
  const candidate = await createCandidate();
  try {
    await assert.rejects(
      verifyRuntimeCandidate({
        candidate: candidate.root,
        version: VERSION,
        sourceCommit: SOURCE_COMMIT,
        producerRunId: 42,
        candidateId: candidate.candidateId,
        candidateManifestSha256: candidate.manifestSha256,
        packageCandidateId: PACKAGE_CANDIDATE_ID,
        contractSetSha256: 'f'.repeat(64),
      }),
      /contract-set SHA-256 differs/u,
    );
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
});
