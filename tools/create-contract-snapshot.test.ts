import assert from 'node:assert/strict';
import test from 'node:test';

import { createContractSnapshot } from './create-contract-snapshot.ts';

test('contract snapshot captures the canonical v2 contract bundle and metadata', async () => {
  const snapshot = await createContractSnapshot(process.cwd());
  assert.equal(snapshot.schemaVersion, '1');
  assert.equal(snapshot.releaseVersion, '0.4.1');
  assert.equal(
    (snapshot.runtimeApi as { apiVersion: string }).apiVersion,
    '2.0',
  );
  assert.equal(
    (snapshot.runtimeApi as { documentSchemaVersion: string }).documentSchemaVersion,
    '2',
  );
  assert.match(String(snapshot.contractSetSha256), /^[0-9a-f]{64}$/u);
  assert.ok(
    Object.keys(snapshot.schemas as Record<string, unknown>).length > 10,
  );
  assert.ok(Object.hasOwn(snapshot.schemas as object, 'capture-document.schema.json'));
  assert.equal(snapshot.typescript, '');
  assert.equal(snapshot.python, '');
  assert.ok(Array.isArray(snapshot.events));
  assert.ok(Array.isArray(snapshot.errorCodes));
});
