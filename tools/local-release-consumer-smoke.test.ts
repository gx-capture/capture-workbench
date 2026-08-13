import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RUNTIME_ASSET_NAMES,
  RUNTIME_SIZE_REPORT_NAMES,
  validateRuntimeManifest,
  verifyRuntimeRelease,
} from './local-release-consumer-smoke.ts';

const version = '0.3.12';

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
    apiVersion: '1.0',
    captureDocumentSchemaVersion: '1',
    platform: 'windows',
    arch: 'x86_64',
    fileName: RUNTIME_ASSET_NAMES[0],
    bytes: executable.byteLength,
    sha256: digest(executable),
    schemaFileName: RUNTIME_ASSET_NAMES[3],
    schemaSha256: digest(schema),
  };
  await writeFile(join(directory, manifest.fileName), executable);
  await writeFile(join(directory, manifest.schemaFileName), schema);
  await writeFile(
    join(directory, RUNTIME_ASSET_NAMES[1]),
    `${manifest.sha256}  ${manifest.fileName}\n`,
  );
  await writeFile(
    join(directory, 'capture-runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return directory;
}

async function createModelFixture(): Promise<string> {
  const directory = await createFixture();
  const workerAssets = [
    ['windowsml-ocr', 'capture-engine-ocr-0.3.12-windows-x64.zip'],
    ['whisper-primary', 'capture-engine-whisper-0.3.12-windows-x64.zip'],
  ] as const;
  const pendingWrites: Promise<void>[] = [];
  const requirements = workerAssets.map(([requirementId, fileName]) => {
    const archive = Buffer.from(`${requirementId} worker fixture`);
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
      url: `https://example.test/v${version}/${fileName}`,
    };
    pendingWrites.push(writeFile(join(directory, fileName), archive));
    pendingWrites.push(
      writeFile(join(directory, `${fileName}.sha256`), `${artifact.sha256}  ${fileName}\n`),
    );
    pendingWrites.push(writeFile(join(directory, filesManifestName), filesManifest));
    pendingWrites.push(
      writeFile(
        join(directory, `${filesManifestName}.sha256`),
        `${artifact.filesManifestSha256}  ${filesManifestName}\n`,
      ),
    );
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
  await Promise.all(pendingWrites);
  const catalog = {
    catalogVersion: '2',
    runtimeVersion: version,
    requirements,
  };
  const catalogBytes = canonicalJson(catalog);
  await writeFile(join(directory, 'capture-engine-catalog.json'), catalogBytes);
  await writeFile(
    join(directory, 'capture-engine-catalog.json.sha256'),
    `${digest(catalogBytes)}  capture-engine-catalog.json\n`,
  );
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

test('runtime release verifier accepts the immutable size report pair', async () => {
  await withFixture(async (directory) => {
    const report = JSON.stringify({ reportVersion: '2' }) + '\n';
    await writeFile(join(directory, RUNTIME_SIZE_REPORT_NAMES[0]), report);
    await writeFile(
      join(directory, RUNTIME_SIZE_REPORT_NAMES[1]),
      `${digest(Buffer.from(report))}  ${RUNTIME_SIZE_REPORT_NAMES[0]}\n`,
    );
    const manifest = await verifyRuntimeRelease(directory, version);
    assert.equal(manifest.runtimeVersion, version);
  });
});

test('runtime release verifier rejects an unpaired size report', async () => {
  await withFixture(async (directory) => {
    await writeFile(join(directory, RUNTIME_SIZE_REPORT_NAMES[0]), '{}\n');
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /size report and checksum must be published together/u,
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

test('runtime release verifier rejects model archives or unknown model-enabled assets', async () => {
  const directory = await createModelFixture();
  try {
    await writeFile(join(directory, 'capture-model-whisper-primary.zip'), 'forbidden');
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
    await writeFile(join(directory, RUNTIME_ASSET_NAMES[0]), 'tampered');
    await assert.rejects(
      verifyRuntimeRelease(directory, version),
      /byte count|digest/u,
    );
  });
});

test('runtime release verifier rejects manifest version drift', async () => {
  await withFixture(async (directory) => {
    const path = join(directory, 'capture-runtime-manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest.runtimeVersion = '0.4.0';
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
          apiVersion: '1.0',
          captureDocumentSchemaVersion: '1',
          platform: 'linux',
          arch: 'x86_64',
          fileName: RUNTIME_ASSET_NAMES[0],
          bytes: 1,
          sha256: '0'.repeat(64),
          schemaFileName: RUNTIME_ASSET_NAMES[3],
          schemaSha256: '0'.repeat(64),
        },
        version,
      ),
    /unsupported platform/u,
  );
});
