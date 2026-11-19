// eslint-disable-next-line @nx/enforce-module-boundaries -- shared test temp-root guard.
import '../../../tools/test-temp-root.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- repository tooling reads shared release intent.
import { RELEASE_VERSION } from '../../../tools/release/release-intent.ts';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ACCEPTANCE_NSIS_TARGET_NAME,
  buildAcceptanceNsis,
  finalizeAcceptanceNsis,
} from './acceptance-nsis.ts';

const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const HEAD = 'a'.repeat(40);
const RUNTIME_SHA = 'b'.repeat(64);
const RUNTIME_MANIFEST_SHA = 'c'.repeat(64);

async function createBundle(targetDir: string, installerNames = [`Capture Workbench_${RELEASE_VERSION}_x64-setup.exe`]) {
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
      cargoFeature: 'acceptance-harness',
      stagedRuntimeSha256: RUNTIME_SHA,
      runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
      installer: {
        fileName: `Capture Workbench_${RELEASE_VERSION}_x64-setup.exe`,
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
        runTauriBuild: async ({ cargoTargetDir }) => {
          await createBundle(cargoTargetDir);
          await writeFile(join(cargoTargetDir, 'compiled-crate.rlib'), 'cache', 'utf8');
          throw new Error('synthetic tauri failure');
        },
      }),
      /synthetic tauri failure/u,
    );
    const targetDir = join(targetParent, ACCEPTANCE_NSIS_TARGET_NAME);
    assert.deepEqual(await readdirNames(targetParent), [ACCEPTANCE_NSIS_TARGET_NAME]);
    const bundleRoot = join(targetDir, TARGET_TRIPLE, 'release', 'bundle');
    assert.deepEqual(await readdirNames(bundleRoot).catch(() => []), []);
    assert.equal(await readFile(join(targetDir, 'compiled-crate.rlib'), 'utf8'), 'cache');
    assert.equal(await lstat(formalBundle).then(() => true), true);

    await assert.rejects(
      buildAcceptanceNsis({
        formalBundleRoot: formalBundle,
        targetParent,
        sourceHead: HEAD,
        stagedRuntimeSha256: RUNTIME_SHA,
        runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
        runTauriBuild: async ({ cargoTargetDir }) => {
          await createBundle(cargoTargetDir);
          await writeFile(join(formalBundle, 'release.exe'), 'changed during the build', 'utf8');
        },
      }),
      /Formal release NSIS bundle changed/u,
    );
    assert.deepEqual(await readdirNames(bundleRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance NSIS builds reuse one Cargo target and replace the earlier bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-acceptance-nsis-reuse-'));
  try {
    const formalBundle = join(root, 'formal', 'nsis');
    await mkdir(formalBundle, { recursive: true });
    const targetParent = join(root, 'acceptance-runs');
    const targets: string[] = [];
    const build = (installerName: string) =>
      buildAcceptanceNsis({
        formalBundleRoot: formalBundle,
        targetParent,
        sourceHead: HEAD,
        stagedRuntimeSha256: RUNTIME_SHA,
        runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
        runTauriBuild: async ({ cargoTargetDir }) => {
          targets.push(cargoTargetDir);
          await writeFile(join(cargoTargetDir, 'compiled-crate.rlib'), installerName, { flag: 'a' });
          await createBundle(cargoTargetDir, [installerName]);
        },
      });
    const first = await build('first-setup.exe');
    const second = await build('second-setup.exe');
    assert.equal(targets.length, 2);
    assert.equal(targets[0], targets[1]);
    assert.equal(targets[0], join(targetParent, ACCEPTANCE_NSIS_TARGET_NAME));
    assert.deepEqual(await readdirNames(targetParent), [ACCEPTANCE_NSIS_TARGET_NAME]);
    assert.equal(second.outputDirectory, first.outputDirectory);
    assert.equal(second.installerFileName, 'second-setup.exe');
    assert.deepEqual((await readdirNames(second.outputDirectory)).sort(), [
      'capture-workbench-acceptance-nsis.provenance.json',
      'second-setup.exe',
    ]);
    assert.deepEqual(await readdirNames(join(targets[0], TARGET_TRIPLE, 'release', 'bundle')), [
      'nsis-acceptance',
    ]);
    assert.equal(
      await readFile(join(targets[0], 'compiled-crate.rlib'), 'utf8'),
      'first-setup.exesecond-setup.exe',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed later build keeps the installer accepted before it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-acceptance-nsis-keep-accepted-'));
  try {
    const formalBundle = join(root, 'formal', 'nsis');
    await mkdir(formalBundle, { recursive: true });
    const targetParent = join(root, 'acceptance-runs');
    const build = (runTauriBuild: (cargoTargetDir: string) => Promise<void>) =>
      buildAcceptanceNsis({
        formalBundleRoot: formalBundle,
        targetParent,
        sourceHead: HEAD,
        stagedRuntimeSha256: RUNTIME_SHA,
        runtimeManifestSha256: RUNTIME_MANIFEST_SHA,
        runTauriBuild: ({ cargoTargetDir }) => runTauriBuild(cargoTargetDir),
      });
    const first = await build(async (cargoTargetDir) => {
      await createBundle(cargoTargetDir, ['first-setup.exe']);
    });
    const firstProvenance = await readFile(first.provenancePath, 'utf8');
    const assertFirstAccepted = async () => {
      assert.deepEqual((await readdirNames(first.outputDirectory)).sort(), [
        'capture-workbench-acceptance-nsis.provenance.json',
        'first-setup.exe',
      ]);
      assert.equal(await readFile(first.provenancePath, 'utf8'), firstProvenance);
      assert.deepEqual(await readdirNames(join(first.targetDir, TARGET_TRIPLE, 'release', 'bundle')), [
        'nsis-acceptance',
      ]);
    };

    await assert.rejects(
      build(async (cargoTargetDir) => {
        await createBundle(cargoTargetDir, ['second-setup.exe']);
        throw new Error('synthetic tauri failure');
      }),
      /synthetic tauri failure/u,
    );
    await assertFirstAccepted();

    await assert.rejects(
      build(async (cargoTargetDir) => {
        await createBundle(cargoTargetDir, ['second-setup.exe', 'third-setup.exe']);
      }),
      /exactly one installer/u,
    );
    await assertFirstAccepted();

    await assert.rejects(
      build(async (cargoTargetDir) => {
        await createBundle(cargoTargetDir, ['second-setup.exe']);
        await writeFile(join(formalBundle, 'release.exe'), 'changed during the build', 'utf8');
      }),
      /Formal release NSIS bundle changed/u,
    );
    await assertFirstAccepted();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readdirNames(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(path);
}
