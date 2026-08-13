import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyRuntimeCandidateBinding } from './verify-runtime-candidate-binding.ts';

const candidateId = 'c'.repeat(64);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function makeCandidates() {
  const runtime = await mkdtemp(join(tmpdir(), 'capture-runtime-binding-'));
  const desktop = await mkdtemp(join(tmpdir(), 'capture-desktop-binding-'));
  for (const root of [runtime, desktop]) {
    for (const directory of ['runtime', 'python', 'crate', 'contracts'])
      await mkdir(join(root, directory));
  }
  const artifacts = [
    ['runtime/capture-runtime.exe', 'runtime'],
    ['python/capture_contracts.whl', 'contracts'],
    ['crate/capture-sidecar-launcher.crate', 'crate'],
    ['contracts/contract-snapshot.json', '{"schemaVersion":"1"}\n'],
  ];
  for (const [path, value] of artifacts) {
    await writeFile(join(runtime, path), value);
    await writeFile(join(desktop, path), value);
  }
  await writeFile(
    join(runtime, 'candidate-manifest.json'),
    JSON.stringify({
      candidateKind: 'runtime',
      candidateId,
      sourceCommit: 'a'.repeat(40),
      releaseVersion: '0.3.12',
      releaseMode: 'core-only',
      artifacts: artifacts.map(([path, value]) => ({
        path,
        bytes: Buffer.byteLength(value),
        sha256: digest(value),
      })),
    }),
  );
  await writeFile(
    join(desktop, 'candidate-manifest.json'),
    JSON.stringify({
      runtimeCandidateId: candidateId,
      sourceCommit: 'a'.repeat(40),
      releaseVersion: '0.3.12',
      releaseMode: 'core-only',
      artifacts: artifacts.map(([path, value]) => ({
        path,
        bytes: Buffer.byteLength(value),
        sha256: digest(value),
      })),
    }),
  );
  return { runtime, desktop };
}

test('desktop candidate binds exact runtime candidate bytes', async () => {
  const candidates = await makeCandidates();
  try {
    await assert.doesNotReject(() =>
      verifyRuntimeCandidateBinding({
        desktopCandidate: candidates.desktop,
        runtimeCandidate: candidates.runtime,
        candidateId,
      }),
    );
  } finally {
    await rm(candidates.runtime, { recursive: true, force: true });
    await rm(candidates.desktop, { recursive: true, force: true });
  }
});

test('desktop candidate binding rejects changed runtime bytes', async () => {
  const candidates = await makeCandidates();
  try {
    await writeFile(
      join(candidates.desktop, 'runtime/capture-runtime.exe'),
      'tampered',
    );
    await assert.rejects(
      () =>
        verifyRuntimeCandidateBinding({
          desktopCandidate: candidates.desktop,
          runtimeCandidate: candidates.runtime,
          candidateId,
        }),
      /runtime bytes differ|digest is not self-consistent/u,
    );
  } finally {
    await rm(candidates.runtime, { recursive: true, force: true });
    await rm(candidates.desktop, { recursive: true, force: true });
  }
});
