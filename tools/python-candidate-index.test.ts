import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  assemblePythonCandidateIndex,
  runPythonCandidateIndexHttpSmoke,
  verifyPythonCandidateIndex,
} from './python-candidate-index.ts';

const execFileAsync = promisify(execFile);

const SOURCE_COMMIT = 'b7c0e9776b3845f132d2f6eb9c4476041ae13099';
const CONTRACT_SHA = 'd'.repeat(64);

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function makeCandidate(root: string): Promise<string> {
  const python = join(root, 'python');
  await mkdir(python, { recursive: true });
  const wheel = Buffer.from('wheel-bytes');
  const source = Buffer.from('source-bytes');
  await writeFile(join(python, 'capture_runtime_client-0.4.2-py3-none-any.whl'), wheel);
  await writeFile(join(python, 'capture_runtime_client-0.4.2.tar.gz'), source);
  const packageManifest = {
    schemaVersion: '1',
    candidateKind: 'npm-package-set',
    releaseVersion: '0.4.2',
    packages: [],
  };
  const packageManifestBytes = Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`);
  await writeFile(join(root, 'package-manifest.json'), packageManifestBytes);
  const candidateBase = {
    schemaVersion: '1',
    candidateKind: 'npm-package-set',
    sourceCommit: SOURCE_COMMIT,
    releaseVersion: '0.4.2',
    producerRunId: 1,
    packageManifestSha256: sha256(packageManifestBytes),
    contractSetSha256: CONTRACT_SHA,
    artifacts: [
      { path: 'python/capture_runtime_client-0.4.2-py3-none-any.whl', bytes: wheel.length, sha256: sha256(wheel) },
      { path: 'python/capture_runtime_client-0.4.2.tar.gz', bytes: source.length, sha256: sha256(source) },
    ],
    toolchains: { node: 'v24.20.0', python: '3.12' },
  };
  const candidateId = sha256(JSON.stringify(candidateBase));
  await writeFile(
    join(root, 'candidate-manifest.json'),
    `${JSON.stringify({ ...candidateBase, candidateId }, null, 2)}\n`,
  );
  return candidateId;
}

async function makeRuntimeCandidate(root: string, packageCandidateId: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const base = {
    schemaVersion: '1',
    candidateKind: 'runtime',
    sourceCommit: SOURCE_COMMIT,
    releaseVersion: '0.4.2',
    releaseMode: 'model-enabled',
    producerRunId: 2,
    packageCandidateId,
    contractSetSha256: CONTRACT_SHA,
    artifacts: [],
    toolchains: { node: 'v24.20.0', python: '3.12', runtime: 'capture-runtime' },
  };
  const candidateId = sha256(JSON.stringify(base));
  await writeFile(
    join(root, 'candidate-manifest.json'),
    `${JSON.stringify({ ...base, candidateId }, null, 2)}\n`,
  );
  return candidateId;
}

async function makeGeneratedWheelCandidate(root: string): Promise<{ readonly packageCandidate: string; readonly runtimeCandidate: string }> {
  const packageCandidate = join(root, 'package-candidate');
  const runtimeCandidate = join(root, 'runtime-candidate');
  const python = join(packageCandidate, 'python');
  await mkdir(python, { recursive: true });
  const script = [
    'from pathlib import Path',
    'from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED',
    'import sys',
    'root = Path(sys.argv[1])',
    'files = {',
    `"capture_runtime_client/__init__.py": '__version__ = "0.4.2"\\n',`,
    '"capture_runtime_client-0.4.2.dist-info/METADATA": "Metadata-Version: 2.1\\nName: capture-runtime-client\\nVersion: 0.4.2\\nRequires-Python: >=3.12\\n",',
    '"capture_runtime_client-0.4.2.dist-info/WHEEL": "Wheel-Version: 1.0\\nGenerator: candidate-index-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",',
    '"capture_runtime_client-0.4.2.dist-info/RECORD": "capture_runtime_client/__init__.py,,\\ncapture_runtime_client-0.4.2.dist-info/METADATA,,\\ncapture_runtime_client-0.4.2.dist-info/WHEEL,,\\ncapture_runtime_client-0.4.2.dist-info/RECORD,,\\n",',
    '}',
    'with ZipFile(root / "capture_runtime_client-0.4.2-py3-none-any.whl", "w", ZIP_DEFLATED) as archive:',
    '  for name, text in files.items():',
    '    info = ZipInfo(name, (2024, 1, 1, 0, 0, 0)); info.compress_type = ZIP_DEFLATED; info.external_attr = 0o644 << 16; archive.writestr(info, text.encode())',
  ].join('\n');
  await execFileAsync('python', ['-c', script, python]);
  const wheel = await readFile(join(python, 'capture_runtime_client-0.4.2-py3-none-any.whl'));
  const source = Buffer.from('not-installed-by-poetry\n');
  await writeFile(join(python, 'capture_runtime_client-0.4.2.tar.gz'), source);
  const packageId = await writeCandidateManifest(packageCandidate, wheel, source, 'npm-package-set');
  await writeCandidateManifest(runtimeCandidate, Buffer.alloc(0), Buffer.alloc(0), 'runtime', packageId);
  return { packageCandidate, runtimeCandidate };
}

async function writeCandidateManifest(root: string, wheel: Buffer, source: Buffer, kind: string, packageCandidateId?: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const sourceCommit = SOURCE_COMMIT;
  const base = kind === 'npm-package-set'
    ? {
        schemaVersion: '1', candidateKind: kind, sourceCommit, releaseVersion: '0.4.2', producerRunId: 1,
        packageManifestSha256: '', contractSetSha256: CONTRACT_SHA,
        artifacts: [
          { path: 'python/capture_runtime_client-0.4.2-py3-none-any.whl', bytes: wheel.length, sha256: sha256(wheel) },
          { path: 'python/capture_runtime_client-0.4.2.tar.gz', bytes: source.length, sha256: sha256(source) },
        ], toolchains: { node: 'v24.20.0', python: '3.12' },
      }
    : {
        schemaVersion: '1', candidateKind: kind, sourceCommit, releaseVersion: '0.4.2', releaseMode: 'model-enabled',
        producerRunId: 2, packageCandidateId, contractSetSha256: CONTRACT_SHA, artifacts: [],
        toolchains: { node: 'v24.20.0', python: '3.12', runtime: 'capture-runtime' },
      };
  if (kind === 'npm-package-set') {
    const packageManifest = { schemaVersion: '1', candidateKind: kind, releaseVersion: '0.4.2', packages: [] };
    const bytes = Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`);
    await writeFile(join(root, 'package-manifest.json'), bytes);
    (base as { packageManifestSha256: string }).packageManifestSha256 = sha256(bytes);
  }
  const candidateId = sha256(JSON.stringify(base));
  await writeFile(join(root, 'candidate-manifest.json'), `${JSON.stringify({ ...base, candidateId }, null, 2)}\n`);
  return candidateId;
}

