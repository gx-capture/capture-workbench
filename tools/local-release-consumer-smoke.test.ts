import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RUNTIME_ASSET_NAMES,
  validateRuntimeManifest,
  verifyRuntimeRelease,
} from './local-release-consumer-smoke.ts';

const version = '0.3.3';

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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
