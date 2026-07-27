import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeReleaseEvidenceBundle,
  parseReleaseEvidenceBundle,
} from './release-evidence-bundle.ts';

const evidence = JSON.stringify({
  schemaVersion: '1',
  releaseable: false,
  fixtures: [],
});
const fixtureRegistry = JSON.stringify({
  schemaVersion: '1',
  fixtures: [],
});

test('release evidence bundle round trips both validated JSON objects', () => {
  const encoded = encodeReleaseEvidenceBundle(evidence, fixtureRegistry);
  const decoded = JSON.parse(
    Buffer.from(encoded, 'base64').toString('utf8'),
  ) as unknown;
  const bundle = parseReleaseEvidenceBundle(decoded);
  assert.equal(bundle.schemaVersion, 1);
  assert.deepEqual(bundle.evidence, JSON.parse(evidence));
  assert.deepEqual(bundle.fixtureRegistry, JSON.parse(fixtureRegistry));
});

test('release evidence bundle rejects unknown top-level fields', () => {
  assert.throws(
    () =>
      parseReleaseEvidenceBundle({
        schemaVersion: 1,
        evidence: {},
        fixtureRegistry: {},
        unexpected: true,
      }),
    /unknown field/u,
  );
});

test('release evidence bundle rejects invalid members', () => {
  assert.throws(
    () => encodeReleaseEvidenceBundle('[]', '{}'),
    /evidence JSON must be an object/u,
  );
  assert.throws(
    () => encodeReleaseEvidenceBundle('{}', '[]'),
    /Fixture registry JSON must be an object/u,
  );
  assert.throws(
    () =>
      parseReleaseEvidenceBundle({
        schemaVersion: 2,
        evidence: {},
        fixtureRegistry: {},
      }),
    /schemaVersion must be 1/u,
  );
});
