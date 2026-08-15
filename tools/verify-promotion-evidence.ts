import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  verifyCandidateManifest,
  verifyConsumerGateResult,
  type ConsumerGateResult,
} from './consumer-gate.ts';
import { verifyContractImpact } from './classify-release-contract.ts';

type ReleaseMode = 'core-only' | 'model-enabled';
type ContractClassification =
  | 'no-impact'
  | 'additive'
  | 'breaking'
  | 'manual-review';

export type PromotionMetadata = {
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly sourceCommit: string;
  readonly releaseVersion: string;
  readonly releaseMode: ReleaseMode;
  readonly contractClassification: ContractClassification;
};

type ConsumerGateConfig = {
  readonly repository: string;
  readonly workflowPath: string;
  readonly requiredWhen: 'always' | 'contract';
};

type JsonRecord = Record<string, unknown>;

const RELEASE_CANDIDATE_WORKFLOW = '.github/workflows/release-candidate.yml';
const CONSUMER_GATES_WORKFLOW = '.github/workflows/consumer-gates.yml';
const REQUIRED_VERIFICATIONS = [
  'windows-install',
  'runtime-product',
  'cross-framework-consumers',
] as const;
const REQUIRED_PRODUCER_JOBS = [
  'verify-windows-install',
  'verify-runtime-product',
  'verify-cross-framework-consumers',
] as const;
const MODEL_ENABLED_PRODUCER_JOB = 'verify-model-enabled-runtime';
const CONTRACT_CLASSIFICATIONS = new Set<ContractClassification>([
  'no-impact',
  'additive',
  'breaking',
  'manual-review',
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} fields are not canonical.`);
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireFullSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full lowercase Git SHA.`);
  }
  return value;
}

function requireReleaseVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
  ) {
    throw new Error('Candidate release version is invalid.');
  }
  return value;
}

function requireReleaseMode(value: unknown): ReleaseMode {
  if (value !== 'core-only' && value !== 'model-enabled') {
    throw new Error('Candidate release mode is invalid.');
  }
  return value;
}

function requireClassification(value: unknown): ContractClassification {
  if (
    typeof value !== 'string' ||
    !CONTRACT_CLASSIFICATIONS.has(value as ContractClassification)
  ) {
    throw new Error('Contract classification is invalid.');
  }
  return value as ContractClassification;
}

function verifyCandidateManifestIdentity(
  value: unknown,
  expectedCandidateId: string,
): PromotionMetadata {
  if (!isRecord(value))
    throw new Error('Candidate manifest must be an object.');
  if (value.candidateId !== expectedCandidateId) {
    throw new Error('Candidate manifest ID does not match promotion input.');
  }
  return {
    candidateId: requireSha256(value.candidateId, 'Candidate ID'),
    candidateManifestSha256: '',
    sourceCommit: requireFullSha(value.sourceCommit, 'Candidate source commit'),
    releaseVersion: requireReleaseVersion(value.releaseVersion),
    releaseMode: requireReleaseMode(value.releaseMode),
    contractClassification: 'no-impact',
  };
}

function verifyCandidateSnapshotBinding(
  value: unknown,
  candidateSnapshotSha256: string,
): void {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) {
    throw new Error('Candidate manifest has no artifact inventory.');
  }
  const snapshot = value.artifacts.find(
    (artifact) =>
      isRecord(artifact) &&
      artifact.path === 'contracts/contract-snapshot.json',
  );
  if (!isRecord(snapshot) || snapshot.sha256 !== candidateSnapshotSha256) {
    throw new Error(
      'Contract snapshot is not bound to the candidate manifest.',
    );
  }
}

function verifyWorkflowRun(
  value: unknown,
  workflowPath: string,
  label: string,
): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (
    value.path !== workflowPath ||
    value.status !== 'completed' ||
    value.conclusion !== 'success'
  ) {
    throw new Error(
      `${label} did not complete successfully for ${workflowPath}.`,
    );
  }
}

