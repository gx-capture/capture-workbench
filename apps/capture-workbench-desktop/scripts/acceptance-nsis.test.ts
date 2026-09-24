import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildAcceptanceNsis,
  finalizeAcceptanceNsis,
} from './acceptance-nsis.ts';

const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const HEAD = 'a'.repeat(40);
const RUNTIME_SHA = 'b'.repeat(64);
const RUNTIME_MANIFEST_SHA = 'c'.repeat(64);

async function createBundle(targetDir: string, installerNames = ['Capture Workbench_0.4.2_x64-setup.exe']) {
  const bundle = join(targetDir, TARGET_TRIPLE, 'release', 'bundle', 'nsis');
  await mkdir(bundle, { recursive: true });
  for (const [index, installerName] of installerNames.entries()) {
    await writeFile(join(bundle, installerName), `installer-${index}`, 'utf8');
  }
  return bundle;
}

test('acceptance NSIS finalizer requires one installer and rejects collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-acceptance-nsis-finalizer-'));
  try {
    const targetDir = join(root, 'target');
    await createBundle(targetDir, ['one.exe', 'two.exe']);
    await assert.rejects(
      finalizeAcceptanceNsis({
        targetDir,
        sourceHead: HEAD,
        stagedRuntimeSha256: RUNTIME_SHA,
        runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
      }),
      /exactly one installer/u,
    );
    assert.equal(await lstat(join(targetDir, TARGET_TRIPLE, 'release', 'bundle', 'nsis-acceptance')).catch(() => undefined), undefined);

    const collisionTarget = join(root, 'collision-target');
    const bundle = await createBundle(collisionTarget);
    const destination = join(collisionTarget, TARGET_TRIPLE, 'release', 'bundle', 'nsis-acceptance');
    await mkdir(destination);
    await assert.rejects(
      finalizeAcceptanceNsis({
        targetDir: collisionTarget,
        sourceHead: HEAD,
        stagedRuntimeSha256: RUNTIME_SHA,
        runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
      }),
      /already exists/u,
    );
    assert.equal(await lstat(bundle).then(() => true), true);

    const provenanceCollisionTarget = join(root, 'provenance-collision-target');
    const provenanceCollisionBundle = await createBundle(provenanceCollisionTarget);
    const provenancePath = join(
      provenanceCollisionBundle,
      'capture-workbench-acceptance-nsis.provenance.json',
    );
    await writeFile(provenancePath, 'pre-existing', 'utf8');
    await assert.rejects(
      finalizeAcceptanceNsis({
        targetDir: provenanceCollisionTarget,
        sourceHead: HEAD,
        stagedRuntimeSha256: RUNTIME_SHA,
        runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
      }),
      /provenance file already exists/u,
    );
    assert.equal(await readFile(provenancePath, 'utf8'), 'pre-existing');
    assert.equal(
      await lstat(join(provenanceCollisionTarget, TARGET_TRIPLE, 'release', 'bundle', 'nsis-acceptance'))
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance NSIS output is isolated and provenance binds the built installer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-acceptance-nsis-build-'));
  try {
    const formalBundle = join(root, 'formal', 'nsis');
    await mkdir(formalBundle, { recursive: true });
    const formalBytes = Buffer.from('formal-release-installer');
    await writeFile(join(formalBundle, 'release.exe'), formalBytes);
    const targetParent = join(root, 'acceptance-runs');
    const result = await buildAcceptanceNsis({
      formalBundleRoot: formalBundle,
      targetParent,
      sourceHead: HEAD,
      stagedRuntimeSha256: RUNTIME_SHA,
      runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
      runTauriBuild: async ({ cargoTargetDir }) => {
        assert.notEqual(cargoTargetDir, formalBundle);
        assert.ok(cargoTargetDir.startsWith(targetParent));
        await createBundle(cargoTargetDir);
      },
    });
    assert.ok(result.outputDirectory.startsWith(targetParent));
    assert.equal((await readFile(join(formalBundle, 'release.exe'))).equals(formalBytes), true);
    const provenance = JSON.parse(await readFile(result.provenancePath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(provenance, {
      schemaVersion: 1,
      sourceHead: HEAD,
      buildFlavor: 'acceptance',
      tauriBundleTarget: 'nsis',
      targetTriple: TARGET_TRIPLE,
      cargoFeature: 'acceptance-app-data',
      stagedRuntimeSha256: RUNTIME_SHA,
      runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
      installer: {
        fileName: 'Capture Workbench_0.4.2_x64-setup.exe',
        bytes: 11,
        sha256: '1926123787d3259ad378dd81bdac48e28b07f1bc88e070c0ef3a9e0a6621f459',
      },
      outputDirectory: 'nsis-acceptance',
      releaseOutputDirectory: 'nsis',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance NSIS build failure leaves no accepted output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-acceptance-nsis-failure-'));
  try {
    const formalBundle = join(root, 'formal', 'nsis');
    await mkdir(formalBundle, { recursive: true });
    const targetParent = join(root, 'acceptance-runs');
    await assert.rejects(
      buildAcceptanceNsis({
        formalBundleRoot: formalBundle,
        targetParent,
        sourceHead: HEAD,
        stagedRuntimeSha256: RUNTIME_SHA,
        runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
        runTauriBuild: async () => {
          throw new Error('synthetic tauri failure');
        },
      }),
      /synthetic tauri failure/u,
    );
    assert.deepEqual(await readdirNames(targetParent), []);
    assert.equal(await lstat(formalBundle).then(() => true), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readdirNames(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(path);
}
