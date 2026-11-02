import './test-temp-root.ts';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyPackageContractSet } from './assemble-release-candidate.ts';

test('release assembly requires the package candidate contract set to match the release', async () => {
  const candidate = await mkdtemp(join(tmpdir(), 'package-contract-binding-'));
  const contractSetSha256 = 'a'.repeat(64);
  const manifestPath = join(candidate, 'candidate-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ contractSetSha256 }));
  await verifyPackageContractSet(candidate, contractSetSha256);
  await assert.rejects(
    verifyPackageContractSet(candidate, 'b'.repeat(64)),
    /different contract set/u,
  );
  await writeFile(manifestPath, '{}');
  await assert.rejects(
    verifyPackageContractSet(candidate, contractSetSha256),
    /different contract set/u,
  );
});
