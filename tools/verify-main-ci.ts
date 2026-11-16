import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const futureSkewMs = 5 * 60 * 1000;

export interface MainCiWorkflowRun {
  readonly workflow_id?: unknown;
  readonly path?: unknown;
  readonly event?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
  readonly head_sha?: unknown;
  readonly head_branch?: unknown;
  readonly id?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
}

interface MainCiWorkflow {
  readonly id?: unknown;
  readonly path?: unknown;
  readonly state?: unknown;
}

export interface MainCiClient {
  getWorkflow(repository: string, workflowPath: string): MainCiWorkflow;
  listPushRuns(
    repository: string,
    workflowId: number,
    branch: string,
    commitSha: string,
  ): readonly MainCiWorkflowRun[];
}

interface VerifyMainCiOptions {
  readonly repository: string;
  readonly commitSha: string;
  readonly workflowPath: string;
  readonly branch: string;
  readonly now?: number;
}

interface VerifiedMainCiResult {
  readonly branch: string;
  readonly commitSha: string;
  readonly runId: unknown;
  readonly workflowId: number;
  readonly workflowPath: string;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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
    throw new Error(`gh api failed (${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const defaultMainCiClient: MainCiClient = {
  getWorkflow(repository, workflowPath) {
    return ghJson(
      `repos/${repository}/actions/workflows/${encodeURIComponent(workflowPath)}`,
    ) as MainCiWorkflow;
  },
  listPushRuns(repository, workflowId, branch, commitSha) {
    const runs = ghJson(
      `repos/${repository}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(branch)}&event=push&status=success&head_sha=${commitSha}&per_page=100`,
    ) as { readonly workflow_runs?: readonly MainCiWorkflowRun[] };
    return runs.workflow_runs ?? [];
  },
};

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value) {
      throw new Error('Arguments must be complete --name value pairs.');
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}.`);
    values.set(name, value);
  }
  return values;
}

export function verifyMainCi(
  options: VerifyMainCiOptions,
  client: MainCiClient = defaultMainCiClient,
): VerifiedMainCiResult {
  const { repository, commitSha, workflowPath, branch } = options;
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) {
    throw new Error('Main CI commit must be a full lowercase Git SHA.');
  }
  if (branch !== 'main') {
    throw new Error('Release CI verification is restricted to the main branch.');
  }

  const workflow = client.getWorkflow(repository, workflowPath);
  if (
    workflow.path !== workflowPath ||
    workflow.state !== 'active' ||
    typeof workflow.id !== 'number' ||
    !Number.isSafeInteger(workflow.id)
  ) {
    throw new Error('Trusted main CI workflow identity is invalid.');
  }
  const workflowRuns = client.listPushRuns(
    repository,
    workflow.id,
    branch,
    commitSha,
  );
  const now = options.now ?? Date.now();
  const qualifying = workflowRuns.filter((run) => {
    const created = typeof run.created_at === 'string' ? Date.parse(run.created_at) : Number.NaN;
    const updated = typeof run.updated_at === 'string' ? Date.parse(run.updated_at) : Number.NaN;
    return (
      run.workflow_id === workflow.id &&
      run.path === workflowPath &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.head_sha === commitSha &&
      run.head_branch === branch &&
      Number.isSafeInteger(run.id) &&
      Number.isFinite(created) &&
      Number.isFinite(updated) &&
      created <= now + futureSkewMs &&
      updated >= created &&
      updated <= now + futureSkewMs
    );
  });
  if (qualifying.length !== 1) {
    throw new Error(
      `Expected exactly one successful exact-commit main CI push run; found ${qualifying.length}.`,
    );
  }
  const [run] = qualifying;
  return {
    branch,
    commitSha,
    runId: run?.id,
    workflowId: workflow.id,
    workflowPath,
  };
}

function main(): void {
  const values = parseArguments(process.argv.slice(2));
  const result = verifyMainCi({
    repository: required(values, '--repository'),
    commitSha: required(values, '--commit'),
    workflowPath: required(values, '--workflow-path'),
    branch: required(values, '--branch'),
  });
  process.stdout.write(canonicalJson(result));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