function verifyProducerJobs(
  value: readonly unknown[],
  releaseMode: ReleaseMode,
): void {
  const required = new Set<string>([
    'build-candidate',
    ...REQUIRED_PRODUCER_JOBS,
    ...(releaseMode === 'model-enabled' ? [MODEL_ENABLED_PRODUCER_JOB] : []),
  ]);
  const jobs = new Map<string, JsonRecord>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string') {
      throw new Error('Producer candidate jobs contain an invalid record.');
    }
    if (jobs.has(item.name))
      throw new Error(`Producer job is duplicated: ${item.name}.`);
    jobs.set(item.name, item);
  }
  for (const name of required) {
    const job = jobs.get(name);
    if (!job || job.status !== 'completed' || job.conclusion !== 'success') {
      throw new Error(`Required producer job did not pass: ${name}.`);
    }
  }
}

function verifyCandidateVerificationReports(
  value: readonly unknown[],
  candidateId: string,
  releaseMode: ReleaseMode,
): void {
  const required = new Set<string>([
    ...REQUIRED_VERIFICATIONS,
    ...(releaseMode === 'model-enabled' ? ['model-enabled-runtime'] : []),
  ]);
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item))
      throw new Error('Candidate verification report is invalid.');
    exactKeys(
      item,
      ['schemaVersion', 'candidateId', 'verification', 'status'],
      'Candidate verification report',
    );
    if (
      item.schemaVersion !== '1' ||
      item.candidateId !== candidateId ||
      typeof item.verification !== 'string' ||
      item.status !== 'success'
    ) {
      throw new Error(
        'Candidate verification report is not a passing exact-candidate report.',
      );
    }
    if (!required.has(item.verification) || seen.has(item.verification)) {
      throw new Error(
        `Unexpected or duplicate candidate verification: ${String(item.verification)}.`,
      );
    }
    seen.add(item.verification);
  }
  if (
    seen.size !== required.size ||
    [...required].some((name) => !seen.has(name))
  ) {
    throw new Error('Candidate verification reports are incomplete.');
  }
}

function parseConsumerGateConfig(value: unknown): ConsumerGateConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Consumer gate config is empty.');
  }
  return value.map((item) => {
    if (!isRecord(item))
      throw new Error('Consumer gate config contains an invalid gate.');
    if (
      typeof item.repository !== 'string' ||
      typeof item.workflowPath !== 'string' ||
      !['always', 'contract'].includes(String(item.requiredWhen))
    ) {
      throw new Error('Consumer gate config contains an invalid gate.');
    }
    return {
      repository: item.repository,
      workflowPath: item.workflowPath,
      requiredWhen: item.requiredWhen as ConsumerGateConfig['requiredWhen'],
    };
  });
}

