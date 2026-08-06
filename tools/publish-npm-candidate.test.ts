import assert from 'node:assert/strict';
import test from 'node:test';

import { packagePublicationDecision } from './publish-npm-candidate.ts';

test('npm publication is idempotent only for exact registry integrity', () => {
  assert.equal(packagePublicationDecision(undefined, 'sha512-a'), 'publish');
  assert.equal(
    packagePublicationDecision('sha512-a', 'sha512-a'),
    'already-published',
  );
  assert.throws(
    () => packagePublicationDecision('sha512-b', 'sha512-a'),
    /differs/u,
  );
});
