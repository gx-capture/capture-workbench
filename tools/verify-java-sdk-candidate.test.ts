import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { verifyJavaSdkCandidate } from './verify-java-sdk-candidate.ts';

const version = '0.4.0';
const sourceCommit = 'a'.repeat(40);
const contractSetSha256 = 'b'.repeat(64);

function digest(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'capture-java-candidate-'));
  await mkdir(join(root, 'maven')); await mkdir(join(root, 'checksums'));
  const files = [
    `capture-runtime-client-${version}.jar`,
    `capture-runtime-client-${version}-sources.jar`,
    'pom.xml',
    'capture-runtime-contract-set.sha256',
  ];
  const entries = [] as Array<{ path: string; bytes: number; sha256: string }>;
  for (const file of files) {
    const path = `maven/${file}`;
    const value = Buffer.from(
      file === 'capture-runtime-contract-set.sha256'
        ? `${contractSetSha256}\n`
        : `${file}\n`,
    );
    await writeFile(join(root, path), value);
    const item = { path, bytes: value.length, sha256: digest(value) };
    entries.push(item);
    await writeFile(
      join(root, 'checksums', `${path.replaceAll('/', '__')}.sha256`),
      `${item.sha256}  ${path}\n`,
    );
  }
  const base = { schemaVersion: '1', candidateKind: 'maven-java-sdk', sourceCommit, releaseVersion: version, producerRunId: 123, coordinates: { groupId: 'com.gx.capture', artifactId: 'capture-runtime-client', packaging: 'jar' }, contractSetSha256, artifacts: entries.sort((a, b) => a.path.localeCompare(b.path)), toolchains: { java: 'test', maven: 'test' } };
  const candidateId = digest(JSON.stringify(base)); const manifest = { ...base, candidateId }; const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); await writeFile(join(root, 'java-candidate-manifest.json'), manifestBytes); return { root, candidateId, candidateManifestSha256: digest(manifestBytes) };
}

test('Maven candidate verification requires exact contract hash and artifact inventory', async () => {
  const candidate = await fixture();
  try { await assert.doesNotReject(() => verifyJavaSdkCandidate({ candidate: candidate.root, version, sourceCommit, candidateId: candidate.candidateId, candidateManifestSha256: candidate.candidateManifestSha256, contractSetSha256 })); } finally { await rm(candidate.root, { recursive: true, force: true }); }
});

test('Maven candidate rejects a different contract-set hash', async () => {
  const candidate = await fixture();
  try { await assert.rejects(() => verifyJavaSdkCandidate({ candidate: candidate.root, version, sourceCommit, candidateId: candidate.candidateId, candidateManifestSha256: candidate.candidateManifestSha256, contractSetSha256: 'c'.repeat(64) }), /bbbb|contract/u); } finally { await rm(candidate.root, { recursive: true, force: true }); }
});

test('Maven publication promotion requires a complete ledger', async () => {
  const candidate = await fixture();
  try { await assert.rejects(() => verifyJavaSdkCandidate({ candidate: candidate.root, version, sourceCommit, candidateId: candidate.candidateId, candidateManifestSha256: candidate.candidateManifestSha256, contractSetSha256, requireLedger: true }), /maven-ledger/u); } finally { await rm(candidate.root, { recursive: true, force: true }); }
});
