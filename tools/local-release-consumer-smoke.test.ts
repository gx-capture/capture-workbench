import './test-temp-root.ts';
import { RELEASE_VERSION } from './release/release-intent.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RUNTIME_ASSET_NAMES,
  validateRuntimeManifest,
  verifyRuntimeRelease,
} from './local-release-consumer-smoke.ts';

const version = RELEASE_VERSION;

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`);
}

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'capture-runtime-release-test-'));
  const executable = Buffer.from('runtime executable fixture');
  const schema = Buffer.from('{"$schema":"fixture"}\n');
  const manifest = {
    manifestVersion: '1',
    runtimeVersion: version,
    apiVersion: '2.0',
    captureDocumentSchemaVersion: '2',
    platform: 'windows',
    arch: 'x86_64',
    fileName: RUNTIME_ASSET_NAMES[0],
    bytes: executable.byteLength,
    sha256: digest(executable),
    schemaFileName: RUNTIME_ASSET_NAMES[2],
    schemaSha256: digest(schema),
  };
  await writeFile(join(directory, manifest.fileName), executable);
  await writeFile(join(directory, manifest.schemaFileName), schema);
  await writeFile(
    join(directory, 'capture-runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return directory;
}

async function createModelFixture(
  extraUnits: readonly (readonly [string, string])[] = [],
  {
    splitSpeech = false,
    speechContents = false,
  }: { splitSpeech?: boolean; speechContents?: boolean } = {},
): Promise<string> {
  const directory = await createFixture();
  const workerAssets = [
    ['windowsml-ocr', ("capture-engine-ocr-" + RELEASE_VERSION + "-windows-x64.zip")],
    ['speech-recognition', ("capture-engine-speech-recognition-" + RELEASE_VERSION + "-windows-x64.zip")],
    ...extraUnits,
  ] as const;
  const pendingWrites: Promise<void>[] = [];
  const requirements = workerAssets.map(([requirementId, fileName]) => {
    const archive = Buffer.from(`${requirementId} worker fixture`);
    // A split archive is published as `<fileName>.001`, `.002` in its place.
    const pieces =
      splitSpeech && requirementId === 'speech-recognition'
        ? [archive.subarray(0, 10), archive.subarray(10)]
        : [];
    const filesManifestName = `${fileName.slice(0, -4)}-files.json`;
    const filesManifest = Buffer.from(`{"entryPoint":"capture-engine-${requirementId}"}\n`);
    const artifact = {
      role: 'worker',
      requirementId,
      artifactVersion: version,
      workerProtocolVersion: '1',
      platform: 'windows',
      arch: 'x86_64',
      fileName,
      bytes: archive.byteLength,
      sha256: digest(archive),
      extractedBytes: archive.byteLength,
      entryPoint: `capture-engine-${requirementId}`,
      filesManifestSha256: digest(filesManifest),
      ...(pieces.length
        ? {
            parts: pieces.map((piece, index) => ({
              fileName: `${fileName}.00${index + 1}`,
              bytes: piece.byteLength,
              sha256: digest(piece),
              url: `https://example.test/v${version}/${fileName}.00${index + 1}`,
            })),
          }
        : { url: `https://example.test/v${version}/${fileName}` }),
    };
    const files = pieces.length
      ? pieces.map((piece, index) => [`${fileName}.00${index + 1}`, piece] as const)
      : [[fileName, archive] as const];
    for (const [name, bytes] of files) {
      pendingWrites.push(writeFile(join(directory, name), bytes));
    }
    pendingWrites.push(writeFile(join(directory, filesManifestName), filesManifest));
    return {
      requirementId,
      artifacts: [artifact],
      modelFiles: {
        artifactVersion: version,
        entryCount: 1,
        entryPoint: 'model',
        extractedBytes: 1,
        files: [{}],
        manifestSha256: 'a'.repeat(64),
        sourceLockSha256: 'b'.repeat(64),
      },
      unavailableReason: null,
    };
  });
  if (speechContents) {
    const cpuFileName = `capture-engine-speech-recognition-cpu-${version}-windows-x64.zip`;
    const cpuArchive = Buffer.from('speech cpu worker fixture');
    const cpuManifestName = `${cpuFileName.slice(0, -4)}-files.json`;
    const cpuManifest = Buffer.from(
      '{"entryPoint":"capture-engine-speech-recognition-cpu"}\n',
    );
    const index = requirements.findIndex(
      (item) => item.requirementId === 'speech-recognition',
    );
    const legacy = requirements[index];
    pendingWrites.push(writeFile(join(directory, cpuFileName), cpuArchive));
    pendingWrites.push(
      writeFile(join(directory, cpuManifestName), cpuManifest),
    );
    (requirements as Array<Record<string, unknown>>)[index] = {
      requirementId: 'speech-recognition',
      contents: [
        {
          id: 'cuda',
          artifacts: legacy?.artifacts,
          modelFiles: legacy?.modelFiles,
          unavailableReason: null,
        },
        {
          id: 'cpu',
          artifacts: [
            {
              role: 'worker',
              requirementId: 'speech-recognition',
              artifactVersion: version,
              workerProtocolVersion: '1',
              platform: 'windows',
              arch: 'x86_64',
              fileName: cpuFileName,
              bytes: cpuArchive.byteLength,
              sha256: digest(cpuArchive),
              extractedBytes: cpuArchive.byteLength,
              entryPoint: 'capture-engine-speech-recognition-cpu',
              filesManifestSha256: digest(cpuManifest),
              url: `https://example.test/v${version}/${cpuFileName}`,
            },
          ],
          modelFiles: legacy?.modelFiles,
          unavailableReason: null,
        },
      ],
    };
  }
  await Promise.all(pendingWrites);
  const catalog = {
    catalogVersion: '2',
    runtimeVersion: version,
    requirements,
  };
  const catalogBytes = canonicalJson(catalog);
  await writeFile(join(directory, 'capture-engine-catalog.json'), catalogBytes);
  return directory;
}

