import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import {
  boundWorkerStageSequence,
  isAllowedWorkerStage,
  MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH,
  MAX_WORKER_DIAGNOSTIC_STAGES,
} from './generated-worker-stage-policy.ts';

export type AcceptanceStatus = 'running' | 'completed' | 'failed';

export interface AcceptanceRun {
  readonly project: string;
  readonly runId: string;
  readonly recordVideo: boolean;
  readonly artifactRoot: string;
}

export interface AcceptanceArtifactInput {
  readonly path: string;
  readonly kind: 'video' | 'screenshot' | 'trace' | 'report' | 'log' | 'other';
  /** Optional identity returned by an atomic artifact producer. */
  readonly expectedIdentity?: {
    readonly bytes: number;
    readonly sha256: string;
  };
}

export interface AcceptanceArtifact {
  readonly path: string;
  readonly kind: AcceptanceArtifactInput['kind'];
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Bounded privacy-safe identity projection of the runtime execution proof.
 * Hashes, profile identity, page scope, and GPU execution counts are retained
 * for cross-artifact binding; raw OCR/source content, local paths, tokens, and
 * runtime diagnostics are intentionally excluded.
 */
export interface AcceptanceOcrExecutionProofSummary {
  readonly artifactPath: 'ocr-device-proof-v1.json';
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaVersion: '1';
  readonly planSha256: string;
  readonly identitySha256: string;
  readonly dmlDeviceId: number;
  readonly dmlNodeCount: number;
  readonly sessionCount: number;
  readonly executionSha256: string;
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  readonly workerSha256: string;
  readonly modelSha256: string;
  readonly profileId: string;
  readonly profileSpecSha256: string;
  readonly contractSetSha256: string;
  readonly requestedPageScope: readonly number[] | null;
}

export interface AcceptanceOcrExecutionFailureSummary {
  readonly artifactPath: 'ocr-execution-failure-v1.json';
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaVersion: '1';
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  readonly workerSha256: string;
  readonly sourceRole: 'pdf' | 'image' | 'audio';
  readonly stageSequence: readonly string[];
  readonly failureClass:
    | 'entry-point-missing'
    | 'timeout'
    | 'exit-before-response'
    | 'no-response'
    | 'termination'
    | 'response-error'
    | 'exit-nonzero'
    | 'protocol'
    | 'worker'
    | 'unavailable';
  readonly exitCode?: number;
}

export interface AcceptanceOcrExecutionFailureExpectation {
  readonly sourceRole: AcceptanceOcrExecutionFailureSummary['sourceRole'];
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  readonly workerSha256: string;
}

export interface AcceptanceEvidenceSummary {
  /** Optional phase markers distinguish the OCR-only checkpoint from structuring/release success. */
  readonly acceptanceMode?: 'ocr-only' | 'structuring';
  readonly ocrProofSucceeded?: boolean;
  readonly structuringSucceeded?: boolean;
  readonly releaseGateSatisfied?: boolean;
  readonly sourceSha256?: string;
  readonly importedSourceSha256?: string;
  readonly runtimeArtifactSha256?: string;
  readonly contractSetSha256?: string;
  readonly workerArchiveSha256?: string;
  readonly workerExecutableSha256?: string;
  readonly candidateId?: string;
  readonly catalogSha256?: string;
  readonly modelManifestSha256?: string;
  readonly sourceLockSha256?: string;
  readonly modelFileCount?: number;
  readonly modelExtractedBytes?: number;
  readonly authenticatedRuntimePreflight?: 'gpu-dml' | 'cpu-fallback';
  readonly uiGpuBeforeImport?: boolean;
  readonly cer?: number | null;
  readonly expectedAnchorCount?: number;
  readonly matchedAnchorCount?: number;
  readonly pdfPageScope?: {
    readonly sourcePageCount: number;
    readonly requestedPageNumbers: readonly number[];
    readonly processedPageNumbers: readonly number[];
  };
  readonly provenance?: {
    readonly ocrEngine?: string;
    readonly ocrModel?: string;
    readonly ocrDevice?: string;
    readonly structuringEngine?: string;
    readonly structuringModel?: string;
  };
  readonly ocrExecutionProof?: AcceptanceOcrExecutionProofSummary;
  readonly ocrExecutionFailure?: AcceptanceOcrExecutionFailureSummary;
}

/**
 * Cleanup evidence is deliberately explicit.  The legacy app/sidecar/port
 * flags remain useful diagnostics, while the owned-* flags are the cross-
 * project gate that proves no model-enabled child can overlap the next app.
 */
export interface AcceptanceCleanup {
  readonly app: boolean;
  readonly sidecar: boolean;
  readonly cdpPort: boolean;
  readonly temporaryAppData: boolean;
  readonly ownedPids: boolean;
  readonly ownedListeners: boolean;
  readonly ownedWorkers: boolean;
}

export interface AcceptanceManifestInput {
  readonly project: string;
  readonly runId: string;
  readonly status: AcceptanceStatus;
  readonly recordVideo: boolean;
  readonly artifacts: readonly AcceptanceArtifactInput[];
  readonly errors?: readonly string[];
  readonly consoleErrors?: readonly string[];
  readonly pageErrors?: readonly string[];
  readonly cleanup: AcceptanceCleanup;
  readonly fixture?: {
    readonly name: string;
    readonly sha256: string;
  };
  /** Summary already authenticated by the terminal OCR smoke before teardown. */
  readonly verifiedOcrExecutionFailure?: AcceptanceOcrExecutionFailureSummary;
  readonly evidence?: AcceptanceEvidenceSummary;
}

export interface AcceptanceManifest {
  readonly schemaVersion: 2;
  readonly project: string;
  readonly runId: string;
  readonly status: AcceptanceStatus;
  readonly recordVideo: boolean;
  readonly artifacts: readonly AcceptanceArtifact[];
  readonly errors: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly cleanup: AcceptanceCleanup;
  readonly fixture?: AcceptanceManifestInput['fixture'];
  readonly evidence?: AcceptanceEvidenceSummary;
}

export type AcceptanceManifestReadResult =
  | { readonly status: 'valid'; readonly manifest: AcceptanceManifest; readonly sourceManifestSha256: string } | { readonly status: 'missing-or-invalid'; readonly sourceManifestSha256: string | null };

export interface AcceptanceManifestReadContext {
  readonly project: string;
  readonly runId: string;
  readonly recordVideo: boolean;
  readonly artifactRoot: string;
  readonly validateTerminalManifest: (manifest: { status?: unknown; [key: string]: unknown }) => boolean;
  readonly validateChildManifest: (manifest: { status?: unknown; [key: string]: unknown }, requireCleanupComplete?: boolean) => Promise<boolean>;
}

/**
 * Reads the child manifest after the child has closed. Hashing happens before
 * parsing so readable malformed bytes remain bound to the terminal evidence;
 * missing or unreadable files have no trustworthy digest. Validation stays at
 * the existing strict-validator seam instead of creating a second policy.
 */
export async function readAcceptanceManifestTolerant(
  context: AcceptanceManifestReadContext,
): Promise<AcceptanceManifestReadResult> {
  const path = resolve(context.artifactRoot, 'acceptance-manifest.json');
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) return { status: 'missing-or-invalid', sourceManifestSha256: null };
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) return { status: 'missing-or-invalid', sourceManifestSha256: null };
  const sourceManifestSha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (!value || Array.isArray(value) || value.project !== context.project || value.runId !== context.runId || value.recordVideo !== context.recordVideo || !context.validateTerminalManifest(value) || (value.status === 'completed' && (!(await context.validateChildManifest(value, false)) || !(await proofMatches(context.artifactRoot, value))))) return { status: 'missing-or-invalid', sourceManifestSha256 };
    return { status: 'valid', manifest: value as unknown as AcceptanceManifest, sourceManifestSha256 };
  } catch { return { status: 'missing-or-invalid', sourceManifestSha256 }; }
}

