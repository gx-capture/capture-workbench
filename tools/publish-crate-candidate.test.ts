import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadBody } from './publish-crate-candidate.ts';

test('crates.io upload body preserves the API length-prefixed metadata and archive', () => {
  const metadata = { name: 'capture-sidecar-launcher', vers: '0.3.10' };
  const crate = Buffer.from('crate-bytes');
  const body = Buffer.from(uploadBody(metadata, crate));
  const metadataLength = body.readUInt32LE(0);
  const metadataBytes = body.subarray(4, 4 + metadataLength);
  const crateLengthOffset = 4 + metadataLength;
  const crateLength = body.readUInt32LE(crateLengthOffset);
  assert.deepEqual(JSON.parse(metadataBytes.toString('utf8')), metadata);
  assert.equal(crateLength, crate.byteLength);
  assert.deepEqual(body.subarray(crateLengthOffset + 4), crate);
});