async function withFixture(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await createFixture();
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('runtime release verifier accepts the canonical asset set', async () => {
  await withFixture(async (directory) => {
    const manifest = await verifyRuntimeRelease(directory, version);
    assert.equal(manifest.runtimeVersion, version);
    assert.equal(manifest.fileName, RUNTIME_ASSET_NAMES[0]);
  });
});

test('runtime release verifier rejects a size report and a checksum sidecar', async () => {
  await withFixture(async (directory) => {
    await writeFile(join(directory, 'runtime-size-report.json'), '{}\n');
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /outside the canonical asset set/u,
    );
  });
  await withFixture(async (directory) => {
    await writeFile(
      join(directory, `${RUNTIME_ASSET_NAMES[0]}.sha256`),
      `${'a'.repeat(64)}  ${RUNTIME_ASSET_NAMES[0]}\n`,
    );
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /outside the canonical asset set/u,
    );
  });
});

test('runtime release verifier derives the exact model-enabled worker asset set from the catalog', async () => {
  const directory = await createModelFixture();
  try {
    const manifest = await verifyRuntimeRelease(directory, version);
    assert.equal(manifest.runtimeVersion, version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime release verifier accepts a release that also carries the optional speaker unit', async () => {
  const directory = await createModelFixture([
    ['speaker-diarization', `capture-engine-diarization-${RELEASE_VERSION}-windows-x64.zip`],
  ]);
  try {
    const manifest = await verifyRuntimeRelease(directory, version);
    assert.equal(manifest.runtimeVersion, version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime release verifier accepts a models-only unit that has no worker archive', async () => {
  const directory = await createModelFixture();
  try {
    const path = join(directory, 'capture-engine-catalog.json');
    const catalog = JSON.parse(await readFile(path, 'utf8'));
    catalog.requirements.push({
      requirementId: 'vertical-japanese-reader',
      artifacts: [],
      modelFiles: catalog.requirements[0].modelFiles,
      unavailableReason: null,
    });
    const bytes = canonicalJson(catalog);
    await writeFile(path, bytes);

    const manifest = await verifyRuntimeRelease(directory, version);
    assert.equal(manifest.runtimeVersion, version);

    catalog.requirements[2].artifacts = catalog.requirements[0].artifacts;
    const invalid = canonicalJson(catalog);
    await writeFile(path, invalid);
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /Engine catalog requirement is invalid: vertical-japanese-reader/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime release verifier rejects a unit it does not know', async () => {
  const directory = await createModelFixture([
    ['another-unit', `capture-engine-another-${RELEASE_VERSION}-windows-x64.zip`],
  ]);
  try {
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /Engine catalog requirements are invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime release verifier rejects model archives or unknown model-enabled assets', async () => {
  const directory = await createModelFixture();
  try {
    await writeFile(join(directory, 'capture-model-speech-recognition.zip'), 'forbidden');
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /outside the canonical asset set/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime release verifier rejects executable tampering', async () => {
  await withFixture(async (directory) => {
    const path = join(directory, RUNTIME_ASSET_NAMES[0]);
    const tampered = Buffer.from(await readFile(path));
    tampered[0] = tampered[0] === 0x74 ? 0x75 : 0x74;
    await writeFile(path, tampered);
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /digest does not match the manifest/u,
    );
  });
  await withFixture(async (directory) => {
    const path = join(directory, RUNTIME_ASSET_NAMES[0]);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('x')]));
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /byte count does not match the manifest/u,
    );
  });
});

test('runtime release verifier rejects manifest version drift', async () => {
  await withFixture(async (directory) => {
    const path = join(directory, 'capture-runtime-manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest.runtimeVersion = '999.999.999';
    await writeFile(path, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /does not match/u,
    );
  });
});

test('runtime release verifier rejects unexpected files', async () => {
  await withFixture(async (directory) => {
    await writeFile(join(directory, 'unexpected.txt'), 'not published');
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /outside the canonical asset set/u,
    );
  });
});

test('runtime manifest validation rejects non-Windows releases', () => {
  assert.throws(
    () =>
      validateRuntimeManifest(
        {
          manifestVersion: '1',
          runtimeVersion: version,
          apiVersion: '2.0',
          captureDocumentSchemaVersion: '2',
          platform: 'linux',
          arch: 'x86_64',
          fileName: RUNTIME_ASSET_NAMES[0],
          bytes: 1,
          sha256: '0'.repeat(64),
          schemaFileName: RUNTIME_ASSET_NAMES[2],
          schemaSha256: '0'.repeat(64),
        },
        version,
      ),
    /unsupported platform/u,
  );
});

test('runtime release verifier accepts a worker archive published as checked parts', async () => {
  const directory = await createModelFixture([], { splitSpeech: true });
  try {
    const manifest = await verifyRuntimeRelease(directory, version);
    assert.equal(manifest.runtimeVersion, version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime release verifier accepts both speech contents and no other engine asset', async () => {
  const directory = await createModelFixture([], { speechContents: true });
  const cpuZip = `capture-engine-speech-recognition-cpu-${version}-windows-x64.zip`;
  const cudaZip = `capture-engine-speech-recognition-${version}-windows-x64.zip`;
  try {
    const manifest = await verifyRuntimeRelease(directory, version);
    assert.equal(manifest.runtimeVersion, version);
    const names = await readdir(directory);
    for (const name of [
      cudaZip,
      `${cudaZip.slice(0, -'.zip'.length)}-files.json`,
      cpuZip,
      `${cpuZip.slice(0, -'.zip'.length)}-files.json`,
    ]) {
      assert.equal(names.includes(name), true, name);
    }
    await writeFile(join(directory, 'extra.zip'), Buffer.from('x'));
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /outside the canonical asset set/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime release verifier rejects a contents release that drops a cpu asset', async () => {
  const cpuZip = `capture-engine-speech-recognition-cpu-${version}-windows-x64.zip`;
  const missingZip = await createModelFixture([], { speechContents: true });
  const missingManifest = await createModelFixture([], { speechContents: true });
  try {
    await unlink(join(missingZip, cpuZip));
    await unlink(join(missingManifest, `${cpuZip.slice(0, -'.zip'.length)}-files.json`));
    await assert.rejects(
      verifyRuntimeRelease(missingZip, version),
      /outside the canonical asset set/u,
    );
    await assert.rejects(
      verifyRuntimeRelease(missingManifest, version),
      /outside the canonical asset set/u,
    );
  } finally {
    await rm(missingZip, { recursive: true, force: true });
    await rm(missingManifest, { recursive: true, force: true });
  }
});

test('runtime release verifier rejects a cpu zip that the legacy catalog does not publish', async () => {
  const directory = await createModelFixture();
  try {
    await writeFile(
      join(directory, `capture-engine-speech-recognition-cpu-${version}-windows-x64.zip`),
      Buffer.from('cpu'),
    );
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /outside the canonical asset set/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime release verifier rejects a contents catalog whose keys are not exact', async () => {
  const extraRequirementKey = await createModelFixture([], { speechContents: true });
  const extraContentKey = await createModelFixture([], { speechContents: true });
  try {
    await rewriteCatalog(extraRequirementKey, (catalog) => {
      const speech = catalog.requirements.find(
        (item) => item.requirementId === 'speech-recognition',
      );
      speech.extra = true;
    });
    await rewriteCatalog(extraContentKey, (catalog) => {
      const speech = catalog.requirements.find(
        (item) => item.requirementId === 'speech-recognition',
      );
      const contents = speech.contents as Array<Record<string, unknown>>;
      delete contents[0].unavailableReason;
    });
    await assert.rejects(
      verifyRuntimeRelease(extraRequirementKey, version),
      /not canonical/u,
    );
    await assert.rejects(
      verifyRuntimeRelease(extraContentKey, version),
      /not canonical/u,
    );
  } finally {
    await rm(extraRequirementKey, { recursive: true, force: true });
    await rm(extraContentKey, { recursive: true, force: true });
  }
});

async function rewriteCatalog(
  directory: string,
  edit: (catalog: { requirements: Array<Record<string, unknown>> }) => void,
): Promise<void> {
  const catalogPath = join(directory, 'capture-engine-catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
    requirements: Array<Record<string, unknown>>;
  };
  edit(catalog);
  await writeFile(catalogPath, canonicalJson(catalog));
}

test('runtime release verifier rejects a corrupted worker archive part', async () => {
  const directory = await createModelFixture([], { splitSpeech: true });
  try {
    const name = `capture-engine-speech-recognition-${version}-windows-x64.zip.002`;
    await writeFile(join(directory, name), Buffer.from('corrupted part'));
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /digest does not match catalog/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