async function proofMatches(root: string, manifest: Record<string, unknown>): Promise<boolean> {
  try { const evidence = manifest.evidence as Record<string, unknown> | undefined, fixture = manifest.fixture as Record<string, unknown> | undefined, proof = await readOcrExecutionProof(root), artifacts = (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).filter((artifact): artifact is Record<string, unknown> => artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact) && (artifact as Record<string, unknown>).path === proof.artifactPath); return !!evidence?.ocrExecutionProof && JSON.stringify(proof) === JSON.stringify(evidence.ocrExecutionProof) && fixture?.sha256 === proof.sourceSha256 && artifacts.length === 1 && artifacts[0].kind === 'log' && artifacts[0].bytes === proof.bytes && artifacts[0].sha256 === proof.sha256; }
  catch { return false; }
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export function createAcceptanceRun(
  environment: NodeJS.ProcessEnv,
  project: string,
  workspaceRoot: string,
): AcceptanceRun {
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error(`Acceptance project name is invalid: ${project}`);
  }
  const runId = environment.E2E_ACCEPTANCE_RUN_ID?.trim();
  if (!runId) {
    throw new Error('E2E_ACCEPTANCE_RUN_ID must be set for acceptance runs.');
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Acceptance run ID is invalid: ${runId}`);
  }
  const recordVideo = parseBoolean(environment.E2E_RECORD_VIDEO, 'E2E_RECORD_VIDEO');
  const projectRoot = resolve(workspaceRoot, 'output', 'playwright', project);
  const artifactRoot = resolve(
    environment.E2E_ARTIFACT_ROOT?.trim() || resolve(projectRoot, runId),
  );
  const relativeArtifactRoot = relative(projectRoot, artifactRoot);
  if (
    relativeArtifactRoot !== runId ||
    relativeArtifactRoot === '..' ||
    relativeArtifactRoot.startsWith(`..${sep}`) ||
    /^[A-Za-z]:/u.test(relativeArtifactRoot)
  ) {
    throw new Error('E2E_ARTIFACT_ROOT must equal output/playwright/<project>/<run-id>.');
  }
  return { project, runId, recordVideo, artifactRoot };
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === '') return false;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be 0, 1, true, or false.`);
}

export async function sha256File(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
}

const OCR_EXECUTION_PROOF_ARTIFACT = 'ocr-device-proof-v1.json' as const;
const OCR_EXECUTION_FAILURE_ARTIFACT = 'ocr-execution-failure-v1.json' as const;
const OCR_EXECUTION_PROOF_SHA = /^[a-f0-9]{64}$/u;
const OCR_FAILURE_MAX_BYTES = 64 * 1024;

/**
 * Read and independently validate the private proof emitted by the runtime.
 * This is intentionally the only acceptance-side projection of that proof:
 * only bounded privacy-safe identity (hashes, profile identity, page scope,
 * and GPU execution counts) crosses this seam. Raw OCR/source content, local
 * paths, tokens, and runtime diagnostics do not.
 */
export async function readOcrExecutionProof(
  artifactRoot: string,
): Promise<AcceptanceOcrExecutionProofSummary> {
  const root = resolve(artifactRoot);
  const rootMetadata = await lstat(root).catch(() => undefined);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('OCR execution proof artifact root must be a regular directory.');
  }
  const proofPath = resolve(root, OCR_EXECUTION_PROOF_ARTIFACT);
  if (relative(root, proofPath).split(sep).join('/') !== OCR_EXECUTION_PROOF_ARTIFACT) {
    throw new Error('OCR execution proof artifact path escaped its root.');
  }
  const metadata = await lstat(proofPath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error('OCR execution proof artifact is missing or not a regular file.');
  }
  const bytes = await readFile(proofPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('OCR execution proof artifact is not valid JSON.', { cause: error });
  }
  const proof = validateOcrExecutionProof(value);
  return {
    artifactPath: OCR_EXECUTION_PROOF_ARTIFACT,
    bytes: bytes.length,
    sha256,
    schemaVersion: '1',
    planSha256: proof.planSha256,
    identitySha256: proof.identitySha256,
    dmlDeviceId: proof.dmlDeviceId,
    dmlNodeCount: proof.dmlNodeCount,
    sessionCount: proof.sessionCount,
    executionSha256: proof.executionSha256,
    sourceSha256: proof.sourceSha256,
    runtimeSha256: proof.runtimeSha256,
    workerSha256: proof.workerSha256,
    modelSha256: proof.modelSha256,
    profileId: proof.profileId,
    profileSpecSha256: proof.profileSpecSha256,
    contractSetSha256: proof.contractSetSha256,
    requestedPageScope: proof.requestedPageScope,
  };
}

/**
 * Read and independently validate the private failure evidence emitted by the
 * runtime.  This is only called for the terminal OCR-worker failure path;
 * setup, UI, and cleanup failures do not claim to have this artifact.
 */
export async function readOcrExecutionFailure(
  artifactRoot: string,
  expected: AcceptanceOcrExecutionFailureExpectation,
): Promise<AcceptanceOcrExecutionFailureSummary> {
  assertValidOcrExecutionFailureExpectation(expected);
  const root = resolve(artifactRoot);
  const rootMetadata = await lstat(root).catch(() => undefined);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('OCR execution failure artifact root must be a regular directory.');
  }
  const failurePath = resolve(root, OCR_EXECUTION_FAILURE_ARTIFACT);
  if (relative(root, failurePath).split(sep).join('/') !== OCR_EXECUTION_FAILURE_ARTIFACT) {
    throw new Error('OCR execution failure artifact path escaped its root.');
  }
  const metadata = await lstat(failurePath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error('OCR execution failure artifact is missing or not a regular file.');
  }
  const bytes = await readFile(failurePath);
  if (bytes.length < 1 || bytes.length > OCR_FAILURE_MAX_BYTES) {
    throw new Error('OCR execution failure artifact size is invalid.');
  }
  const text = bytes.toString('utf8');
  if (/[A-Za-z]:[\\/]|\/(?:Users|private|home|tmp|var|workspace|software-dev)\//iu.test(text)) {
    throw new Error('OCR execution failure artifact contains a private path.');
  }
  if (/\b(?:authorization|bearer|secret|token|password|stderr|ocrtext)\b/iu.test(text)) {
    throw new Error('OCR execution failure artifact contains private diagnostics.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('OCR execution failure artifact is not valid JSON.', { cause: error });
  }
  const failure = validateOcrExecutionFailure(value, expected);
  return {
    artifactPath: OCR_EXECUTION_FAILURE_ARTIFACT,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    schemaVersion: '1',
    sourceSha256: failure.sourceSha256,
    runtimeSha256: failure.runtimeSha256,
    workerSha256: failure.workerSha256,
    sourceRole: failure.sourceRole,
    stageSequence: failure.stageSequence,
    failureClass: failure.failureClass,
    ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
  };
}

