import './test-temp-root.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createCandidateLayout,
  requireInstalledSizeReport,
  stageRuntimeReleaseAssets,
  verifyPackageContractSet,
} from './assemble-release-candidate.ts';

test('release assembly requires the package candidate contract set to match the release', async () => {
  const candidate = await mkdtemp(join(tmpdir(), 'package-contract-binding-'));
  const contractSetSha256 = 'a'.repeat(64);
  const manifestPath = join(candidate, 'candidate-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ contractSetSha256 }));
  await verifyPackageContractSet(candidate, contractSetSha256);
  await assert.rejects(
    verifyPackageContractSet(candidate, 'b'.repeat(64)),
    /different contract set/u,
  );
  await writeFile(manifestPath, '{}');
  await assert.rejects(
    verifyPackageContractSet(candidate, contractSetSha256),
    /different contract set/u,
  );
});

test('runtime staging rejects a candidate that still has a checksum sidecar or the size report', async () => {
  const clean = await mkdtemp(join(tmpdir(), 'runtime-source-'));
  const destination = await mkdtemp(join(tmpdir(), 'runtime-staged-'));
  await writeFile(join(clean, 'capture-runtime-manifest.json'), '{}\n');
  await writeFile(join(clean, 'capture-engine-ocr-files.json'), '{}\n');
  assert.deepEqual(
    [...(await stageRuntimeReleaseAssets(clean, destination))],
    ['capture-engine-ocr-files.json', 'capture-runtime-manifest.json'],
  );
  for (const name of [
    'capture-runtime-manifest.json.sha256',
    'runtime-size-report.json',
  ]) {
    const source = await mkdtemp(join(tmpdir(), 'runtime-source-'));
    await writeFile(join(source, 'capture-runtime-manifest.json'), '{}\n');
    await writeFile(join(source, name), 'not a release asset\n');
    await assert.rejects(
      stageRuntimeReleaseAssets(
        source,
        await mkdtemp(join(tmpdir(), 'runtime-staged-')),
      ),
      /not a GitHub Release asset[\s\S]*rebuild the runtime candidate/u,
    );
  }
});

test('assembly leaves the size report out of the candidate and rejects a report that misses the installer', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'release-candidate-'));
  const candidate = join(parent, 'candidate');
  await createCandidateLayout(candidate);
  const installer = {
    fileName: 'Capture Workbench_1.2.3_x64-setup.exe',
    bytes: 4,
    sha256: 'ab'.repeat(32),
  };
  const reportDirectory = await mkdtemp(join(tmpdir(), 'size-report-'));
  const reportPath = join(reportDirectory, 'runtime-size-report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      nsisInstaller: { ...installer, bytes: installer.bytes + 1 },
    }),
  );
  await assert.rejects(
    requireInstalledSizeReport(reportPath, installer),
    /does not bind the Tauri-generated installer/u,
  );
  await assert.rejects(
    requireInstalledSizeReport(join(reportDirectory, 'missing.json'), installer),
    /ENOENT/u,
  );
  await writeFile(
    reportPath,
    JSON.stringify({ nsisInstaller: installer }),
  );
  await requireInstalledSizeReport(reportPath, installer);
  assert.deepEqual((await readdir(candidate)).sort(), [
    'checksums',
    'contracts',
    'crate',
    'desktop',
    'package',
    'python',
    'runtime',
  ]);
  const nested = (await readdir(candidate, { recursive: true })).map(String);
  assert.equal(
    nested.some((entry) => entry.endsWith('runtime-size-report.json')),
    false,
  );
});
