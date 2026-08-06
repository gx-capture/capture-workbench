import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ConsumerGateExpectation = {
  readonly repository: string;
  readonly workflowPath: string;
  readonly workflowRunId: number;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
};

export type ConsumerGateResult = {
  readonly schemaVersion: '1';
  readonly consumerRepository: string;
  readonly consumerCommit: string;
  readonly workflowPath: string;
  readonly workflowRunId: number;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly verdict: 'passed';
  readonly checks: readonly unknown[];
  readonly startedAt: string;
  readonly completedAt: string;
};

export type ConsumerGateLedger = {
  readonly schemaVersion: '1';
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly contractClassification: string;
  readonly verdict: 'passed';
  readonly gates: readonly ConsumerGateResult[];
  readonly resultDigests: readonly ConsumerGateResultDigest[];
};

export type ConsumerGateResultDigest = {
  readonly consumerRepository: string;
  readonly workflowRunId: number;
  readonly sha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
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

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
}

export function verifyConsumerGateResult(
  value: unknown,
  expectation: ConsumerGateExpectation,
): ConsumerGateResult {
  if (!isRecord(value))
    throw new Error('Consumer gate result must be an object.');
  exactKeys(
    value,
    [
      'schemaVersion',
      'consumerRepository',
      'consumerCommit',
      'workflowPath',
      'workflowRunId',
      'candidateId',
      'candidateManifestSha256',
      'verdict',
      'checks',
      'startedAt',
      'completedAt',
    ],
    'Consumer gate result',
  );
  const result = value as Partial<ConsumerGateResult>;
  if (result.schemaVersion !== '1')
    throw new Error('Consumer gate result schema is unsupported.');
  if (result.consumerRepository !== expectation.repository) {
    throw new Error(
      'Consumer gate result repository does not match the dispatched repository.',
    );
  }
  if (result.workflowPath !== expectation.workflowPath) {
    throw new Error(
      'Consumer gate result workflow path does not match the dispatched workflow.',
    );
  }
  if (result.workflowRunId !== expectation.workflowRunId) {
    throw new Error(
      'Consumer gate result run ID does not match the dispatched run.',
    );
  }
  if (result.candidateId !== expectation.candidateId) {
    throw new Error(
      'Consumer gate result candidate ID does not match the producer candidate.',
    );
  }
  if (result.candidateManifestSha256 !== expectation.candidateManifestSha256) {
    throw new Error(
      'Consumer gate result manifest digest does not match the producer candidate.',
    );
  }
  if (result.verdict !== 'passed')
    throw new Error('Consumer gate result is not passed.');
  if (!Array.isArray(result.checks))
    throw new Error('Consumer gate checks must be an array.');
  if (!Number.isSafeInteger(result.workflowRunId) || result.workflowRunId < 1)
    throw new Error('Consumer gate workflow run ID is invalid.');
  requireFullSha(result.consumerCommit, 'Consumer commit');
  requireTimestamp(result.startedAt, 'Consumer gate start');
  requireTimestamp(result.completedAt, 'Consumer gate completion');
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
    throw new Error('Consumer gate completion precedes its start.');
  }
  return result as ConsumerGateResult;
}

export async function verifyCandidateManifest(
  candidateDirectory: string,
  expected: {
    readonly candidateId: string;
    readonly candidateManifestSha256: string;
    readonly sourceCommit: string;
    readonly releaseVersion: string;
  },
): Promise<void> {
  const manifestPath = join(candidateDirectory, 'candidate-manifest.json');
  const bytes = await readFile(manifestPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected.candidateManifestSha256) {
    throw new Error(
      'Downloaded candidate manifest digest does not match the dispatch input.',
    );
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as Record<
    string,
    unknown
  >;
  if (
    manifest.candidateId !== expected.candidateId ||
    manifest.sourceCommit !== expected.sourceCommit ||
    manifest.releaseVersion !== expected.releaseVersion
  ) {
    throw new Error(
      'Downloaded candidate manifest identity does not match the dispatch input.',
    );
  }
  requireSha256(manifest.candidateId, 'Candidate ID');
}

export function aggregateConsumerGateResults(
  results: readonly ConsumerGateResult[],
  candidateId: string,
  candidateManifestSha256: string,
  contractClassification: string,
  resultDigests: readonly ConsumerGateResultDigest[] = [],
): ConsumerGateLedger {
  requireSha256(candidateId, 'Candidate ID');
  requireSha256(candidateManifestSha256, 'Candidate manifest digest');
  if (results.length === 0)
    throw new Error('At least one consumer gate is required.');
  if (resultDigests.length !== results.length)
    throw new Error(
      'Every consumer gate must have a downloaded result digest.',
    );
  for (const digest of resultDigests) {
    if (
      typeof digest.consumerRepository !== 'string' ||
      !Number.isSafeInteger(digest.workflowRunId) ||
      digest.workflowRunId < 1
    ) {
      throw new Error('Consumer gate result digest identity is invalid.');
    }
    requireSha256(digest.sha256, 'Consumer gate result digest');
  }
  const resultKeys = new Set(
    results.map(
      (result) => `${result.consumerRepository}:${result.workflowRunId}`,
    ),
  );
  const digestKeys = new Set(
    resultDigests.map(
      (digest) => `${digest.consumerRepository}:${digest.workflowRunId}`,
    ),
  );
  if (
    resultKeys.size !== results.length ||
    digestKeys.size !== resultDigests.length ||
    resultKeys.size !== digestKeys.size ||
    [...resultKeys].some((key) => !digestKeys.has(key))
  ) {
    throw new Error(
      'Consumer gate result digests do not match the verified runs.',
    );
  }
  return {
    schemaVersion: '1',
    candidateId,
    candidateManifestSha256,
    contractClassification,
    verdict: 'passed',
    gates: [...results].sort((left, right) =>
      left.consumerRepository.localeCompare(right.consumerRepository),
    ),
    resultDigests: [...resultDigests].sort((left, right) =>
      left.consumerRepository.localeCompare(right.consumerRepository),
    ),
  };
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export async function writeConsumerGateLedger(
  output: string,
  ledger: ConsumerGateLedger,
): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}
