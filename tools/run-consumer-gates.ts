import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  aggregateConsumerGateResults,
  sha256File,
  verifyCandidateManifest,
  verifyConsumerGateResult,
  writeConsumerGateLedger,
  type ConsumerGateResult,
} from './consumer-gate.ts';
import { verifyContractImpact } from './classify-release-contract.ts';

type GateConfig = {
  readonly name: string;
  readonly repository: string;
  readonly workflowPath: string;
  readonly ref: string;
  readonly requiredWhen: 'always' | 'contract';
};

type WorkflowRun = {
  readonly id?: unknown;
  readonly workflow_id?: unknown;
  readonly path?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
  readonly head_branch?: unknown;
  readonly created_at?: unknown;
};

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || values.has(name)) {
      throw new Error('Arguments must be unique --name value pairs.');
    }
    values.set(name, value);
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}.`);
  return value;
}

function ghJson(endpoint: string): unknown {
  const result = spawnSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    env: { ...process.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `gh api failed (${result.status}): ${result.stderr.replace(/(?:gh[pousr]_[A-Za-z0-9_\-]+|github_pat_[A-Za-z0-9_\-]+) /gu, '[REDACTED] ')}`,
    );
  }
  return JSON.parse(result.stdout);
}

function ghRequest(args: readonly string[]): void {
  const result = spawnSync('gh', ['api', ...args], {
    encoding: 'utf8',
    env: { ...process.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`gh api request failed (${result.status}).`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function validateConfig(value: unknown): GateConfig[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Consumer gate config must contain at least one gate.');
  const names = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Consumer gate config contains an invalid gate.');
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.join(',') !== 'name,ref,repository,requiredWhen,workflowPath' ||
      typeof record.name !== 'string' ||
      typeof record.repository !== 'string' ||
      typeof record.workflowPath !== 'string' ||
      typeof record.ref !== 'string' ||
      !['always', 'contract'].includes(String(record.requiredWhen))
    ) {
      throw new Error('Consumer gate config contains an invalid gate.');
    }
    if (names.has(record.name))
      throw new Error(`Consumer gate name is duplicated: ${record.name}.`);
    names.add(record.name);
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(record.repository) ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(record.workflowPath) ||
      !/^[A-Za-z0-9_.-]+$/u.test(record.ref)
    ) {
      throw new Error('Consumer gate config contains an invalid gate.');
    }
    return {
      name: record.name,
      repository: record.repository,
      workflowPath: record.workflowPath,
      ref: record.ref,
      requiredWhen: record.requiredWhen as GateConfig['requiredWhen'],
    };
  });
}

async function findRun(
  gate: GateConfig,
  workflowId: number,
  ref: string,
  beforeIds: Set<number>,
  notBefore: number,
): Promise<WorkflowRun> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = ghJson(
      `repos/${gate.repository}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(ref)}&event=workflow_dispatch&per_page=100`,
    ) as { workflow_runs?: readonly WorkflowRun[] };
    const candidates = (response.workflow_runs ?? []).filter((run) => {
      const createdAt =
        typeof run.created_at === 'string'
          ? Date.parse(run.created_at)
          : Number.NaN;
      return (
        Number.isSafeInteger(run.id) &&
        !beforeIds.has(run.id as number) &&
        run.workflow_id === workflowId &&
        run.path === gate.workflowPath &&
        run.head_branch === ref &&
        Number.isFinite(createdAt) &&
        createdAt >= notBefore - 10_000
      );
    });
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1)
      throw new Error(
        `Multiple new runs matched ${gate.name}; refusing ambiguous gate tracking.`,
      );
    await sleep(5_000);
  }
  throw new Error(
    `Consumer workflow run for ${gate.name} was not discoverable after dispatch.`,
  );
}

async function waitForRun(
  gate: GateConfig,
  run: WorkflowRun,
): Promise<WorkflowRun> {
  const runId = run.id;
  if (!Number.isSafeInteger(runId))
    throw new Error(`Consumer workflow run ID for ${gate.name} is invalid.`);
  const deadline = Date.now() + 90 * 60_000;
  while (Date.now() < deadline) {
    const current = ghJson(
      `repos/${gate.repository}/actions/runs/${runId}`,
    ) as WorkflowRun;
    if (current.status === 'completed') {
      if (current.conclusion !== 'success') {
        throw new Error(
          `Consumer workflow ${gate.name} concluded ${String(current.conclusion)}.`,
        );
      }
      return current;
    }
    await sleep(10_000);
  }
  throw new Error(
    `Consumer workflow ${gate.name} did not complete before the timeout.`,
  );
}

async function downloadResult(
  gate: GateConfig,
  runId: number,
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const result = spawnSync(
    'gh',
    [
      'run',
      'download',
      String(runId),
      '--repo',
      gate.repository,
      '--name',
      'consumer-gate-result-v1',
      '--dir',
      directory,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Consumer gate result download failed for ${gate.name}.`);
  const names = await readdir(directory, { recursive: true });
  const matches = names.filter(
    (name) => name === 'consumer-gate-result-v1.json',
  );
  if (matches.length !== 1)
    throw new Error(`Expected exactly one result file for ${gate.name}.`);
  return join(directory, matches[0]!);
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const configPath = resolve(required(values, '--config'));
  const candidate = resolve(required(values, '--candidate'));
  const candidateId = required(values, '--candidate-id');
  const candidateManifestSha256 = required(
    values,
    '--candidate-manifest-sha256',
  );
  const sourceCommit = required(values, '--source-commit');
  const releaseVersion = required(values, '--release-version');
  const producerRepository = required(values, '--producer-repository');
  const producerRunId = Number(required(values, '--producer-run-id'));
  const output = resolve(required(values, '--output'));
  if (!Number.isSafeInteger(producerRunId) || producerRunId < 1)
    throw new Error('Producer run ID is invalid.');
  await verifyCandidateManifest(candidate, {
    candidateId,
    candidateManifestSha256,
    sourceCommit,
    releaseVersion,
  });
  const contractSnapshotPath = join(
    candidate,
    'contracts',
    'contract-snapshot.json',
  );
  const contractImpact = verifyContractImpact(
    JSON.parse(
      await readFile(join(candidate, 'contract-impact.json'), 'utf8'),
    ) as unknown,
    {
      candidateId,
      candidateSnapshotSha256: await sha256File(contractSnapshotPath),
    },
  );
  const contractClassification = contractImpact.classification;
  const config = validateConfig(
    JSON.parse(await readFile(configPath, 'utf8')) as unknown,
  );
  const gates = config.filter(
    (gate) =>
      gate.requiredWhen === 'always' || contractClassification !== 'no-impact',
  );
  const producerRun = ghJson(
    `repos/${producerRepository}/actions/runs/${producerRunId}`,
  ) as WorkflowRun;
  if (
    producerRun.status !== 'completed' ||
    producerRun.conclusion !== 'success' ||
    producerRun.path !== '.github/workflows/release-candidate.yml'
  ) {
    throw new Error(
      'Producer candidate workflow has not completed successfully.',
    );
  }
  const results: ConsumerGateResult[] = [];
  const resultDigests = [] as Array<{
    consumerRepository: string;
    workflowRunId: number;
    sha256: string;
  }>;
  for (const gate of gates) {
    const workflow = ghJson(
      `repos/${gate.repository}/actions/workflows/${encodeURIComponent(gate.workflowPath)}`,
    ) as { id?: unknown; path?: unknown; state?: unknown };
    if (
      !Number.isSafeInteger(workflow.id) ||
      workflow.path !== gate.workflowPath ||
      workflow.state !== 'active'
    ) {
      throw new Error(
        `Consumer workflow is missing or inactive: ${gate.repository}/${gate.workflowPath}.`,
      );
    }
    const beforeRuns = ghJson(
      `repos/${gate.repository}/actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(gate.ref)}&event=workflow_dispatch&per_page=100`,
    ) as { workflow_runs?: readonly WorkflowRun[] };
    const beforeIds = new Set(
      (beforeRuns.workflow_runs ?? []).flatMap((run) =>
        Number.isSafeInteger(run.id) ? [run.id as number] : [],
      ),
    );
    const dispatchedAt = Date.now();
    ghRequest([
      '--method',
      'POST',
      `repos/${gate.repository}/actions/workflows/${workflow.id}/dispatches`,
      '-f',
      `ref=${gate.ref}`,
      '-f',
      `inputs[producer_repository]=${producerRepository}`,
      '-f',
      `inputs[producer_run_id]=${producerRunId}`,
      '-f',
      `inputs[candidate_id]=${candidateId}`,
      '-f',
      `inputs[candidate_manifest_sha256]=${candidateManifestSha256}`,
      '-f',
      `inputs[source_commit]=${sourceCommit}`,
      '-f',
      `inputs[release_version]=${releaseVersion}`,
      '-f',
      `inputs[contract_classification]=${contractClassification}`,
    ]);
    const dispatched = await findRun(
      gate,
      workflow.id as number,
      gate.ref,
      beforeIds,
      dispatchedAt,
    );
    const completed = await waitForRun(gate, dispatched);
    const resultDirectory = join(
      resolve(output, '..'),
      `consumer-gate-${gate.name}`,
    );
    const resultPath = await downloadResult(
      gate,
      completed.id as number,
      resultDirectory,
    );
    results.push(
      verifyConsumerGateResult(
        JSON.parse(await readFile(resultPath, 'utf8')) as unknown,
        {
          repository: gate.repository,
          workflowPath: gate.workflowPath,
          workflowRunId: completed.id as number,
          candidateId,
          candidateManifestSha256,
        },
      ),
    );
    resultDigests.push({
      consumerRepository: gate.repository,
      workflowRunId: completed.id as number,
      sha256: await sha256File(resultPath),
    });
  }
  await writeConsumerGateLedger(
    output,
    aggregateConsumerGateResults(
      results,
      candidateId,
      candidateManifestSha256,
      contractClassification,
      resultDigests,
    ),
  );
  process.stdout.write(`Consumer gate ledger written to ${output}.\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
