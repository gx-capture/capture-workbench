import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectReleaseVersionEntries,
  loadReleaseIntent,
  replaceReleaseVersion,
  verifyGeneratedVersions,
  workspaceRoot,
} from './version-sources.ts';

test('release intent is the synchronized source for all release-managed versions', () => {
  const intent = verifyGeneratedVersions(workspaceRoot);
  const entries = collectReleaseVersionEntries(workspaceRoot);
  assert.ok(entries.length >= 30);
  assert.ok(entries.every((entry) => entry.value === intent.releaseVersion));
  assert.deepEqual(loadReleaseIntent(workspaceRoot), {
    releaseVersion: '0.3.11',
    runtimeApiVersion: '1.0',
    documentSchemaVersion: '1',
  });
});

test('release replacement is exact and does not alter adjacent versions', () => {
  assert.equal(
    replaceReleaseVersion('0.3.11 0.3.100 v0.3.11', '0.3.11', '0.3.11'),
    '0.3.11 0.3.100 v0.3.11',
  );
});