interface ValidatedOcrExecutionFailure {
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  readonly workerSha256: string;
  readonly sourceRole: AcceptanceOcrExecutionFailureSummary['sourceRole'];
  readonly stageSequence: readonly string[];
  readonly failureClass: AcceptanceOcrExecutionFailureSummary['failureClass'];
  readonly exitCode?: number;
}

function validateOcrExecutionFailure(
  value: unknown,
  expected: AcceptanceOcrExecutionFailureExpectation,
): ValidatedOcrExecutionFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OCR execution failure artifact must be an object.');
  }
  const record = value as Record<string, unknown>;
  const required = [
    'failureClass',
    'runtimeSha256',
    'schemaVersion',
    'sourceRole',
    'sourceSha256',
    'stageSequence',
    'workerSha256',
  ];
  const optional = ['exitCode', 'ocrProvenance'];
  const keys = Object.keys(record).sort();
  const allowed = [...required, ...optional].sort();
  if (
    keys.length < required.length ||
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw new Error('OCR execution failure artifact fields are invalid.');
  }
  if (record.schemaVersion !== '1') {
    throw new Error('OCR execution failure artifact schema is unsupported.');
  }
  if (typeof record.sourceSha256 !== 'string' || !OCR_EXECUTION_PROOF_SHA.test(record.sourceSha256)) {
    throw new Error('OCR execution failure source identity is invalid.');
  }
  if (record.sourceSha256 !== expected.sourceSha256) {
    throw new Error('OCR execution failure source identity does not match the supplied source.');
  }
  if (record.sourceRole !== 'pdf' && record.sourceRole !== 'image' && record.sourceRole !== 'audio') {
    throw new Error('OCR execution failure source role is invalid.');
  }
  if (record.sourceRole !== expected.sourceRole) {
    throw new Error('OCR execution failure sourceRole does not match the authenticated identity.');
  }
  if (!Array.isArray(record.stageSequence) || record.stageSequence.length > MAX_WORKER_DIAGNOSTIC_STAGES) {
    throw new Error('OCR execution failure stage sequence is invalid.');
  }
  const stageSequence = boundWorkerStageSequence(record.stageSequence.map((stage) => {
    if (
      typeof stage !== 'string' ||
      stage.length < 1 ||
      stage.length > MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH ||
      !isAllowedOcrFailureStage(stage)
    ) {
      throw new Error('OCR execution failure stage sequence is invalid.');
    }
    return stage;
  }));
  const failureClasses = new Set<AcceptanceOcrExecutionFailureSummary['failureClass']>([
    'entry-point-missing',
    'timeout',
    'exit-before-response',
    'no-response',
    'termination',
    'response-error',
    'exit-nonzero',
    'protocol',
    'worker',
    'unavailable',
  ]);
  if (typeof record.failureClass !== 'string' || !failureClasses.has(record.failureClass as AcceptanceOcrExecutionFailureSummary['failureClass'])) {
    throw new Error('OCR execution failure class is invalid.');
  }
  for (const field of ['runtimeSha256', 'workerSha256'] as const) {
    if (typeof record[field] !== 'string' || !OCR_EXECUTION_PROOF_SHA.test(record[field])) {
      throw new Error('OCR execution failure identity is invalid.');
    }
    if (record[field] !== expected[field]) {
      throw new Error(`OCR execution failure ${field} does not match the authenticated identity.`);
    }
  }
  if (record.exitCode !== undefined && (
    !Number.isSafeInteger(record.exitCode) || Number(record.exitCode) < -255 || Number(record.exitCode) > 255
  )) {
    throw new Error('OCR execution failure exit code is invalid.');
  }
  if (record.ocrProvenance !== undefined) validateOcrFailureProvenance(record.ocrProvenance);
  return {
    sourceSha256: record.sourceSha256,
    runtimeSha256: record.runtimeSha256 as string,
    workerSha256: record.workerSha256 as string,
    sourceRole: record.sourceRole,
    stageSequence,
    failureClass: record.failureClass as AcceptanceOcrExecutionFailureSummary['failureClass'],
    ...(record.exitCode === undefined ? {} : { exitCode: Number(record.exitCode) }),
  };
}

function assertValidOcrExecutionFailureExpectation(
  value: unknown,
): asserts value is AcceptanceOcrExecutionFailureExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected OCR failure identity is required.');
  }
  const record = value as Record<string, unknown>;
  const required = ['runtimeSha256', 'sourceRole', 'sourceSha256', 'workerSha256'];
  const keys = Object.keys(record).sort();
  const expectedKeys = required.sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('expected OCR failure identity is required.');
  }
  if (record.sourceRole !== 'pdf' && record.sourceRole !== 'image' && record.sourceRole !== 'audio') {
    throw new Error('expected OCR failure source role is invalid.');
  }
  for (const field of ['sourceSha256', 'runtimeSha256', 'workerSha256'] as const) {
    if (typeof record[field] !== 'string' || !OCR_EXECUTION_PROOF_SHA.test(record[field])) {
      throw new Error('expected OCR failure identity is invalid.');
    }
  }
}

function isAllowedOcrFailureStage(value: string): boolean {
  return isAllowedWorkerStage(value);
}

function validateOcrFailureProvenance(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OCR execution failure provenance is invalid.');
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const expected = status === 'resolved'
    ? ['device', 'engine', 'model', 'modelDigest', 'profileId', 'profileSpecSha256', 'status']
    : status === 'unavailable'
      ? ['profileId', 'profileSpecSha256', 'reason', 'status']
      : [];
  const keys = Object.keys(record).sort();
  if (expected.length === 0 || keys.some((key, index) => key !== expected[index]) || keys.length !== expected.length) {
    throw new Error('OCR execution failure provenance is invalid.');
  }
  for (const field of ['engine', 'model', 'device', 'profileId', 'reason'] as const) {
    if (record[field] !== undefined && (
      typeof record[field] !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/u.test(record[field])
    )) {
      throw new Error('OCR execution failure provenance is invalid.');
    }
  }
  if (
    (typeof record.modelDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(record.modelDigest)) ||
    (typeof record.profileSpecSha256 !== 'string' || !OCR_EXECUTION_PROOF_SHA.test(record.profileSpecSha256))
  ) {
    throw new Error('OCR execution failure provenance is invalid.');
  }
}

interface ValidatedOcrExecutionProof {
  readonly planSha256: string;
  readonly identitySha256: string;
  readonly dmlDeviceId: number;
  readonly dmlNodeCount: number;
  readonly sessionCount: number;
  readonly executionSha256: string;
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  readonly workerSha256: string;
  readonly modelSha256: string;
  readonly profileId: string;
  readonly profileSpecSha256: string;
  readonly contractSetSha256: string;
  readonly requestedPageScope: readonly number[] | null;
}

