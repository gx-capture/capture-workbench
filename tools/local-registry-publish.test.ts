import assert from 'node:assert/strict';
import test from 'node:test';

import {
  packageArchiveName,
  packageMetadataPath,
  packagePublicationDecision,
} from './local-registry/publish-local-registry.ts';

test('local package publication is idempotent only for exact integrity', () => {
  assert.equal(
    packagePublicationDecision(undefined, 'sha512-local'),
    'publish',
  );
  assert.equal(
    packagePublicationDecision('sha512-local', 'sha512-local'),
    'already-published',
  );
  assert.throws(
    () => packagePublicationDecision('sha512-remote', 'sha512-local'),
    /integrity differs/u,
  );
});

test('local package paths preserve the scoped package identity', () => {
  assert.equal(
    packageArchiveName('@gx-capture/capture-workbench', '0.3.10'),
    'gx-capture-capture-workbench-0.3.10.tgz',
  );
  assert.equal(
    packageMetadataPath('@gx-capture/capture-workbench'),
    '/@gx-capture%2fcapture-workbench',
  );
});