function verifyConsumerLedger(
  value: unknown,
  expected: PromotionMetadata,
  config: readonly ConsumerGateConfig[],
): ContractClassification {
  if (!isRecord(value))
    throw new Error('Consumer gate ledger must be an object.');
  exactKeys(
    value,
    [
      'schemaVersion',
      'candidateId',
      'candidateManifestSha256',
      'contractClassification',
      'verdict',
      'gates',
      'resultDigests',
    ],
    'Consumer gate ledger',
  );
  if (
    value.schemaVersion !== '1' ||
    value.candidateId !== expected.candidateId ||
    value.candidateManifestSha256 !== expected.candidateManifestSha256 ||
    value.contractClassification !== expected.contractClassification ||
    value.verdict !== 'passed' ||
    !Array.isArray(value.gates) ||
    !Array.isArray(value.resultDigests)
  ) {
    throw new Error(
      'Consumer gate ledger is not a passing exact-candidate ledger.',
    );
  }
  const classification = requireClassification(value.contractClassification);
  const required = config.filter(
    (gate) => gate.requiredWhen === 'always' || classification !== 'no-impact',
  );
  const gates = value.gates as readonly unknown[];
  const expectedGates = new Map(
    required.map((gate) => [gate.repository, gate] as const),
  );
  if (gates.length !== expectedGates.size) {
    throw new Error(
      'Consumer gate ledger does not contain exactly the required gates.',
    );
  }
  const seen = new Set<string>();
  for (const gateValue of gates) {
    if (
      !isRecord(gateValue) ||
      typeof gateValue.consumerRepository !== 'string'
    ) {
      throw new Error('Consumer gate ledger contains an invalid result.');
    }
    const gate = expectedGates.get(gateValue.consumerRepository);
    if (!gate || seen.has(gateValue.consumerRepository)) {
      throw new Error(
        'Consumer gate ledger contains an unexpected or duplicate repository.',
      );
    }
    verifyConsumerGateResult(gateValue, {
      repository: gate.repository,
      workflowPath: gate.workflowPath,
      workflowRunId: gateValue.workflowRunId as number,
      candidateId: expected.candidateId,
      candidateManifestSha256: expected.candidateManifestSha256,
    });
    seen.add(gate.repository);
  }
  if (seen.size !== expectedGates.size) {
    throw new Error('Consumer gate ledger is incomplete.');
  }
  const resultDigests = value.resultDigests as readonly unknown[];
  if (resultDigests.length !== gates.length) {
    throw new Error('Consumer gate result digests are incomplete.');
  }
  const digestKeys = new Set<string>();
  for (const digestValue of resultDigests) {
    if (!isRecord(digestValue)) {
      throw new Error('Consumer gate result digest is invalid.');
    }
    exactKeys(
      digestValue,
      ['consumerRepository', 'workflowRunId', 'sha256'],
      'Consumer gate result digest',
    );
    if (
      typeof digestValue.consumerRepository !== 'string' ||
      typeof digestValue.workflowRunId !== 'number' ||
      !Number.isSafeInteger(digestValue.workflowRunId) ||
      digestValue.workflowRunId < 1
    ) {
      throw new Error('Consumer gate result digest identity is invalid.');
    }
    requireSha256(digestValue.sha256, 'Consumer gate result digest');
    const key = `${digestValue.consumerRepository}:${digestValue.workflowRunId}`;
    if (
      digestKeys.has(key) ||
      !gates.some(
        (gate) =>
          isRecord(gate) &&
          gate.consumerRepository === digestValue.consumerRepository &&
          gate.workflowRunId === digestValue.workflowRunId,
      )
    ) {
      throw new Error(
        'Consumer gate result digest does not match a verified run.',
      );
    }
    digestKeys.add(key);
  }
  return classification;
}

export function verifyPromotionEvidence(input: {
  readonly candidateManifest: unknown;
  readonly candidateManifestSha256: string;
  readonly candidateId: string;
  readonly producerRun: unknown;
  readonly producerJobs: readonly unknown[];
  readonly verificationReports: readonly unknown[];
  readonly contractImpact: unknown;
  readonly candidateSnapshotSha256: string;
  readonly consumerGateRun: unknown;
  readonly consumerGateLedger: unknown;
  readonly consumerGateConfig: unknown;
}): PromotionMetadata {
  const manifestMetadata = verifyCandidateManifestIdentity(
    input.candidateManifest,
    input.candidateId,
  );
  const candidateManifestSha256 = requireSha256(
    input.candidateManifestSha256,
    'Candidate manifest digest',
  );
  verifyWorkflowRun(
    input.producerRun,
    RELEASE_CANDIDATE_WORKFLOW,
    'Producer candidate run',
  );
  verifyWorkflowRun(
    input.consumerGateRun,
    CONSUMER_GATES_WORKFLOW,
    'Consumer gate run',
  );
  verifyProducerJobs(input.producerJobs, manifestMetadata.releaseMode);
  verifyCandidateVerificationReports(
    input.verificationReports,
    manifestMetadata.candidateId,
    manifestMetadata.releaseMode,
  );
  const contractImpact = verifyContractImpact(input.contractImpact, {
    candidateId: manifestMetadata.candidateId,
    candidateSnapshotSha256: input.candidateSnapshotSha256,
  });
  verifyCandidateSnapshotBinding(
    input.candidateManifest,
    input.candidateSnapshotSha256,
  );
  const metadata = {
    ...manifestMetadata,
    candidateManifestSha256,
    contractClassification: contractImpact.classification,
  };
  const contractClassification = verifyConsumerLedger(
    input.consumerGateLedger,
    metadata,
    parseConsumerGateConfig(input.consumerGateConfig),
  );
  return { ...metadata, contractClassification };
}

async function findFiles(root: string, filename: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...(await findFiles(path, filename)));
    else if (entry.isFile() && entry.name === filename) matches.push(path);
  }
  return matches;
}

