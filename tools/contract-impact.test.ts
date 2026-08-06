import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyContractImpact } from './contract-impact.ts';

const candidateId = 'b'.repeat(64);

function snapshot(overrides: Record<string, unknown> = {}) {
  const schema = {
    title: 'Example',
    description: 'stable description',
    type: 'object',
    additionalProperties: true,
    properties: { name: { type: 'string' } },
    required: ['name'],
  };
  return {
    schemaVersion: '1',
    releaseVersion: '0.3.11',
    runtimeApi: {
      apiVersion: '1.0',
      documentSchemaVersion: '1',
      documentSchemaId:
        'https://example.test/schema/capture-document-v1.schema.json',
      documentSchemaSha256: 'a'.repeat(64),
    },
    contractManifest: {
      manifestVersion: '1',
      packageVersion: '0.3.11',
      runtimeVersion: '0.3.11',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      captureDocumentSchemaId:
        'https://example.test/schema/capture-document-v1.schema.json',
      captureDocumentSchemaSha256: 'a'.repeat(64),
      models: [],
      enums: [],
      aliases: [],
      invariants: [],
      generator: { generatorSha256: 'a'.repeat(64) },
    },
    schemas: { 'example.schema.json': schema },
    typescript: 'export interface Example { readonly name: string; }',
    python: 'class Example: pass',
    events: [],
    errorCodes: [],
    ...overrides,
  };
}

test('description, ordering, digest, and release-version changes are no-impact', () => {
  const candidate = snapshot({
    releaseVersion: '0.3.11',
    runtimeApi: {
      apiVersion: '1.0',
      documentSchemaVersion: '1',
      documentSchemaId:
        'https://example.test/schema/capture-document-v1.schema.json',
      documentSchemaSha256: 'b'.repeat(64),
    },
    schemas: {
      'example.schema.json': {
        required: ['name'],
        properties: { name: { type: 'string' } },
        additionalProperties: true,
        type: 'object',
        title: 'Renamed title',
        description: 'updated documentation',
      },
    },
    contractManifest: {
      ...snapshot().contractManifest,
      packageVersion: '0.3.11',
      runtimeVersion: '0.3.11',
      captureDocumentSchemaSha256: 'b'.repeat(64),
    },
  });
  const result = classifyContractImpact(snapshot(), candidate, candidateId);
  assert.equal(result.classification, 'no-impact');
  assert.deepEqual(result.changes, []);
});

test('new optional property under a permissive object is additive', () => {
  const candidate = snapshot({
    schemas: {
      'example.schema.json': {
        ...snapshot().schemas['example.schema.json'],
        properties: {
          name: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  });
  const result = classifyContractImpact(snapshot(), candidate, candidateId);
  assert.equal(result.classification, 'additive');
  assert.match(result.changes[0].reason, /optional property/u);
});

test('new required property and removed enum value are breaking', () => {
  const baseline = snapshot({
    schemas: {
      'example.schema.json': {
        ...snapshot().schemas['example.schema.json'],
        properties: {
          name: { type: 'string', enum: ['one', 'two'] },
        },
        required: ['name'],
      },
    },
  });
  const candidate = snapshot({
    schemas: {
      'example.schema.json': {
        ...baseline.schemas['example.schema.json'],
        properties: {
          name: { type: 'string', enum: ['one'] },
          id: { type: 'string' },
        },
        required: ['name', 'id'],
      },
    },
  });
  const result = classifyContractImpact(baseline, candidate, candidateId);
  assert.equal(result.classification, 'breaking');
  assert.ok(result.changes.some((change) => /removed/u.test(change.reason)));
  assert.ok(result.changes.some((change) => /required/u.test(change.reason)));
});

test('strict optional property and unknown generated changes require review', () => {
  const baseline = snapshot({
    schemas: {
      'example.schema.json': {
        ...snapshot().schemas['example.schema.json'],
        additionalProperties: false,
      },
    },
  });
  const candidate = snapshot({
    typescript:
      'export interface Example { readonly name: string; readonly note: string; }',
    schemas: {
      'example.schema.json': {
        ...baseline.schemas['example.schema.json'],
        properties: {
          name: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  });
  const result = classifyContractImpact(baseline, candidate, candidateId);
  assert.equal(result.classification, 'manual-review');
});

test('invalid candidate IDs fail closed', () => {
  assert.throws(
    () => classifyContractImpact(snapshot(), snapshot(), 'not-a-candidate'),
    /lowercase SHA-256/u,
  );
});
