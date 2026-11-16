import assert from 'node:assert/strict';
import test from 'node:test';

import {
  verifyMainCi,
  type MainCiClient,
  type MainCiWorkflowRun,
} from './verify-main-ci.ts';

const repository = 'gx-capture/capture-workbench';
const workflowPath = '.github/workflows/ci.yml';
const branch = 'main';
const commitSha = 'a'.repeat(40);
const workflowId = 12345;
const now = Date.parse('2026-11-16T08:00:00.000Z');

function createRun(overrides: Partial<MainCiWorkflowRun> = {}): MainCiWorkflowRun {
  return {
    workflow_id: workflowId,
    path: workflowPath,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: commitSha,
    head_branch: branch,
    id: 998877,
    created_at: '2026-11-16T07:30:00.000Z',
    updated_at: '2026-11-16T07:55:00.000Z',
    ...overrides,
  };
}

function createClient(runs: readonly MainCiWorkflowRun[]): MainCiClient {
  return {
    getWorkflow: () => ({
      id: workflowId,
      path: workflowPath,
      state: 'active',
    }),
    listPushRuns: () => runs,
  };
}

test('accepts a single successful push run on main for the exact commit', () => {
  const result = verifyMainCi(
    { repository, commitSha, workflowPath, branch, now },
    createClient([createRun()]),
  );
  assert.deepEqual(result, {
    branch,
    commitSha,
    runId: 998877,
    workflowId,
    workflowPath,
  });
});

test('a successful workflow_dispatch run for the commit is not accepted', () => {
  assert.throws(
    () =>
      verifyMainCi(
        { repository, commitSha, workflowPath, branch, now },
        createClient([createRun({ event: 'workflow_dispatch' })]),
      ),
    /Expected exactly one successful exact-commit main CI push run; found 0\./u,
  );
});

test('rejects non-main branches, pull_request runs, and mismatched commits', () => {
  assert.throws(
    () =>
      verifyMainCi(
        { repository, commitSha, workflowPath, branch: 'feat/branch', now },
        createClient([createRun({ head_branch: 'feat/branch' })]),
      ),
    /Release CI verification is restricted to the main branch\./u,
  );

  assert.throws(
    () =>
      verifyMainCi(
        { repository, commitSha, workflowPath, branch, now },
        createClient([
          createRun({ event: 'pull_request' }),
          createRun({ head_sha: 'b'.repeat(40) }),
          createRun({ head_branch: 'other' }),
        ]),
      ),
    /Expected exactly one successful exact-commit main CI push run; found 0\./u,
  );
});
