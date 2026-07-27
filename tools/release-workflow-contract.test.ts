import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(
  join(repoRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);

test('release workflow uses one protected environment for verification and publication', () => {
  assert.equal(
    workflow.match(/^\s+environment: capture-release$/gmu)?.length,
    2,
  );
  assert.doesNotMatch(workflow, /capture-release-build/u);
  assert.doesNotMatch(workflow, /capture-release-publish/u);
});

test('release workflow materializes one evidence bundle and keeps attestation', () => {
  assert.match(
    workflow,
    /CAPTURE_RELEASE_EVIDENCE_BUNDLE_B64: \$\{\{ secrets\.CAPTURE_RELEASE_EVIDENCE_BUNDLE_B64 \}\}/u,
  );
  assert.doesNotMatch(workflow, /CAPTURE_RELEASE_EVIDENCE_B64/u);
  assert.doesNotMatch(workflow, /CAPTURE_RELEASE_FIXTURE_REGISTRY_B64/u);
  assert.match(workflow, /ConvertFrom-Json/u);
  assert.match(workflow, /fixtureRegistry/u);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /CAPTURE_RELEASE_ATTESTATION_VERIFIED=true/u);
  assert.match(workflow, /CAPTURE_RELEASE_EVIDENCE_SIGNER_WORKFLOW/u);
});
