import assert from 'node:assert/strict';
import test from 'node:test';

import { createContractSnapshot } from './create-contract-snapshot.ts';

test('contract snapshot captures generated cross-language contracts and metadata', async () => {
  const snapshot = await createContractSnapshot(process.cwd());
  assert.equal(snapshot.schemaVersion, '1');
  assert.equal(snapshot.releaseVersion, '0.3.10');
  assert.equal(
    (snapshot.runtimeApi as { apiVersion: string }).apiVersion,
    '1.0',
  );
  assert.ok(
    Object.keys(snapshot.schemas as Record<string, unknown>).length > 10,
  );
  assert.match(snapshot.typescript as string, /CaptureDocumentV1/u);
  assert.match(snapshot.python as string, /CaptureDocumentV1/u);
  assert.ok(Array.isArray(snapshot.events));
  assert.ok(Array.isArray(snapshot.errorCodes));
});
