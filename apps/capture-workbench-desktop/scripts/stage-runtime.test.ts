import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  sha256File,
  validateManifestShape,
  validateRuntime,
} from './stage-runtime.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function materializeCorpusCase(item, base) {
  const manifest = structuredClone(item.manifest ?? base);
  Object.assign(manifest, item.patch ?? {});
  if (item.remove) delete manifest[item.remove];
  Object.assign(manifest.runtimeRequirements, item.requirementPatch ?? {});
  const descriptor = manifest.runtimeRequirements['windowsml-ocr'];
  Object.assign(descriptor, item.descriptorPatch ?? {});
  if (item.descriptorRemove) delete descriptor[item.descriptorRemove];
  return manifest;
}

function manifestFor(bytes, sha256, schemaSha256) {
  return {
    manifestVersion: '1',
    runtimeVersion: '0.1.0',
    apiVersion: '1.0',
    captureDocumentSchemaVersion: '1',
    platform: 'windows',
    arch: 'x86_64',
    fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
    bytes,
    sha256,
    schemaFileName: 'capture-document-v1.schema.json',
    schemaSha256,
    runtimeRequirements: {
      'windowsml-ocr': {
        artifactUrl: 'https://downloads.example.org/capture-windowsml-ocr.zip',
        artifactFileName: 'capture-windowsml-ocr.zip',
        bytes: 123456,
        sha256: '2'.repeat(64),
      },
    },
  };
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
    const digest = await sha256File(artifact);
    const schemaDigest = await sha256File(schemaPath);
    await writeFile(
      manifestPath,
      JSON.stringify(manifestFor(21, digest, schemaDigest)),
      'utf8',
    );

    const verified = await validateRuntime(manifestPath, artifact, schemaPath);
    assert.equal(verified.digest, digest);
    assert.equal(verified.schemaDigest, schemaDigest);

    await writeFile(artifact, 'tampered runtime', 'utf8');
    await assert.rejects(
      validateRuntime(manifestPath, artifact, schemaPath),
      /byte count mismatch|SHA-256 mismatch/u,
    );

    await writeFile(artifact, 'deterministic runtime', 'utf8');
    await writeFile(schemaPath, '{"type":"string"}\n', 'utf8');
    await assert.rejects(
      validateRuntime(manifestPath, artifact, schemaPath),
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
  const requirement = valid.runtimeRequirements['windowsml-ocr'];
  assert.throws(
    () =>
      validateManifestShape({
        ...valid,
        runtimeRequirements: {
          'windowsml-ocr': {
            ...requirement,
            artifactUrl:
              'https://downloads.example.org/capture-windowsml-ocr.zip?token=secret',
          },
        },
      }),
    /artifact URL is invalid|public HTTPS/u,
  );
  assert.throws(
    () =>
      validateManifestShape({
        ...valid,
        runtimeRequirements: {
          'windowsml-ocr': { ...requirement, sha256: 'A'.repeat(64) },
        },
      }),
    /lowercase hexadecimal/u,
  );
  assert.throws(
    () =>
      validateManifestShape({
        ...valid,
        runtimeRequirements: {},
      }),
    /runtimeRequirements/u,
  );
});

test('shared release manifest corpus matches the JavaScript contract', async () => {
  const corpus = JSON.parse(
    await readFile(
      resolve(scriptDirectory, '../../../tools/release-manifest-corpus.json'),
      'utf8',
    ),
  );
  const base = corpus.cases.find((item) => item.valid).manifest;
  for (const item of corpus.cases) {
    const manifest = materializeCorpusCase(item, base);
    if (item.valid) {
      assert.doesNotThrow(() => validateManifestShape(manifest), item.name);
    } else {
      assert.throws(
        () => validateManifestShape(manifest),
        undefined,
        item.name,
      );
    }
  }
});
