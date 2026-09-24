import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  parseLocalCandidateModelDescriptor,
  verifyLocalCandidateModel,
  type LocalCandidateModelDescriptor,
} from './local-candidate-model.ts';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const MODEL_FILES = [
  ['licenses/LICENSE-PaddleOCR.txt', 'license'],
  ['licenses/NOTICE-det.md', 'det notice'],
  ['licenses/NOTICE-rec.md', 'rec notice'],
  ['model/det/inference.onnx', 'det onnx'],
  ['model/det/inference.yml', 'det yml'],
  ['model/pipeline.json', '{}'],
  ['model/rec/inference.onnx', 'rec onnx'],
  ['model/rec/inference.yml', 'rec yml'],
  ['model/rec/ppocrv6_dict.txt', 'dict'],
  ['provenance/commit-a.json', '{}'],
] as const;

function descriptorForFixture(): LocalCandidateModelDescriptor {
  const files = MODEL_FILES.map(([path, contents]) => ({
    bytes: Buffer.byteLength(contents),
    path,
    sha256: sha256(contents),
  }));
  const modelManifest = {
    artifactVersion: '0.4.2',
    entryPoint: 'model',
    files,
    manifestVersion: '1',
  };
  return {
    artifactVersion: '0.4.2',
    entryCount: files.length,
    entryPoint: 'model',
    extractedBytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
    manifestSha256: sha256(`${JSON.stringify(modelManifest, null, 2)}\n`),
    sourceLockSha256: 'b'.repeat(64),
  };
}

