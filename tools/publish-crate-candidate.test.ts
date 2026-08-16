import assert from 'node:assert/strict';
import test from 'node:test';

import { registryChecksum, uploadBody } from './publish-crate-candidate.ts';

test('crates.io upload body preserves the API length-prefixed metadata and archive', () => {
  const metadata = { name: 'capture-sidecar-launcher', vers: '0.4.1' };
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

test('crates.io registry checksum is read from the version API response', () => {
  const checksum = 'a'.repeat(64);
  assert.equal(
    registryChecksum({ version: { checksum } }),
    checksum,
  );
  assert.equal(registryChecksum({ version: { checksum: 'not-a-sha256' } }), undefined);
  assert.equal(registryChecksum({}), undefined);
});