test('builds and verifies a relative PEP 503 Python candidate index', async () => {
  const root = join(import.meta.dirname, '.tmp-python-candidate-index');
  await rm(root, { recursive: true, force: true });
  const packageCandidate = join(root, 'package-candidate');
  const runtimeCandidate = join(root, 'runtime-candidate');
  const output = join(root, 'index');
  try {
    const packageCandidateId = await makeCandidate(packageCandidate);
    const runtimeCandidateId = await makeRuntimeCandidate(runtimeCandidate, packageCandidateId);
    const result = await assemblePythonCandidateIndex({
      packageCandidate,
      runtimeCandidate,
      output,
      sourceCommit: SOURCE_COMMIT,
      version: '0.4.2',
      contractSetSha256: CONTRACT_SHA,
    });
    assert.equal(result.candidateId.length, 64);
    const projectIndex = await readFile(join(output, 'simple/capture-runtime-client/index.html'), 'utf8');
    assert.match(projectIndex, /href="capture_runtime_client-0\.4\.2-py3-none-any\.whl#sha256=[0-9a-f]{64}"/u);
    assert.match(projectIndex, /href="capture_runtime_client-0\.4\.2\.tar\.gz#sha256=[0-9a-f]{64}"/u);
    assert.doesNotMatch(projectIndex, /(?:[A-Za-z]:|file:|https?:|\\|\.\.)/iu);
    const verified = await verifyPythonCandidateIndex({
      index: output,
      packageCandidate,
      runtimeCandidate,
      sourceCommit: SOURCE_COMMIT,
      version: '0.4.2',
      packageCandidateId,
      runtimeCandidateId,
      contractSetSha256: CONTRACT_SHA,
    });
    assert.equal(verified.candidateId, result.candidateId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects changed distribution bytes, direct URLs, duplicate links, and extra files', async () => {
  const root = join(import.meta.dirname, '.tmp-python-candidate-index-rejections');
  await rm(root, { recursive: true, force: true });
  const packageCandidate = join(root, 'package-candidate');
  const runtimeCandidate = join(root, 'runtime-candidate');
  const output = join(root, 'index');
  try {
    const packageCandidateId = await makeCandidate(packageCandidate);
    const runtimeCandidateId = await makeRuntimeCandidate(runtimeCandidate, packageCandidateId);
    const candidateManifestPath = join(packageCandidate, 'candidate-manifest.json');
    const runtimeManifestPath = join(runtimeCandidate, 'candidate-manifest.json');
    const originalCandidateManifest = await readFile(candidateManifestPath);
    const originalRuntimeManifest = await readFile(runtimeManifestPath);
    const candidateManifest = JSON.parse(originalCandidateManifest.toString('utf8')) as {
      artifacts: Array<{ path: string; bytes: number; sha256: string }>;
      candidateId: string;
    };
    const duplicate = { ...candidateManifest.artifacts[0], path: 'python//capture_runtime_client-0.4.2-py3-none-any.whl' };
    candidateManifest.artifacts.push(duplicate);
    const candidateBase = { ...candidateManifest };
    delete candidateBase.candidateId;
    candidateManifest.candidateId = sha256(JSON.stringify(candidateBase));
    await writeFile(candidateManifestPath, `${JSON.stringify(candidateManifest, null, 2)}\n`);
    const runtimeManifest = JSON.parse(originalRuntimeManifest.toString('utf8')) as {
      packageCandidateId: string;
      candidateId: string;
    };
    runtimeManifest.packageCandidateId = candidateManifest.candidateId;
    const runtimeBase = { ...runtimeManifest };
    delete runtimeBase.candidateId;
    runtimeManifest.candidateId = sha256(JSON.stringify(runtimeBase));
    await writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
    await assert.rejects(
      () => assemblePythonCandidateIndex({
        packageCandidate,
        runtimeCandidate,
        output,
        sourceCommit: SOURCE_COMMIT,
        version: '0.4.2',
        contractSetSha256: CONTRACT_SHA,
      }),
      /alias segments|duplicate path/u,
    );
    await writeFile(candidateManifestPath, originalCandidateManifest);
    await writeFile(runtimeManifestPath, originalRuntimeManifest);
    await assemblePythonCandidateIndex({
      packageCandidate,
      runtimeCandidate,
      output,
      sourceCommit: SOURCE_COMMIT,
      version: '0.4.2',
      contractSetSha256: CONTRACT_SHA,
    });
    await writeFile(join(output, 'simple/capture-runtime-client/capture_runtime_client-0.4.2.tar.gz'), 'tampered');
    await assert.rejects(
      () => verifyPythonCandidateIndex({
        index: output,
        packageCandidate,
        runtimeCandidate,
        sourceCommit: SOURCE_COMMIT,
        version: '0.4.2',
        packageCandidateId,
        runtimeCandidateId,
        contractSetSha256: CONTRACT_SHA,
      }),
      /digest|bytes|size/u,
    );
    await writeFile(join(output, 'simple/capture-runtime-client/capture_runtime_client-0.4.2.tar.gz'), await readFile(join(packageCandidate, 'python/capture_runtime_client-0.4.2.tar.gz')));
    const canonicalProjectIndex = await readFile(join(output, 'simple/capture-runtime-client/index.html'));
    await writeFile(join(output, 'simple/capture-runtime-client/index.html'), '<a href="file:///tmp/local.whl#sha256=' + '0'.repeat(64) + '">local</a>');
    await assert.rejects(
      () => verifyPythonCandidateIndex({
        index: output,
        packageCandidate,
        runtimeCandidate,
        sourceCommit: SOURCE_COMMIT,
        version: '0.4.2',
        packageCandidateId,
        runtimeCandidateId,
        contractSetSha256: CONTRACT_SHA,
      }),
      /relative|canonical|link|distribution|size/u,
    );
    await writeFile(join(output, 'simple/capture-runtime-client/index.html'), canonicalProjectIndex);
    await writeFile(join(output, 'extra.txt'), 'unexpected');
    await assert.rejects(
      () => verifyPythonCandidateIndex({
        index: output,
        packageCandidate,
        runtimeCandidate,
        sourceCommit: SOURCE_COMMIT,
        version: '0.4.2',
        packageCandidateId,
        runtimeCandidateId,
        contractSetSha256: CONTRACT_SHA,
      }),
      /extra|inventory/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runs pip and Poetry HTTP installation smoke in isolated temporary environments', { skip: process.env.PYTHON_INDEX_UNIT_ONLY === '1' }, async () => {
  const root = join(import.meta.dirname, '.tmp-python-candidate-index-http');
  await rm(root, { recursive: true, force: true });
  try {
    const fixture = await makeGeneratedWheelCandidate(join(root, 'fixture-one'));
    const repeatFixture = await makeGeneratedWheelCandidate(join(root, 'fixture-two'));
    assert.deepEqual(
      await readFile(join(fixture.packageCandidate, 'python/capture_runtime_client-0.4.2-py3-none-any.whl')),
      await readFile(join(repeatFixture.packageCandidate, 'python/capture_runtime_client-0.4.2-py3-none-any.whl')),
      'Generated wheel fixture is not deterministic.',
    );
    const index = join(root, 'index');
    const packageManifest = JSON.parse(await readFile(join(fixture.packageCandidate, 'candidate-manifest.json'), 'utf8')) as { candidateId: string; contractSetSha256: string };
    const runtimeManifest = JSON.parse(await readFile(join(fixture.runtimeCandidate, 'candidate-manifest.json'), 'utf8')) as { candidateId: string };
    await assemblePythonCandidateIndex({
      packageCandidate: fixture.packageCandidate,
      runtimeCandidate: fixture.runtimeCandidate,
      output: index,
      sourceCommit: SOURCE_COMMIT,
      version: '0.4.2',
      contractSetSha256: packageManifest.contractSetSha256,
    });
    const smoke = await runPythonCandidateIndexHttpSmoke({ index, version: '0.4.2' });
    assert.equal(smoke.poetryInstalledVersion, '0.4.2');
    assert.deepEqual(smoke.directUrlFiles, []);
    assert.deepEqual(smoke.poetryDirectUrlFiles, []);
    assert.equal(smoke.poetryWheelSha256, sha256(await readFile(join(index, 'simple/capture-runtime-client/capture_runtime_client-0.4.2-py3-none-any.whl'))));
    assert.equal(smoke.poetryLockContainsLoopbackSource, true);
    assert.equal(smoke.tempCleanupVerified, true);
    assert((smoke.requestCounts['/simple/'] ?? 0) > 0);
    assert((smoke.requestCounts['/simple/capture-runtime-client/'] ?? 0) > 0);
    assert((smoke.requestCounts['/simple/capture-runtime-client/capture_runtime_client-0.4.2-py3-none-any.whl'] ?? 0) > 0);
    assert.equal(runtimeManifest.candidateId.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
