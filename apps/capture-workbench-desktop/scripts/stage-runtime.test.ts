import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  sha256File,
  validateManifestShape,
  validateRuntime,
} from './stage-runtime.ts';

function manifestFor(bytes, sha256, schemaSha256) {
  return {
    manifestVersion: '1',
  runtimeVersion: '0.3.7',
    apiVersion: '1.0',
    captureDocumentSchemaVersion: '1',
    platform: 'windows',
    arch: 'x86_64',
    fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
    bytes,
    sha256,
    schemaFileName: 'capture-document-v1.schema.json',
    schemaSha256,
  };
}

function observe(observable) {
  return new Promise((resolve, reject) => {
    let value;
    observable.subscribe({
      next: (nextValue) => {
        value = nextValue;
      },
      error: reject,
      complete: () => resolve(value),
    });
  });
}

test('staging validation binds manifest bytes and SHA-256 to one artifact', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'capture-runtime-stage-test-'),
  );
  try {
    const artifact = join(directory, 'capture-runtime.exe');
    const manifestPath = join(directory, 'capture-runtime-manifest.json');
    const schemaPath = join(directory, 'capture-document-v1.schema.json');
    await writeFile(artifact, 'deterministic runtime', 'utf8');
    await writeFile(schemaPath, '{"type":"object"}\n', 'utf8');
    const digest = await observe(sha256File(artifact));
    const schemaDigest = await observe(sha256File(schemaPath));
    await writeFile(
      manifestPath,
      JSON.stringify(manifestFor(21, digest, schemaDigest)),
      'utf8',
    );

    const verified = await observe(
      validateRuntime(manifestPath, artifact, schemaPath),
    );
    assert.equal(verified.digest, digest);
    assert.equal(verified.schemaDigest, schemaDigest);

    await writeFile(artifact, 'tampered runtime', 'utf8');
    await assert.rejects(
      observe(validateRuntime(manifestPath, artifact, schemaPath)),
      /byte count mismatch|SHA-256 mismatch/u,
    );

    await writeFile(artifact, 'deterministic runtime', 'utf8');
    await writeFile(schemaPath, '{"type":"string"}\n', 'utf8');
    await assert.rejects(
      observe(validateRuntime(manifestPath, artifact, schemaPath)),
      /schema SHA-256 mismatch/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('staging manifest rejects schema drift and path traversal', () => {
  const valid = manifestFor(1, '0'.repeat(64), '1'.repeat(64));
  assert.doesNotThrow(() => validateManifestShape(valid));
  assert.throws(
    () =>
      validateManifestShape({ ...valid, captureDocumentSchemaVersion: '2' }),
    /captureDocumentSchemaVersion/u,
  );
  assert.throws(
    () =>
      validateManifestShape({ ...valid, fileName: '..\\capture-runtime.exe' }),
    /fileName/u,
  );
  assert.throws(
    () =>
      validateManifestShape({
        ...valid,
        schemaFileName: '..\\capture-document-v1.schema.json',
      }),
    /schemaFileName/u,
  );
  assert.throws(
    () => validateManifestShape({ ...valid, schemaSha256: 'not-a-digest' }),
    /schemaSha256/u,
  );
});