function ghJson(endpoint: string): unknown {
  const result = spawnSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    env: { ...process.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh api failed (${result.status}).`);
  return JSON.parse(result.stdout);
}

function requiredArgument(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}.`);
  return value;
}

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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const artifactRoot = resolve(
    requiredArgument(values, '--candidate-artifacts'),
  );
  const candidateId = requiredArgument(values, '--candidate-id');
  const candidateManifestSha256 = requiredArgument(
    values,
    '--candidate-manifest-sha256',
  );
  const producerRepository = requiredArgument(values, '--producer-repository');
  const producerRunId = Number(requiredArgument(values, '--producer-run-id'));
  const consumerGateRunId = Number(
    requiredArgument(values, '--consumer-gate-run-id'),
  );
  const consumerGateLedgerPath = resolve(
    requiredArgument(values, '--consumer-gate-ledger'),
  );
  const consumerGateConfigPath = resolve(
    requiredArgument(values, '--consumer-gate-config'),
  );
  const output = resolve(requiredArgument(values, '--output'));
  if (!Number.isSafeInteger(producerRunId) || producerRunId < 1) {
    throw new Error('Producer run ID is invalid.');
  }
  if (!Number.isSafeInteger(consumerGateRunId) || consumerGateRunId < 1) {
    throw new Error('Consumer gate run ID is invalid.');
  }
  const manifestPaths = await findFiles(
    artifactRoot,
    'candidate-manifest.json',
  );
  if (manifestPaths.length !== 1) {
    throw new Error(
      `Expected exactly one candidate manifest; found ${manifestPaths.length}.`,
    );
  }
  const candidateRoot = dirname(manifestPaths[0]!);
  const candidateManifest = await readJson(manifestPaths[0]!);
  const manifestIdentity = verifyCandidateManifestIdentity(
    candidateManifest,
    candidateId,
  );
  await verifyCandidateManifest(candidateRoot, {
    candidateId,
    candidateManifestSha256,
    sourceCommit: manifestIdentity.sourceCommit,
    releaseVersion: manifestIdentity.releaseVersion,
  });
  const reportNames = [
    'windows-install.json',
    'runtime-product.json',
    'cross-framework-consumers.json',
    ...(manifestIdentity.releaseMode === 'model-enabled'
      ? ['model-enabled-runtime.json']
      : []),
  ];
  const reportPaths = (
    await Promise.all(reportNames.map((name) => findFiles(artifactRoot, name)))
  ).flat();
  const contractImpactPaths = await findFiles(
    artifactRoot,
    'contract-impact.json',
  );
  if (contractImpactPaths.length !== 1) {
    throw new Error(
      `Expected exactly one contract impact record; found ${contractImpactPaths.length}.`,
    );
  }
  const snapshotPath = join(
    candidateRoot,
    'contracts',
    'contract-snapshot.json',
  );
  const candidateSnapshotSha256 = createHash('sha256')
    .update(await readFile(snapshotPath))
    .digest('hex');
  const producerRun = ghJson(
    `repos/${producerRepository}/actions/runs/${producerRunId}`,
  );
  const jobsPayload = ghJson(
    `repos/${producerRepository}/actions/runs/${producerRunId}/jobs?per_page=100`,
  );
  const consumerGateRun = ghJson(
    `repos/${producerRepository}/actions/runs/${consumerGateRunId}`,
  );
  const metadata = verifyPromotionEvidence({
    candidateManifest,
    candidateManifestSha256,
    candidateId,
    producerRun,
    producerJobs:
      isRecord(jobsPayload) && Array.isArray(jobsPayload.jobs)
        ? jobsPayload.jobs
        : [],
    verificationReports: await Promise.all(reportPaths.map(readJson)),
    contractImpact: await readJson(contractImpactPaths[0]),
    candidateSnapshotSha256,
    consumerGateRun,
    consumerGateLedger: await readJson(consumerGateLedgerPath),
    consumerGateConfig: await readJson(consumerGateConfigPath),
  });
  const producerJobNames =
    isRecord(jobsPayload) && Array.isArray(jobsPayload.jobs)
      ? jobsPayload.jobs
          .map((job) => (isRecord(job) ? job.name : null))
          .filter((name): name is string => typeof name === 'string')
      : [];
  await writeFile(
    output,
    `${JSON.stringify({ ...metadata, candidateRoot, producerRunId, consumerGateRunId, producerJobNames }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `Promotion evidence verified for candidate ${candidateId}.\n`,
  );
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