async function createModelFixture(options: {
  readonly ancestorAlias?: boolean;
} = {}): Promise<{
  readonly root: string;
  readonly descriptor: LocalCandidateModelDescriptor;
  readonly physicalRoot?: string;
  readonly aliasRoot?: string;
}> {
  const physicalRoot = await mkdtemp(join(tmpdir(), 'capture-local-candidate-model-'));
  let root = physicalRoot;
  let aliasRoot: string | undefined;
  if (options.ancestorAlias) {
    aliasRoot = join(
      tmpdir(),
      `capture-local-candidate-model-alias-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await symlink(physicalRoot, aliasRoot, 'junction');
    assert.notEqual(await realpath(aliasRoot), aliasRoot);
    root = join(aliasRoot, 'run');
    await mkdir(root, { recursive: true });
  }
  const descriptor = descriptorForFixture();
  for (const [path, contents] of MODEL_FILES) {
    const filePath = join(root, ...path.split('/'));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }
  await writeFile(join(root, 'transport-manifest.json'), 'untrusted control\n', 'utf8');
  return {
    root,
    descriptor,
    ...(options.ancestorAlias ? { physicalRoot, aliasRoot } : {}),
  };
}

async function verifyFixture(
  root: string,
  descriptor: LocalCandidateModelDescriptor,
): Promise<void> {
  const candidate = await createCandidateFixture(descriptor);
  try {
    await verifyLocalCandidateModel({
      candidateRoot: candidate.root,
      candidateId: candidate.candidateId,
      modelRoot: root,
      requirementId: 'windowsml-ocr',
    });
  } finally {
    await rm(candidate.root, { recursive: true, force: true });
  }
}

async function createCandidateFixture(descriptor: LocalCandidateModelDescriptor): Promise<{
  readonly root: string;
  readonly catalogPath: string;
  readonly manifestPath: string;
  readonly candidateId: string;
  readonly catalogBytes: Buffer;
  readonly manifestBytes: Buffer;
}> {
  const root = await mkdtemp(join(tmpdir(), 'capture-local-candidate-source-'));
  const catalogPath = join(root, 'runtime', 'capture-engine-catalog.json');
  await mkdir(dirname(catalogPath), { recursive: true });
  const catalogBytes = Buffer.from(JSON.stringify({
    catalogVersion: '2',
    runtimeVersion: '0.4.2',
    requirements: [{
      requirementId: 'windowsml-ocr',
      modelFiles: descriptor,
    }],
  }));
  await writeFile(catalogPath, catalogBytes);
  const manifestBase = {
    artifacts: [{
      path: 'runtime/capture-engine-catalog.json',
      bytes: catalogBytes.length,
      sha256: sha256(catalogBytes),
    }],
    candidateKind: 'runtime',
    contractSetSha256: 'a'.repeat(64),
    packageCandidateId: 'b'.repeat(64),
    producerRunId: 1,
    releaseMode: 'core-only',
    releaseVersion: '0.4.2',
    schemaVersion: '1',
    sourceCommit: 'c'.repeat(40),
    toolchains: { node: '24', python: '3.12', runtime: 'capture-runtime' },
  };
  const candidateId = sha256(JSON.stringify(manifestBase));
  const manifestBytes = Buffer.from(JSON.stringify({ ...manifestBase, candidateId }));
  const manifestPath = join(root, 'candidate-manifest.json');
  await writeFile(manifestPath, manifestBytes);
  return { root, catalogPath, manifestPath, candidateId, catalogBytes, manifestBytes };
}

test('local candidate model verification binds the exact descriptor set without exposing the root', async () => {
  const fixture = await createModelFixture();
  const candidate = await createCandidateFixture(fixture.descriptor);
  try {
    const identity = await verifyLocalCandidateModel({
      candidateRoot: candidate.root,
      candidateId: candidate.candidateId,
      modelRoot: fixture.root,
      requirementId: 'windowsml-ocr',
    });

    assert.deepEqual(identity, {
      policy: 'local-package-tiered',
      candidateId: candidate.candidateId,
      catalogSha256: sha256(candidate.catalogBytes),
      modelManifestSha256: fixture.descriptor.manifestSha256,
      sourceLockSha256: fixture.descriptor.sourceLockSha256,
      modelFileCount: 10,
      modelExtractedBytes: fixture.descriptor.extractedBytes,
      verifiedFileCount: 10,
    });
    assert.doesNotMatch(JSON.stringify(identity), /capture-local-candidate-model|[A-Za-z]:[\\/]/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('local candidate model verification accepts a model root under an ancestor junction alias', async () => {
  const fixture = await createModelFixture({ ancestorAlias: true });
  const candidate = await createCandidateFixture(fixture.descriptor);
  try {
    await assert.doesNotReject(() => verifyLocalCandidateModel({
      candidateRoot: candidate.root,
      candidateId: candidate.candidateId,
      modelRoot: fixture.root,
      requirementId: 'windowsml-ocr',
    }));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    if (fixture.aliasRoot) await rm(fixture.aliasRoot, { force: true });
    if (fixture.physicalRoot) await rm(fixture.physicalRoot, { recursive: true, force: true });
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('local candidate model verification rejects a missing descriptor file', async () => {
  const fixture = await createModelFixture();
  try {
    await rm(join(fixture.root, 'model', 'det', 'inference.yml'));
    await assert.rejects(
      verifyFixture(fixture.root, fixture.descriptor),
      /model files are missing/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('local candidate model verification rejects an unexpected non-control file', async () => {
  const fixture = await createModelFixture();
  try {
    await writeFile(join(fixture.root, 'unexpected.txt'), 'private text', 'utf8');
    await assert.rejects(
      verifyFixture(fixture.root, fixture.descriptor),
      /unexpected files/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('local candidate model verification rejects same-size wrong bytes', async () => {
  const fixture = await createModelFixture();
  try {
    await writeFile(join(fixture.root, 'model', 'det', 'inference.yml'), 'det ym', 'utf8');
    await assert.rejects(
      verifyFixture(fixture.root, fixture.descriptor),
      /file identity does not match/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('local candidate model verification rejects a reparse or escaping model entry', async (t) => {
  const fixture = await createModelFixture();
  const outside = await mkdtemp(join(tmpdir(), 'capture-local-candidate-model-outside-'));
  const target = join(fixture.root, 'model', 'det');
  try {
    await rm(target, { recursive: true, force: true });
    try {
      await symlink(outside, target, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows symlink creation is unavailable.');
        return;
      }
      throw error;
    }
    await assert.rejects(
      verifyFixture(fixture.root, fixture.descriptor),
      /link|escaping entry/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('local candidate model descriptor rejects manifest digest drift without exposing input text', () => {
  const descriptor = descriptorForFixture();
  assert.throws(
    () => parseLocalCandidateModelDescriptor({
      ...descriptor,
      manifestSha256: 'd'.repeat(64),
    }),
    /manifest SHA-256 is invalid/u,
  );
});

test('local candidate model descriptor parser authenticates the canonical manifest', () => {
  const descriptor = descriptorForFixture();
  assert.deepEqual(parseLocalCandidateModelDescriptor(descriptor), descriptor);
});

test('local candidate model binding accepts a caller-selected temporary candidate root', async () => {
  const model = await createModelFixture();
  const candidate = await createCandidateFixture(model.descriptor);
  try {
    await assert.doesNotReject(() => verifyLocalCandidateModel({
      candidateRoot: candidate.root,
      candidateId: candidate.candidateId,
      modelRoot: model.root,
      requirementId: 'windowsml-ocr',
    }));
  } finally {
    await rm(model.root, { recursive: true, force: true });
    await rm(candidate.root, { recursive: true, force: true });
  }
});

test('local candidate model binding rejects candidate manifest and catalog byte tampering', async () => {
  const model = await createModelFixture();
  const candidate = await createCandidateFixture(model.descriptor);
  try {
    await assert.doesNotReject(() => verifyLocalCandidateModel({
      candidateRoot: candidate.root,
      candidateId: candidate.candidateId,
      modelRoot: model.root,
      requirementId: 'windowsml-ocr',
    }));

    await assert.rejects(
      verifyLocalCandidateModel({
        candidateRoot: candidate.root,
        candidateId: 'f'.repeat(64),
        modelRoot: model.root,
        requirementId: 'windowsml-ocr',
      }),
      /manifest identity|bound/u,
    );

    const tamperedManifest = JSON.parse(candidate.manifestBytes.toString('utf8')) as Record<string, unknown>;
    tamperedManifest.releaseMode = 'tampered';
    await writeFile(candidate.manifestPath, JSON.stringify(tamperedManifest));
    await assert.rejects(
      verifyLocalCandidateModel({
        candidateRoot: candidate.root,
        candidateId: candidate.candidateId,
        modelRoot: model.root,
        requirementId: 'windowsml-ocr',
      }),
      /candidate ID is not bound|manifest identity/u,
    );
    await writeFile(candidate.manifestPath, candidate.manifestBytes);

    for (const [field, value] of [
      ['sha256', '0'.repeat(64)],
      ['bytes', candidate.catalogBytes.length + 1],
    ] as const) {
      const tamperedInventory = JSON.parse(candidate.manifestBytes.toString('utf8')) as Record<string, unknown>;
      const artifacts = tamperedInventory.artifacts as Array<Record<string, unknown>>;
      artifacts[0][field] = value;
      const inventoryBase = { ...tamperedInventory };
      delete inventoryBase.candidateId;
      const reboundCandidateId = sha256(JSON.stringify(inventoryBase));
      await writeFile(candidate.manifestPath, JSON.stringify({ ...inventoryBase, candidateId: reboundCandidateId }));
      await assert.rejects(
        verifyLocalCandidateModel({
          candidateRoot: candidate.root,
          candidateId: reboundCandidateId,
          modelRoot: model.root,
          requirementId: 'windowsml-ocr',
        }),
        /catalog bytes do not match the candidate manifest/u,
      );
      await writeFile(candidate.manifestPath, candidate.manifestBytes);
    }

    const tamperedCatalog = Buffer.from(JSON.stringify({
      catalogVersion: '2',
      runtimeVersion: '0.4.2',
      requirements: [],
    }));
    await writeFile(candidate.catalogPath, tamperedCatalog);
    await assert.rejects(
      verifyLocalCandidateModel({
        candidateRoot: candidate.root,
        candidateId: candidate.candidateId,
        modelRoot: model.root,
        requirementId: 'windowsml-ocr',
      }),
      /catalog bytes do not match/u,
    );
  } finally {
    await rm(model.root, { recursive: true, force: true });
    await rm(candidate.root, { recursive: true, force: true });
  }
});