function validateOcrExecutionProof(value: unknown): ValidatedOcrExecutionProof {
  const proof = requireRecord(value, [
    'schemaVersion',
    'selectionProof',
    'pipelineConstruction',
    'sessionDeviceProofs',
    'sourceSha256',
    'requestedPageScope',
    'dmlNodeCount',
    'runtimeSha256',
    'workerSha256',
    'modelSha256',
    'profileId',
    'profileSpecSha256',
    'contractSetSha256',
    'executionSha256',
  ], 'OCR execution proof');
  if (proof.schemaVersion !== '1') throw new Error('OCR execution proof schema is unsupported.');
  const selection = requireRecord(proof.selectionProof, [
    'identity',
    'highPerformanceRank',
    'dmlDeviceId',
    'adapterMapSha256',
    'planSha256',
  ], 'OCR selection proof');
  const identity = requireRecord(selection.identity, [
    'adapterClass',
    'adapterLuid',
    'vendorId',
    'deviceId',
    'subsystemId',
    'revision',
    'description',
    'identitySha256',
  ], 'OCR selection identity');
  if (identity.adapterClass !== 'dedicated' && identity.adapterClass !== 'integrated') {
    throw new Error('OCR selection identity class is invalid.');
  }
  requireHex(identity.adapterLuid, 16, 'OCR selection LUID');
  requireHex(identity.vendorId, 4, 'OCR selection vendor ID');
  requireHex(identity.deviceId, 4, 'OCR selection device ID');
  requireHex(identity.subsystemId, 8, 'OCR selection subsystem ID');
  requireHex(identity.revision, 2, 'OCR selection revision');
  requireSafeLabel(identity.description, 'OCR selection description', 128);
  const identitySha256 = requireSha(identity.identitySha256, 'OCR identity digest');
  if (sha256Canonical({
    adapterClass: identity.adapterClass,
    adapterLuid: identity.adapterLuid,
    vendorId: identity.vendorId,
    deviceId: identity.deviceId,
    subsystemId: identity.subsystemId,
    revision: identity.revision,
    description: identity.description,
  }) !== identitySha256) {
    throw new Error('OCR identity digest is invalid.');
  }
  const dmlDeviceId = requireNonNegativeInteger(selection.dmlDeviceId, 'OCR DML device ID');
  requireNonNegativeInteger(selection.highPerformanceRank, 'OCR GPU rank');
  requireSha(selection.adapterMapSha256, 'OCR adapter map digest');
  const planSha256 = requireSha(selection.planSha256, 'OCR plan digest');
  const construction = requireRecord(proof.pipelineConstruction, ['pre', 'post'], 'OCR pipeline construction');
  for (const name of ['pre', 'post']) {
    const side = requireRecord(construction[name], ['adapterLuid', 'adapterMapSha256', 'factoryCurrent'], `OCR ${name} construction`);
    requireHex(side.adapterLuid, 16, `OCR ${name} construction LUID`);
    requireSha(side.adapterMapSha256, `OCR ${name} construction map digest`);
    if (side.factoryCurrent !== true) throw new Error('OCR pipeline construction factory is not current.');
  }
  const pre = construction.pre as Record<string, unknown>;
  const post = construction.post as Record<string, unknown>;
  if (pre.adapterLuid !== post.adapterLuid || pre.adapterLuid !== identity.adapterLuid || pre.adapterMapSha256 !== post.adapterMapSha256 || pre.adapterMapSha256 !== selection.adapterMapSha256) {
    throw new Error('OCR pipeline construction drifted from selection.');
  }
  const rawSessions = proof.sessionDeviceProofs;
  if (!Array.isArray(rawSessions) || rawSessions.length < 1 || rawSessions.length > 500) {
    throw new Error('OCR execution proof session evidence is invalid.');
  }
  let dmlNodeCount = 0;
  rawSessions.forEach((rawSession, index) => {
    const session = requireRecord(rawSession, [
      'sessionIndex',
      'providerOrder',
      'dmlDeviceId',
      'fallbackDisabled',
      'dmlNodeCount',
      'cpuNodeCount',
      'evidenceSource',
    ], 'OCR session evidence');
    if (session.sessionIndex !== index || JSON.stringify(session.providerOrder) !== JSON.stringify(['DmlExecutionProvider', 'CPUExecutionProvider'])) {
      throw new Error('OCR session provider order is invalid.');
    }
    if (
      (session.dmlDeviceId !== null && session.dmlDeviceId !== dmlDeviceId)
      || session.fallbackDisabled !== true
    ) {
      throw new Error('OCR session device or fallback evidence drifted.');
    }
    const dmlNodes = requirePositiveInteger(session.dmlNodeCount, 'OCR session DML node count');
    requireNonNegativeInteger(session.cpuNodeCount, 'OCR session CPU node count');
    if (session.evidenceSource !== 'ort-graph-assignment' && session.evidenceSource !== 'ort-profile') {
      throw new Error('OCR session evidence source is invalid.');
    }
    dmlNodeCount += dmlNodes;
  });
  if (proof.dmlNodeCount !== dmlNodeCount) throw new Error('OCR aggregate DML node count is invalid.');
  const aggregateDmlNodeCount = requirePositiveInteger(proof.dmlNodeCount, 'OCR DML node count');
  const sourceSha256 = requireSha(proof.sourceSha256, 'OCR source digest');
  let requestedPageScope: readonly number[] | null = null;
  if (proof.requestedPageScope !== null) {
    if (!Array.isArray(proof.requestedPageScope) || proof.requestedPageScope.length < 1 || proof.requestedPageScope.length > 500 || proof.requestedPageScope.some((page, index) => page !== index + 1)) {
      throw new Error('OCR requested page scope is invalid.');
    }
    requestedPageScope = proof.requestedPageScope.map((page) => Number(page));
  }
  const runtimeSha256 = requireSha(proof.runtimeSha256, 'OCR runtime digest');
  const workerSha256 = requireSha(proof.workerSha256, 'OCR worker digest');
  const modelSha256 = requireSha(proof.modelSha256, 'OCR model digest');
  const profileId = requireSafeLabel(proof.profileId, 'OCR profile identity', 128);
  const profileSpecSha256 = requireSha(proof.profileSpecSha256, 'OCR profile digest');
  const contractSetSha256 = requireSha(proof.contractSetSha256, 'OCR contract digest');
  const executionSha256 = requireSha(proof.executionSha256, 'OCR execution digest');
  const { executionSha256: _ignored, ...withoutDigest } = proof;
  if (sha256Canonical(withoutDigest) !== executionSha256) throw new Error('OCR execution proof digest is invalid.');
  return {
    planSha256,
    identitySha256,
    dmlDeviceId,
    dmlNodeCount: aggregateDmlNodeCount,
    sessionCount: rawSessions.length,
    executionSha256,
    sourceSha256,
    runtimeSha256,
    workerSha256,
    modelSha256,
    profileId,
    profileSpecSha256,
    contractSetSha256,
    requestedPageScope,
  };
}

function requireRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is invalid.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${field} contains unsupported fields.`);
  return record;
}

function requireSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OCR_EXECUTION_PROOF_SHA.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function requireHex(value: unknown, width: number, field: string): string {
  if (typeof value !== 'string' || new RegExp(`^[a-f0-9]{${width}}$`, 'u').test(value) === false) throw new Error(`${field} is invalid.`);
  return value;
}

function requireSafeLabel(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\\/]/u.test(value) || [...value].some((character) => character < ' ' || character === '\u007f')) throw new Error(`${field} is invalid.`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} is invalid.`);
  return Number(value);
}

function requirePositiveInteger(value: unknown, field: string): number {
  const result = requireNonNegativeInteger(value, field);
  if (result < 1) throw new Error(`${field} must be positive.`);
  return result;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

export async function assertWebmArtifact(filePath: string): Promise<true> {
  const metadata = await stat(filePath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`Acceptance recording must be a non-empty WebM: ${redactAcceptanceText(filePath)}`);
  }
  const header = (await readFile(filePath)).subarray(0, 4);
  if (!header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    throw new Error(`Acceptance recording is not an EBML/WebM file: ${redactAcceptanceText(filePath)}`);
  }
  return true;
}

export async function writeAcceptanceManifest(
  artifactRoot: string,
  input: AcceptanceManifestInput,
): Promise<string> {
  await mkdir(artifactRoot, { recursive: true });
  const artifacts: AcceptanceArtifact[] = [];
  let proofArtifactSummary: AcceptanceOcrExecutionProofSummary | undefined;
  let failureArtifactSummary: AcceptanceOcrExecutionFailureSummary | undefined;
  for (const artifact of input.artifacts) {
    const absolutePath = resolve(artifact.path);
    const relativePath = relative(resolve(artifactRoot), absolutePath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === '..' || /^[A-Za-z]:/u.test(relativePath)) {
      throw new Error(`Acceptance artifact must stay inside its artifact root: ${redactAcceptanceText(artifact.path)}`);
    }
    // The runtime sink publishes this proof with its canonical bytes and a
    // no-overwrite atomic link.  Reformatting it here would invalidate the
    // sink's bytes/SHA binding, so validate and preserve this one immutable
    // private artifact instead of applying diagnostic redaction.
    if (relativePath.split(sep).join('/') === OCR_EXECUTION_PROOF_ARTIFACT) {
      const summary = await readOcrExecutionProof(artifactRoot);
      if (proofArtifactSummary && JSON.stringify(proofArtifactSummary) !== JSON.stringify(summary)) {
        throw new Error('Acceptance OCR execution proof artifact was listed more than once.');
      }
      proofArtifactSummary = summary;
    } else if (relativePath.split(sep).join('/') === OCR_EXECUTION_FAILURE_ARTIFACT) {
      const summary = input.verifiedOcrExecutionFailure;
      if (!summary) {
        throw new Error('Acceptance OCR execution failure requires a smoke-verified summary.');
      }
      if (summary.artifactPath !== OCR_EXECUTION_FAILURE_ARTIFACT) {
        throw new Error('Acceptance OCR execution failure summary artifact is invalid.');
      }
      if (failureArtifactSummary && JSON.stringify(failureArtifactSummary) !== JSON.stringify(summary)) {
        throw new Error('Acceptance OCR execution failure artifact was listed more than once.');
      }
      failureArtifactSummary = summary;
    } else {
      await sanitizeTextArtifact(absolutePath);
    }
    let metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata?.isFile()) {
      throw new Error(`Acceptance artifact is missing: ${redactAcceptanceText(artifact.path)}`);
    }
    if (artifact.kind === 'trace' || artifact.kind === 'report') {
      sanitizeAcceptanceArchive(absolutePath);
      metadata = await stat(absolutePath);
    }
    const actualBytes = metadata.size;
    const actualSha256 = await sha256File(absolutePath);
    if (artifact.expectedIdentity !== undefined && (
      !Number.isSafeInteger(artifact.expectedIdentity.bytes) ||
      artifact.expectedIdentity.bytes <= 0 ||
      !OCR_EXECUTION_PROOF_SHA.test(artifact.expectedIdentity.sha256) ||
      artifact.expectedIdentity.bytes !== actualBytes ||
      artifact.expectedIdentity.sha256 !== actualSha256
    )) {
      throw new Error(`Acceptance artifact changed after producer identity verification: ${redactAcceptanceText(artifact.path)}`);
    }
    artifacts.push({
      path: relativePath.split(sep).join('/'),
      kind: artifact.kind,
      bytes: actualBytes,
      sha256: actualSha256,
    });
    if (relativePath.split(sep).join('/') === OCR_EXECUTION_FAILURE_ARTIFACT) {
      const verified = input.verifiedOcrExecutionFailure;
      const artifact = artifacts[artifacts.length - 1];
      if (!verified || artifact.bytes !== verified.bytes || artifact.sha256 !== verified.sha256) {
        throw new Error('Acceptance OCR execution failure artifact changed after smoke verification.');
      }
    }
  }
  const evidence = sanitizeAcceptanceEvidence(input.evidence);
  if (input.evidence && Object.prototype.hasOwnProperty.call(input.evidence, 'ocrExecutionProof') && !evidence?.ocrExecutionProof) {
    throw new Error('Acceptance OCR execution proof evidence is invalid.');
  }
  if (evidence?.ocrExecutionProof) {
    const proofArtifact = artifacts.find((artifact) => artifact.path === OCR_EXECUTION_PROOF_ARTIFACT);
    if (
      !proofArtifact
      || !proofArtifactSummary
      || JSON.stringify(proofArtifactSummary) !== JSON.stringify(evidence.ocrExecutionProof)
      || proofArtifact.bytes !== evidence.ocrExecutionProof.bytes
      || proofArtifact.sha256 !== evidence.ocrExecutionProof.sha256
    ) {
      throw new Error('Acceptance OCR execution proof evidence is not bound to its artifact.');
    }
  }
  if (input.evidence && Object.prototype.hasOwnProperty.call(input.evidence, 'ocrExecutionFailure') && !evidence?.ocrExecutionFailure) {
    throw new Error('Acceptance OCR execution failure evidence is invalid.');
  }
  if (failureArtifactSummary && !evidence?.ocrExecutionFailure) {
    throw new Error('Acceptance OCR execution failure evidence must include its verified summary.');
  }
  if (evidence?.ocrExecutionFailure) {
    const failureArtifact = artifacts.find((artifact) => artifact.path === OCR_EXECUTION_FAILURE_ARTIFACT);
    if (
      !failureArtifact
      || !failureArtifactSummary
      || JSON.stringify(failureArtifactSummary) !== JSON.stringify(evidence.ocrExecutionFailure)
      || failureArtifact.bytes !== evidence.ocrExecutionFailure.bytes
      || failureArtifact.sha256 !== evidence.ocrExecutionFailure.sha256
    ) {
      throw new Error('Acceptance OCR execution failure evidence is not bound to its artifact.');
    }
  }
  const manifest: AcceptanceManifest = {
    schemaVersion: 2,
    project: input.project,
    runId: input.runId,
    status: input.status,
    recordVideo: input.recordVideo,
    artifacts,
    errors: (input.errors ?? []).map((error) => sanitizeAcceptanceDiagnostic(error, 'acceptance')),
    consoleErrors: (input.consoleErrors ?? []).map(() => 'browser_console_error'),
    pageErrors: (input.pageErrors ?? []).map(() => 'browser_page_error'),
    cleanup: input.cleanup,
    fixture: input.fixture && /^[a-f0-9]{64}$/u.test(input.fixture.sha256)
      ? {
          name: sanitizeFixtureName(input.fixture.name),
          sha256: input.fixture.sha256,
        }
      : undefined,
    evidence,
  };
  const manifestPath = resolve(artifactRoot, 'acceptance-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

async function sanitizeTextArtifact(filePath: string): Promise<void> {
  if (!/\.(?:html|json|jsonl|log|md|txt)$/iu.test(filePath)) return;
  const value = await readFile(filePath, 'utf8');
  if (filePath.toLowerCase().endsWith('.json')) {
    try {
      await writeFile(
        filePath,
        `${JSON.stringify(redactStructuredValue(JSON.parse(value)), null, 2)}\n`,
        'utf8',
      );
      return;
    } catch {
      // Fall through to text redaction for malformed diagnostic output.
    }
  }
  if (filePath.toLowerCase().endsWith('.jsonl')) {
    const lines = value.split(/\r?\n/u).map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactStructuredValue(JSON.parse(line)));
      } catch {
        return redactAcceptanceText(line);
      }
    });
    await writeFile(filePath, lines.join('\n'), 'utf8');
    return;
  }
  await writeFile(filePath, redactAcceptanceText(value), 'utf8');
}

function redactStructuredValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return '<redacted>';
  if (typeof value === 'string') return redactAcceptanceText(value);
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactStructuredValue(nested, key),
      ]),
    );
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|token|secret|password|api[_-]?key|private[_-]?key)/iu.test(key);
}

function sanitizeAcceptanceArchive(filePath: string): void {
  if (!filePath.toLowerCase().endsWith('.zip')) return;
  const script = String.raw`
import os
import json
import re
import sys
import tempfile
import time
import zipfile

path = sys.argv[1]
bearer = re.compile(r'''Bearer\s+("[^"]*"|'[^']*'|[^\s,;}\]"']+)''', re.IGNORECASE)
credential = re.compile(r'''((?:"?(?:authorization|token|secret|password)"?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;}"'\]]+)''', re.IGNORECASE)
windows_path = re.compile(r'''[A-Za-z]:[\\/][^"'<>\r\n]+''')
unix_path = re.compile(r'''/(?:Users|private|home|tmp|var|workspace|software-dev)/[^"'<>\r\n]+''', re.IGNORECASE)

def redacted_value(value):
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        return value[0] + '<redacted>' + value[0]
    return '<redacted>'

def redact(value):
    value = bearer.sub(lambda match: 'Bearer ' + redacted_value(match.group(1)), value)
    value = credential.sub(lambda match: match.group(1) + redacted_value(match.group(2)), value)
    value = windows_path.sub('<private-path>', value)
    return unix_path.sub('<private-path>', value)

def sensitive_key(key):
    return re.search(r'(?:authorization|token|secret|password|api[_-]?key|private[_-]?key)', key, re.IGNORECASE) is not None

def redact_object(value, key=None):
    if key is not None and sensitive_key(key):
        return '<redacted>'
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_object(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_object(item, key) for key, item in value.items()}
    return value

def scrub(payload, name):
    try:
        text = payload.decode('utf-8')
    except UnicodeDecodeError:
        return payload
    try:
        return json.dumps(redact_object(json.loads(text)), ensure_ascii=False, indent=2).encode('utf-8')
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    if name.lower().endswith(('.jsonl', '.ndjson')):
        lines = []
        parsed_any = False
        for line in text.splitlines(keepends=True):
            if not line.strip():
                lines.append(line)
                continue
            try:
                lines.append(json.dumps(redact_object(json.loads(line)), ensure_ascii=False) + ('\n' if line.endswith('\n') else ''))
                parsed_any = True
            except (TypeError, ValueError, json.JSONDecodeError):
                lines.append(redact(line))
        if parsed_any:
            return ''.join(lines).encode('utf-8')
    return redact(text).encode('utf-8')

with zipfile.ZipFile(path, 'r') as source:
    entries = [(info, scrub(source.read(info), info.filename)) for info in source.infolist()]
fd, temporary = tempfile.mkstemp(prefix='acceptance-redacted-', suffix='.zip', dir=os.path.dirname(path))
os.close(fd)
try:
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for info, payload in entries:
            target.writestr(info, payload)
    for attempt in range(10):
        try:
            os.replace(temporary, path)
            break
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.25)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
`;
  const commands: readonly [string, readonly string[]][] = process.platform === 'win32'
    ? [['py', ['-3', '-c', script, filePath]], ['python', ['-c', script, filePath]]]
    : [['python3', ['-c', script, filePath]], ['python', ['-c', script, filePath]]];
  const diagnostics: string[] = [];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return;
    diagnostics.push(`${command}: ${String(result.stderr || '').trim()}`);
  }
  throw new Error(`Acceptance ZIP artifact could not be sanitized: ${redactAcceptanceText(filePath)} (${redactAcceptanceText(diagnostics.join(' | ')).slice(0, 240)})`);
}

export async function collectAcceptanceArtifactInputs(
  artifactRoot: string,
): Promise<AcceptanceArtifactInput[]> {
  const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(() => []);
  const artifacts: AcceptanceArtifactInput[] = [];
  for (const entry of entries) {
    if (entry.name === 'acceptance-manifest.json') continue;
    const path = resolve(artifactRoot, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...await collectAcceptanceArtifactInputs(path));
    } else if (entry.isFile()) {
      artifacts.push({ path, kind: acceptanceArtifactKind(path) });
    }
  }
  return artifacts;
}

function acceptanceArtifactKind(path: string): AcceptanceArtifactInput['kind'] {
  if (path.endsWith('.webm')) return 'video';
  if (path.endsWith('.png')) return 'screenshot';
  if (path.endsWith('.zip')) return 'trace';
  if (path.endsWith('.html') || path.endsWith('.md')) return 'report';
  if (path.endsWith('.log') || path.endsWith('.json') || path.endsWith('.jsonl')) return 'log';
  return 'other';
}

export function redactAcceptanceText(value: string): string {
  return value
    .replace(
      /Bearer\s+("[^"]*"|'[^']*'|[^\s,;}\]"']+)/giu,
      (_match: string, secret: string) => `Bearer ${redactDelimitedValue(secret)}`,
    )
    .replace(
      /((?:"?(?:authorization|token|secret|password)"?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;}"'\]]+)/giu,
      (_match: string, prefix: string, secret: string) => `${prefix}${redactDelimitedValue(secret)}`,
    )
    .replace(/[A-Za-z]:[\\/][^"'<>\r\n]+/gu, '<private-path>')
    .replace(/\/(?:Users|private|home|tmp|var|workspace|software-dev)\/[^"'<>\r\n]+/giu, '<private-path>');
}

/**
 * Acceptance diagnostics are an evidence boundary, not a debugging console.
 * Keep only a stable category so thrown errors cannot smuggle OCR/truth,
 * credentials, command lines, or local paths into a manifest.
 */
export function sanitizeAcceptanceDiagnostic(
  value: unknown,
  fallback: 'acceptance' | 'cleanup' = 'acceptance',
): string {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  // Playwright's screenshot diagnostics include the acceptance spec's
  // `real-desktop-ocr` path.  Classify an explicit visual checkpoint failure
  // before inspecting that path, otherwise a golden mismatch is mislabeled as
  // an OCR semantic failure.
  if (
    normalized.includes('tohavescreenshot') ||
    normalized.includes('snapshot') ||
    normalized.includes('pixels (ratio')
  ) {
    return 'browser_acceptance_failed';
  }
  if (normalized.includes('ocr_worker_failed')) {
    return 'ocr_worker_failed';
  }
  if (normalized.includes('ocr') || normalized.includes('anchor')) {
    return 'ocr_verification_failed';
  }
  if (normalized.includes('cleanup') || normalized.includes('residue') || normalized.includes('process')) {
    return 'cleanup_verification_failed';
  }
  if (normalized.includes('runtime') || normalized.includes('worker')) {
    return 'runtime_acceptance_failed';
  }
  if (normalized.includes('playwright') || normalized.includes('browser')) {
    return 'browser_acceptance_failed';
  }
  return fallback === 'cleanup' ? 'cleanup_verification_failed' : 'acceptance_failed';
}

export function sanitizeAcceptanceEvidence(value: unknown): AcceptanceEvidenceSummary | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const evidence: AcceptanceEvidenceSummary = {};
  const mutable = evidence as {
    acceptanceMode?: AcceptanceEvidenceSummary['acceptanceMode'];
    ocrProofSucceeded?: boolean;
    structuringSucceeded?: boolean;
    releaseGateSatisfied?: boolean;
    sourceSha256?: string;
    importedSourceSha256?: string;
    runtimeArtifactSha256?: string;
    contractSetSha256?: string;
    workerArchiveSha256?: string;
    workerExecutableSha256?: string;
    candidateId?: string;
    catalogSha256?: string;
    modelManifestSha256?: string;
    sourceLockSha256?: string;
    modelFileCount?: number;
    modelExtractedBytes?: number;
    authenticatedRuntimePreflight?: 'gpu-dml' | 'cpu-fallback';
    uiGpuBeforeImport?: boolean;
    cer?: number | null;
    expectedAnchorCount?: number;
    matchedAnchorCount?: number;
    pdfPageScope?: AcceptanceEvidenceSummary['pdfPageScope'];
    provenance?: AcceptanceEvidenceSummary['provenance'];
    ocrExecutionProof?: AcceptanceOcrExecutionProofSummary;
    ocrExecutionFailure?: AcceptanceOcrExecutionFailureSummary;
  };
  if (record.acceptanceMode === 'ocr-only' || record.acceptanceMode === 'structuring') {
    mutable.acceptanceMode = record.acceptanceMode;
  }
  for (const key of ['ocrProofSucceeded', 'structuringSucceeded', 'releaseGateSatisfied'] as const) {
    if (typeof record[key] === 'boolean') mutable[key] = record[key];
  }
  if (typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.sourceSha256)) {
    mutable.sourceSha256 = record.sourceSha256;
  }
  if (typeof record.importedSourceSha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.importedSourceSha256)) {
    mutable.importedSourceSha256 = record.importedSourceSha256;
  }
  for (const key of [
    'runtimeArtifactSha256',
    'contractSetSha256',
    'workerArchiveSha256',
    'workerExecutableSha256',
  ] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string' && /^[a-f0-9]{64}$/u.test(candidate)) {
      mutable[key] = candidate;
    }
  }
  for (const key of [
    'candidateId',
    'catalogSha256',
    'modelManifestSha256',
    'sourceLockSha256',
  ] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string' && /^[a-f0-9]{64}$/u.test(candidate)) {
      mutable[key] = candidate;
    }
  }
  if (isSafeEvidenceCount(record.modelFileCount)) mutable.modelFileCount = record.modelFileCount;
  if (isSafeEvidenceCount(record.modelExtractedBytes)) mutable.modelExtractedBytes = record.modelExtractedBytes;
  if (
    record.authenticatedRuntimePreflight === 'gpu-dml' ||
    record.authenticatedRuntimePreflight === 'cpu-fallback'
  ) {
    mutable.authenticatedRuntimePreflight = record.authenticatedRuntimePreflight;
  }
  if (typeof record.uiGpuBeforeImport === 'boolean') {
    mutable.uiGpuBeforeImport = record.uiGpuBeforeImport;
  }
  if (record.cer === null || (typeof record.cer === 'number' && Number.isFinite(record.cer) && record.cer >= 0 && record.cer <= 1)) {
    mutable.cer = record.cer as number | null;
  }
  if (isSafeEvidenceCount(record.expectedAnchorCount)) mutable.expectedAnchorCount = record.expectedAnchorCount;
  if (isSafeEvidenceCount(record.matchedAnchorCount)) mutable.matchedAnchorCount = record.matchedAnchorCount;
  const pdfPageScope = sanitizePdfPageScope(record.pdfPageScope);
  if (pdfPageScope) mutable.pdfPageScope = pdfPageScope;
  if (record.provenance && typeof record.provenance === 'object' && !Array.isArray(record.provenance)) {
    const source = record.provenance as Record<string, unknown>;
    const provenance: NonNullable<AcceptanceEvidenceSummary['provenance']> = {};
    const mutableProvenance = provenance as Record<string, string>;
    for (const key of ['ocrEngine', 'ocrModel', 'ocrDevice', 'structuringEngine', 'structuringModel']) {
      const candidate = source[key];
      if (typeof candidate === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(candidate)) {
        mutableProvenance[key] = candidate;
      }
    }
    if (Object.keys(provenance).length > 0) mutable.provenance = provenance;
  }
  const ocrExecutionProof = sanitizeOcrExecutionProofSummary(record.ocrExecutionProof);
  if (ocrExecutionProof) mutable.ocrExecutionProof = ocrExecutionProof;
  const ocrExecutionFailure = sanitizeOcrExecutionFailureSummary(record.ocrExecutionFailure);
  if (ocrExecutionFailure) mutable.ocrExecutionFailure = ocrExecutionFailure;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function sanitizeOcrExecutionFailureSummary(
  value: unknown,
): AcceptanceOcrExecutionFailureSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const expected = [
    'artifactPath',
    'bytes',
    'failureClass',
    'schemaVersion',
    'sha256',
    'sourceRole',
    'sourceSha256',
    'stageSequence',
    'runtimeSha256',
    'workerSha256',
    ...(record.exitCode === undefined ? [] : ['exitCode']),
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return undefined;
  if (
    record.artifactPath !== OCR_EXECUTION_FAILURE_ARTIFACT ||
    record.schemaVersion !== '1' ||
    !Number.isSafeInteger(record.bytes) ||
    Number(record.bytes) <= 0 ||
    Number(record.bytes) > OCR_FAILURE_MAX_BYTES ||
    typeof record.sha256 !== 'string' ||
    !OCR_EXECUTION_PROOF_SHA.test(record.sha256) ||
    typeof record.sourceSha256 !== 'string' ||
    !OCR_EXECUTION_PROOF_SHA.test(record.sourceSha256) ||
    typeof record.runtimeSha256 !== 'string' ||
    !OCR_EXECUTION_PROOF_SHA.test(record.runtimeSha256) ||
    typeof record.workerSha256 !== 'string' ||
    !OCR_EXECUTION_PROOF_SHA.test(record.workerSha256) ||
    (record.sourceRole !== 'pdf' && record.sourceRole !== 'image' && record.sourceRole !== 'audio') ||
    !Array.isArray(record.stageSequence) ||
    record.stageSequence.length > MAX_WORKER_DIAGNOSTIC_STAGES ||
    record.stageSequence.some((stage) => typeof stage !== 'string' || !isAllowedOcrFailureStage(stage)) ||
    typeof record.failureClass !== 'string' ||
    !new Set([
      'entry-point-missing',
      'timeout',
      'exit-before-response',
      'no-response',
      'termination',
      'response-error',
      'exit-nonzero',
      'protocol',
      'worker',
      'unavailable',
    ]).has(record.failureClass) ||
    (record.exitCode !== undefined && (
      !Number.isSafeInteger(record.exitCode) || Number(record.exitCode) < -255 || Number(record.exitCode) > 255
    ))
  ) return undefined;
  return {
    artifactPath: OCR_EXECUTION_FAILURE_ARTIFACT,
    bytes: Number(record.bytes),
    sha256: record.sha256,
    schemaVersion: '1',
    sourceSha256: record.sourceSha256,
    runtimeSha256: record.runtimeSha256,
    workerSha256: record.workerSha256,
    sourceRole: record.sourceRole,
    stageSequence: record.stageSequence,
    failureClass: record.failureClass as AcceptanceOcrExecutionFailureSummary['failureClass'],
    ...(record.exitCode === undefined ? {} : { exitCode: Number(record.exitCode) }),
  };
}

function sanitizeOcrExecutionProofSummary(
  value: unknown,
): AcceptanceOcrExecutionProofSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const expected = [
    'artifactPath',
    'bytes',
    'sha256',
    'schemaVersion',
    'planSha256',
    'identitySha256',
    'dmlDeviceId',
    'dmlNodeCount',
    'sessionCount',
    'executionSha256',
    'sourceSha256',
    'runtimeSha256',
    'workerSha256',
    'modelSha256',
    'profileId',
    'profileSpecSha256',
    'contractSetSha256',
    'requestedPageScope',
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return undefined;
  const requestedPageScope = record.requestedPageScope;
  const validatedPageScope = requestedPageScope === null ? null : requestedPageScope as number[];
  if (
    record.artifactPath !== OCR_EXECUTION_PROOF_ARTIFACT
    || record.schemaVersion !== '1'
    || !Number.isSafeInteger(record.bytes)
    || Number(record.bytes) <= 0
    || !OCR_EXECUTION_PROOF_SHA.test(String(record.sha256))
    || !OCR_EXECUTION_PROOF_SHA.test(String(record.planSha256))
    || !OCR_EXECUTION_PROOF_SHA.test(String(record.identitySha256))
    || !OCR_EXECUTION_PROOF_SHA.test(String(record.executionSha256))
    || typeof record.sourceSha256 !== 'string'
    || !OCR_EXECUTION_PROOF_SHA.test(record.sourceSha256)
    || typeof record.runtimeSha256 !== 'string'
    || !OCR_EXECUTION_PROOF_SHA.test(record.runtimeSha256)
    || typeof record.workerSha256 !== 'string'
    || !OCR_EXECUTION_PROOF_SHA.test(record.workerSha256)
    || typeof record.modelSha256 !== 'string'
    || !OCR_EXECUTION_PROOF_SHA.test(record.modelSha256)
    || typeof record.profileId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(record.profileId)
    || typeof record.profileSpecSha256 !== 'string'
    || !OCR_EXECUTION_PROOF_SHA.test(record.profileSpecSha256)
    || typeof record.contractSetSha256 !== 'string'
    || !OCR_EXECUTION_PROOF_SHA.test(record.contractSetSha256)
    || (requestedPageScope !== null && (
      !isPageNumberList(requestedPageScope)
      || requestedPageScope.some((page, index) => page !== index + 1)
    ))
    || !Number.isSafeInteger(record.dmlDeviceId)
    || Number(record.dmlDeviceId) < 0
    || !Number.isSafeInteger(record.dmlNodeCount)
    || Number(record.dmlNodeCount) < 1
    || !Number.isSafeInteger(record.sessionCount)
    || Number(record.sessionCount) < 1
  ) return undefined;
  return {
    artifactPath: OCR_EXECUTION_PROOF_ARTIFACT,
    bytes: Number(record.bytes),
    sha256: String(record.sha256),
    schemaVersion: '1',
    planSha256: String(record.planSha256),
    identitySha256: String(record.identitySha256),
    dmlDeviceId: Number(record.dmlDeviceId),
    dmlNodeCount: Number(record.dmlNodeCount),
    sessionCount: Number(record.sessionCount),
    executionSha256: String(record.executionSha256),
    sourceSha256: record.sourceSha256,
    runtimeSha256: record.runtimeSha256,
    workerSha256: record.workerSha256,
    modelSha256: record.modelSha256,
    profileId: record.profileId,
    profileSpecSha256: record.profileSpecSha256,
    contractSetSha256: record.contractSetSha256,
    requestedPageScope: validatedPageScope === null ? null : [...validatedPageScope],
  };
}

function isSafeEvidenceCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sanitizePdfPageScope(
  value: unknown,
): AcceptanceEvidenceSummary['pdfPageScope'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sourcePageCountValue = record.sourcePageCount;
  const requested = record.requestedPageNumbers;
  const processed = record.processedPageNumbers;
  if (
    !Number.isSafeInteger(sourcePageCountValue)
    || Number(sourcePageCountValue) < 1
    || Number(sourcePageCountValue) > 500
    || !isPageNumberList(requested)
    || !isPageNumberList(processed)
  ) {
    return undefined;
  }
  const sourcePageCount = Number(sourcePageCountValue);
  const expected = requested.map((_, index) => index + 1);
  if (
    requested.some((page, index) => page !== expected[index])
    || requested.at(-1)! > sourcePageCount
    || processed.length !== requested.length
    || processed.some((page, index) => page !== requested[index])
  ) {
    return undefined;
  }
  return {
    sourcePageCount,
    requestedPageNumbers: [...requested],
    processedPageNumbers: [...processed],
  };
}

function isPageNumberList(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 500
    && value.every((page) => Number.isSafeInteger(page) && Number(page) >= 1 && Number(page) <= 500);
}

function sanitizeFixtureName(value: string): string {
  const extension = value.match(/\.(pdf|jpe?g|png|webp|wav|mp3|m4a|flac|ogg)$/iu)?.[1].toLowerCase();
  return extension ? `fixture.${extension}` : 'fixture';
}

function redactDelimitedValue(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote
    ? `${quote}<redacted>${quote}`
    : '<redacted>';
}
