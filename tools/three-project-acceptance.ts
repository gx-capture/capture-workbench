import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { spawnSync as spawnSyncProcess } from 'node:child_process';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';

import {
  sanitizeAcceptanceEvidence,
  type AcceptanceCleanup,
  type AcceptanceEvidenceSummary,
} from './acceptance-contract.ts';
import {
  resolveWindowsBuiltInPowerShell,
  type WindowsBuiltInProcessFileAdapter,
} from './windows-built-in-process-resolver.ts';

export interface AcceptanceProjectPlan {
  readonly project: 'capture-workbench' | 'cert-prep' | 'law-prep';
  readonly cwd: string;
  readonly target: string;
  readonly artifactRoot: string;
  readonly scopePath: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type CaptureWorkbenchAcceptancePlan = Omit<
  AcceptanceProjectPlan,
  'project'
> & {
  readonly project: 'capture-workbench';
};

const LOCAL_MODEL_ENVIRONMENT_KEYS = [
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY',
] as const;

const CAPTURE_ONLY_REQUIRED_ENVIRONMENT_KEYS = [
  'CAPTURE_REAL_DESKTOP_OCR_INPUT',
  'CAPTURE_REAL_DESKTOP_EXECUTABLE',
  'CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE',
  'CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE',
  'CAPTURE_REAL_DESKTOP_TEARDOWN',
  'CAPTURE_RUNTIME_CANDIDATE_ROOT',
  'CAPTURE_RUNTIME_CANDIDATE_ID',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT',
] as const;

type CaptureOnlyRequiredEnvironmentKey =
  (typeof CAPTURE_ONLY_REQUIRED_ENVIRONMENT_KEYS)[number];

export type CaptureOnlyEnvironmentErrorCode =
  | 'missing'
  | 'blank'
  | 'control_character'
  | 'duplicate_conflict'
  | 'invalid';

export class CaptureOnlyEnvironmentError extends Error {
  readonly key: CaptureOnlyRequiredEnvironmentKey;
  readonly code: CaptureOnlyEnvironmentErrorCode;

  constructor(
    key: CaptureOnlyRequiredEnvironmentKey,
    code: CaptureOnlyEnvironmentErrorCode,
  ) {
    super(`${key}:${code}`);
    this.name = 'CaptureOnlyEnvironmentError';
    this.key = key;
    this.code = code;
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function inheritedEnvironmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  canonicalKey: CaptureOnlyRequiredEnvironmentKey,
): string | undefined {
  const matchingKeys = Object.keys(environment).filter(
    (key) => key.toUpperCase() === canonicalKey.toUpperCase(),
  );
  const matchingValues = matchingKeys.map((key) => environment[key]);
  const firstValue = matchingValues[0];
  if (matchingValues.some((value) => value !== firstValue)) {
    throw new CaptureOnlyEnvironmentError(canonicalKey, 'duplicate_conflict');
  }
  const matchingKey =
    matchingKeys.find((key) => key === canonicalKey) ??
    [...matchingKeys].sort((left, right) => left.localeCompare(right))[0];
  return matchingKey === undefined ? undefined : environment[matchingKey];
}

function captureOnlyRequiredText(
  environment: Readonly<NodeJS.ProcessEnv>,
  key: CaptureOnlyRequiredEnvironmentKey,
): string {
  const value = inheritedEnvironmentValue(environment, key);
  if (value === undefined) {
    throw new CaptureOnlyEnvironmentError(key, 'missing');
  }
  if (typeof value !== 'string') {
    throw new CaptureOnlyEnvironmentError(key, 'invalid');
  }
  if (value.trim().length === 0) {
    throw new CaptureOnlyEnvironmentError(key, 'blank');
  }
  if (containsControlCharacter(value)) {
    throw new CaptureOnlyEnvironmentError(key, 'control_character');
  }
  return value;
}

function captureOnlyRequiredTrimmedPath(
  environment: Readonly<NodeJS.ProcessEnv>,
  key: CaptureOnlyRequiredEnvironmentKey,
): string {
  return captureOnlyRequiredText(environment, key).trim();
}

function captureOnlyRequiredExact(
  environment: Readonly<NodeJS.ProcessEnv>,
  key: CaptureOnlyRequiredEnvironmentKey,
  expected: string,
): string {
  const value = captureOnlyRequiredText(environment, key);
  if (value !== expected) {
    throw new CaptureOnlyEnvironmentError(key, 'invalid');
  }
  return value;
}

function resolveCaptureOnlyEnvironment(
  inheritedEnvironment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const required = {
    CAPTURE_REAL_DESKTOP_OCR_INPUT: captureOnlyRequiredTrimmedPath(
      inheritedEnvironment,
      'CAPTURE_REAL_DESKTOP_OCR_INPUT',
    ),
    CAPTURE_REAL_DESKTOP_EXECUTABLE: captureOnlyRequiredTrimmedPath(
      inheritedEnvironment,
      'CAPTURE_REAL_DESKTOP_EXECUTABLE',
    ),
    CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE: captureOnlyRequiredTrimmedPath(
      inheritedEnvironment,
      'CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE',
    ),
    CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE: captureOnlyRequiredExact(
      inheritedEnvironment,
      'CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE',
      'windowsml-dml',
    ),
    CAPTURE_REAL_DESKTOP_TEARDOWN: captureOnlyRequiredExact(
      inheritedEnvironment,
      'CAPTURE_REAL_DESKTOP_TEARDOWN',
      'window-close',
    ),
    CAPTURE_RUNTIME_CANDIDATE_ROOT: captureOnlyRequiredTrimmedPath(
      inheritedEnvironment,
      'CAPTURE_RUNTIME_CANDIDATE_ROOT',
    ),
    CAPTURE_RUNTIME_CANDIDATE_ID: captureOnlyRequiredTrimmedPath(
      inheritedEnvironment,
      'CAPTURE_RUNTIME_CANDIDATE_ID',
    ),
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: captureOnlyRequiredExact(
      inheritedEnvironment,
      'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN',
      '1',
    ),
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: captureOnlyRequiredTrimmedPath(
      inheritedEnvironment,
      'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT',
    ),
  } satisfies Record<CaptureOnlyRequiredEnvironmentKey, string>;
  if (!/^[a-f0-9]{64}$/u.test(required.CAPTURE_RUNTIME_CANDIDATE_ID)) {
    throw new CaptureOnlyEnvironmentError(
      'CAPTURE_RUNTIME_CANDIDATE_ID',
      'invalid',
    );
  }

  const scrubbed = { ...inheritedEnvironment };
  for (const key of Object.keys(scrubbed)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('CAPTURE_') || normalized.startsWith('E2E_')) {
      delete scrubbed[key];
    }
  }
  for (const key of CAPTURE_ONLY_REQUIRED_ENVIRONMENT_KEYS) {
    scrubbed[key] = required[key];
  }
  return scrubbed;
}

function scrubLocalModelEnvironment(
  environment: NodeJS.ProcessEnv,
  preserveExplicitOptIn: boolean,
): NodeJS.ProcessEnv {
  const scrubbed = { ...environment };
  const optIn = environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN;
  const root = environment.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT;
  for (const key of LOCAL_MODEL_ENVIRONMENT_KEYS) delete scrubbed[key];
  if (preserveExplicitOptIn && optIn === '1' && root?.trim()) {
    scrubbed.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN = '1';
    scrubbed.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT = root;
  }
  return scrubbed;
}

export interface AcceptanceChildRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly stdio: 'ignore';
    readonly shell: false;
    readonly windowsHide: false;
  };
}

export type AcceptanceDirectChildSpawner = (
  request: AcceptanceChildRequest,
) => number | Promise<number>;

export type AcceptanceCleanupKey = keyof AcceptanceCleanup;

export interface AcceptanceProcessIdentity {
  readonly pid: number;
  readonly creationTimeUtc: string;
  readonly executable: string;
}

export interface AcceptanceProcessStateProbeSpawnOptions {
  readonly encoding: 'utf8';
  readonly shell: false;
  readonly windowsHide: true;
}

export interface AcceptanceProcessStateProbeSpawnResult {
  readonly status: number | null;
  readonly stdout?: string | Buffer;
  readonly error?: unknown;
}

export interface AcceptanceProcessStateProbeAdapter {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly files?: Partial<WindowsBuiltInProcessFileAdapter>;
  readonly spawnSync?: (
    command: string,
    args: readonly string[],
    options: AcceptanceProcessStateProbeSpawnOptions,
  ) => AcceptanceProcessStateProbeSpawnResult;
}

export type AcceptanceOwnedProcessRole =
  | 'root'
  | 'app'
  | 'session'
  | 'sidecar'
  | 'model';

export interface AcceptanceOwnedProcessRecord
  extends AcceptanceProcessIdentity {
  readonly role: AcceptanceOwnedProcessRole;
  /** Binds this process identity to the exact run and artifact scope. */
  readonly runId: string;
  readonly artifactId: string;
}

export interface AcceptanceBaselineProcessRecord
  extends AcceptanceProcessIdentity {
  readonly role: 'baseline';
}

export type AcceptanceOwnedListenerRole = 'cdp' | 'runtime' | 'model';

export interface AcceptanceOwnedListenerRecord {
  readonly host: string;
  readonly port: number;
  readonly protocol: 'tcp';
  readonly role: AcceptanceOwnedListenerRole;
  readonly runId: string;
  readonly artifactId: string;
  readonly owner: AcceptanceProcessIdentity;
}

export type AcceptanceCleanupProbeState = 'present' | 'absent' | 'unknown';

export type AcceptanceScopePathKind =
  | 'modelPaths'
  | 'appDataPaths'
  | 'sessionPaths';

export interface AcceptanceScopeExpectation {
  readonly processRoles: readonly AcceptanceOwnedProcessRole[];
  readonly listenerRoles: readonly AcceptanceOwnedListenerRole[];
  /** Roles that may be absent without a placeholder record. */
  readonly optionalProcessRoles: readonly AcceptanceOwnedProcessRole[];
  readonly optionalListenerRoles: readonly AcceptanceOwnedListenerRole[];
  readonly pathKinds: readonly AcceptanceScopePathKind[];
}

export interface AcceptancePathStat {
  readonly isSymbolicLink: () => boolean;
}

export interface AcceptanceCleanupProbeHooks {
  readonly statPath?: (path: string) => Promise<AcceptancePathStat>;
  readonly processState?: (
    record: AcceptanceProcessIdentity,
  ) => Promise<AcceptanceCleanupProbeState>;
  readonly baselineProcessState?: (
    record: AcceptanceBaselineProcessRecord,
  ) => Promise<AcceptanceCleanupProbeState>;
  readonly listenerState?: (
    record: AcceptanceOwnedListenerRecord,
  ) => Promise<AcceptanceCleanupProbeState>;
}

/**
 * Private per-child evidence.  It is created before launch and may be
 * completed by the child harness in its own finally block.  The fallback
 * verifier only observes these exact identities; it never kills by name.
 */
export interface AcceptanceChildScope {
  readonly schemaVersion: 2;
  readonly project: AcceptanceProjectPlan['project'];
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactSha256: string | null;
  readonly expected: AcceptanceScopeExpectation;
  readonly status: 'prepared' | 'terminal';
  readonly evidenceComplete: boolean;
  readonly launchAttempted: boolean;
  readonly processRecords: readonly AcceptanceOwnedProcessRecord[];
  readonly baselineProcessRecords: readonly AcceptanceBaselineProcessRecord[];
  readonly listenerRecords: readonly AcceptanceOwnedListenerRecord[];
  readonly modelPaths: readonly string[];
  readonly appDataPaths: readonly string[];
  readonly sessionPaths: readonly string[];
}

export interface AcceptanceCleanupProof {
  readonly cleanup: AcceptanceCleanup;
  readonly errors: readonly string[];
  readonly scopeVerified: boolean;
}

export interface AcceptanceManifestIdentity {
  readonly project: AcceptanceProjectPlan['project'];
  readonly runId: string;
  /** Stable logical identity; never a filesystem path. */
  readonly artifactId: string;
}

export interface AcceptanceCleanupContext {
  readonly item: AcceptanceProjectPlan;
  readonly manifest: Record<string, unknown> | undefined;
  readonly scopePath: string;
  readonly probes?: AcceptanceCleanupProbeHooks;
}

export interface AcceptanceRunnerHooks {
  readonly spawnChild?: (
    item: AcceptanceProjectPlan,
  ) => number | Promise<number>;
  readonly readManifest?: (
    path: string,
    identity?: AcceptanceManifestIdentity,
  ) => Promise<Record<string, unknown> | undefined>;
  readonly prepareScope?: (item: AcceptanceProjectPlan) => Promise<void>;
  readonly verifyCleanup?: (
    context: AcceptanceCleanupContext,
  ) => Promise<AcceptanceCleanupProof>;
}

export interface CaptureWorkbenchAcceptanceHooks
  extends Omit<AcceptanceRunnerHooks, 'spawnChild'> {
  readonly spawnDirectChild?: AcceptanceDirectChildSpawner;
}

export interface AcceptanceProjectResult {
  readonly project: string;
  readonly status: string;
  /** Stable logical manifest ID; no local path is persisted in the aggregate. */
  readonly artifactId: string;
  readonly exitCode: number;
  readonly cleanupVerified: boolean;
  readonly errorCode?: string;
  readonly cleanupErrors: readonly string[];
  readonly evidence?: AcceptanceEvidenceSummary;
}

const REQUIRED_CLEANUP_EVIDENCE = [
  'app',
  'sidecar',
  'cdpPort',
  'temporaryAppData',
  'ownedPids',
  'ownedListeners',
  'ownedWorkers',
] as const;

const ACCEPTANCE_SCOPE_CONTRACTS: Readonly<
  Record<AcceptanceProjectPlan['project'], AcceptanceScopeExpectation>
> = {
  'capture-workbench': {
    processRoles: ['root', 'app', 'session', 'sidecar'],
    listenerRoles: ['cdp', 'runtime'],
    optionalProcessRoles: ['model'],
    optionalListenerRoles: ['model'],
    pathKinds: ['modelPaths', 'appDataPaths', 'sessionPaths'],
  },
  'cert-prep': {
    processRoles: ['root', 'app', 'session', 'sidecar', 'model'],
    listenerRoles: ['cdp', 'runtime', 'model'],
    optionalProcessRoles: [],
    optionalListenerRoles: [],
    pathKinds: ['modelPaths', 'appDataPaths', 'sessionPaths'],
  },
  'law-prep': {
    processRoles: ['root', 'app', 'session', 'sidecar', 'model'],
    listenerRoles: ['cdp', 'runtime', 'model'],
    optionalProcessRoles: [],
    optionalListenerRoles: [],
    pathKinds: ['modelPaths', 'appDataPaths', 'sessionPaths'],
  },
};

export function acceptanceScopeContractFor(
  project: AcceptanceProjectPlan['project'],
): AcceptanceScopeExpectation {
  return ACCEPTANCE_SCOPE_CONTRACTS[project];
}

export function stableAcceptanceArtifactId(
  project: AcceptanceManifestIdentity['project'],
  runId: string,
): string {
  return createHash('sha256')
    .update(`capture-workbench:acceptance-manifest:v2:${project}:${runId}`)
    .digest('hex');
}

/**
 * Bind a terminal scope to the child manifest's declared artifact bytes.  The
 * parent recomputes this digest after reading the child manifest; a replayed
 * scope or a manifest with different artifacts therefore cannot pass cleanup.
 */
export function computeAcceptanceArtifactBindingHash(
  manifest: Record<string, unknown> | undefined,
): string | undefined {
  if (
    !manifest ||
    !Array.isArray(manifest.artifacts) ||
    !manifest.artifacts.length
  )
    return undefined;
  const artifacts = manifest.artifacts.map((value) => {
    if (!value || typeof value !== 'object') return undefined;
    const artifact = value as Record<string, unknown>;
    if (
      typeof artifact.kind !== 'string' ||
      !['video', 'screenshot', 'trace', 'report', 'log', 'other'].includes(
        artifact.kind,
      ) ||
      typeof artifact.path !== 'string' ||
      !artifact.path ||
      !Number.isSafeInteger(artifact.bytes) ||
      Number(artifact.bytes) <= 0 ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
      return undefined;
    return {
      kind: artifact.kind,
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    };
  });
  if (artifacts.some((artifact) => artifact === undefined)) return undefined;
  const canonical = [...artifacts]
    .sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    })
    .map((artifact) => JSON.stringify(artifact))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildAcceptancePlan(
  workspaceRoot: string,
  runId: string,
  recordVideo: boolean,
): AcceptanceProjectPlan[] {
  assertSafeRunId(runId);
  const root = resolve(workspaceRoot);
  const projects = [
    {
      project: 'capture-workbench' as const,
      cwd: join(root, 'capture-workbench'),
      nx: 'capture-workbench-desktop',
    },
    {
      project: 'cert-prep' as const,
      cwd: join(root, 'cert-prep'),
      nx: 'cert-prep-desktop',
    },
    {
      project: 'law-prep' as const,
      cwd: join(root, 'gx.law-prep'),
      nx: 'law-prep-web-e2e',
    },
  ];
  const scopeRoot = join(
    root,
    'capture-workbench',
    'output',
    'playwright',
    'three-projects',
    runId,
    'scopes',
  );
  return projects.map(({ project, cwd, nx }) => ({
    project,
    cwd,
    target: `${nx}:acceptance-real${recordVideo ? '-recorded' : ''}`,
    artifactRoot: join(cwd, 'output', 'playwright', project, runId),
    scopePath: join(scopeRoot, `${project}.json`),
    environment: {
      ...scrubLocalModelEnvironment(process.env, false),
      E2E_ACCEPTANCE_RUN_ID: runId,
      E2E_RECORD_VIDEO: recordVideo ? '1' : '0',
      E2E_ARTIFACT_ROOT: join(cwd, 'output', 'playwright', project, runId),
      E2E_ACCEPTANCE_SCOPE_PATH: join(scopeRoot, `${project}.json`),
    },
  }));
}

export function buildCaptureWorkbenchAcceptancePlan(
  workspaceRoot: string,
  runId: string,
  recordVideo: boolean,
  inheritedEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): CaptureWorkbenchAcceptancePlan {
  assertSafeRunId(runId);
  const root = resolve(workspaceRoot);
  const artifactRoot = join(
    root,
    'output',
    'playwright',
    'capture-workbench',
    runId,
  );
  const scopePath = join(
    root,
    'output',
    'playwright',
    'three-projects',
    runId,
    'scopes',
    'capture-workbench.json',
  );
  return {
    project: 'capture-workbench',
    cwd: root,
    target: 'apps/capture-workbench-desktop/scripts/acceptance-real.ts',
    artifactRoot,
    scopePath,
    environment: {
      ...resolveCaptureOnlyEnvironment(inheritedEnvironment),
      E2E_ACCEPTANCE_RUN_ID: runId,
      E2E_RECORD_VIDEO: '0',
      E2E_ARTIFACT_ROOT: artifactRoot,
      E2E_ACCEPTANCE_SCOPE_PATH: scopePath,
    },
  };
}

export function buildCaptureWorkbenchChildRequest(
  item: CaptureWorkbenchAcceptancePlan,
  recordVideo: boolean,
): AcceptanceChildRequest {
  void recordVideo;
  return {
    command: process.execPath,
    args: [
      join(
        item.cwd,
        'apps',
        'capture-workbench-desktop',
        'scripts',
        'acceptance-real.ts',
      ),
    ],
    options: {
      cwd: item.cwd,
      env: item.environment,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
    },
  };
}

export async function runCaptureWorkbenchAcceptance(
  item: CaptureWorkbenchAcceptancePlan,
  runId: string,
  recordVideo: boolean,
  hooks: CaptureWorkbenchAcceptanceHooks = {},
): Promise<AcceptanceProjectResult[]> {
  void recordVideo;
  const { spawnDirectChild = spawnCaptureWorkbenchChild, ...sequenceHooks } =
    hooks;
  return runAcceptanceSequence([item], runId, false, {
    ...sequenceHooks,
    spawnChild: async (child) => {
      if (child.project !== 'capture-workbench') return 1;
      return spawnDirectChild(
        buildCaptureWorkbenchChildRequest(
          child as CaptureWorkbenchAcceptancePlan,
          false,
        ),
      );
    },
  });
}

export function mapAcceptanceExitCode(
  results: readonly AcceptanceProjectResult[],
  expectedProjectCount = 1,
): number {
  return results.length === expectedProjectCount &&
    results.every(
      (result) =>
        result.exitCode === 0 &&
        result.status === 'completed' &&
        result.cleanupVerified,
    )
    ? 0
    : 1;
}

export async function runAcceptanceSequence(
  plan: readonly AcceptanceProjectPlan[],
  runId: string,
  recordVideo: boolean,
  hooks: AcceptanceRunnerHooks = {},
): Promise<AcceptanceProjectResult[]> {
  const results: AcceptanceProjectResult[] = [];
  const spawnChild = hooks.spawnChild ?? spawnAcceptanceChild;
  const readChildManifest = hooks.readManifest ?? readManifest;
  const prepareScope = hooks.prepareScope ?? writePreparedScope;
  const verifyCleanup = hooks.verifyCleanup ?? verifyRecordedCleanupScope;

  for (const item of plan) {
    process.stdout.write(`\n=== ${item.project} ${item.target} ===\n`);
    const artifactId = stableAcceptanceArtifactId(item.project, runId);
    const manifestIdentity: AcceptanceManifestIdentity = {
      project: item.project,
      runId,
      artifactId,
    };
    try {
      await prepareScope(item);
    } catch {
      results.push({
        project: item.project,
        status: 'scope-preparation-failed',
        artifactId,
        exitCode: 1,
        cleanupVerified: false,
        errorCode: 'scope_preparation_failed',
        cleanupErrors: ['scope preparation failed closed.'],
      });
      break;
    }
    const manifestPath = join(item.artifactRoot, 'acceptance-manifest.json');
    let exitCode = 1;
    const cleanupErrors: string[] = [];
    let errorCode: string | undefined;
    try {
      exitCode = await spawnChild(item);
    } catch (error) {
      // Do not serialize the child error; Node error messages commonly carry
      // executable paths, command lines, or inherited environment details.
      void error;
      errorCode = 'child_spawn_failed';
      cleanupErrors.push('child process could not be started.');
    }
    const manifest = await readChildManifest(manifestPath, manifestIdentity);
    // A hard child/root termination cannot run the child finally block.  The
    // parent records a terminal-but-incomplete scope from the last atomically
    // written child snapshot.  It never promotes evidence to clean: identity,
    // artifact, and cleanup validation below still gate the sequence.
    if (item.project === 'capture-workbench') {
      await recoverPreparedCaptureScope(item, manifest).catch(() => undefined);
    }
    const terminalManifest = validateTerminalManifest(
      manifest,
      item,
      runId,
      recordVideo,
    );
    const childValid = await validateChildManifest(
      manifest,
      item,
      runId,
      recordVideo,
    );
    if (!manifest) errorCode ??= 'manifest_missing_or_invalid';
    else if (!terminalManifest) errorCode ??= 'manifest_invalid';
    else if (manifest.status === 'completed' && !childValid)
      errorCode ??= 'manifest_acceptance_failed';
    const cleanupContext: AcceptanceCleanupContext = {
      item,
      manifest,
      scopePath: item.scopePath,
    };
    const scopeValidation = await validateAcceptanceScope(cleanupContext);
    let proof: AcceptanceCleanupProof;
    try {
      proof = await verifyCleanup(cleanupContext);
    } catch {
      proof = failedCleanupProof('cleanup_verifier_failed');
    }
    const manifestCleanupShapeValid = isCleanupShape(manifest?.cleanup);
    const proofCleanupValid = validateCleanupEvidence(proof.cleanup);
    const proofCleanupShapeValid = isCleanupShape(proof.cleanup);
    const cleanupFlagsMatch =
      manifestCleanupShapeValid &&
      proofCleanupShapeValid &&
      cleanupEvidenceEqual(manifest?.cleanup, proof.cleanup);
    const cleanupVerified =
      scopeValidation.valid &&
      proof.scopeVerified &&
      proof.errors.length === 0 &&
      proofCleanupValid &&
      cleanupFlagsMatch;
    const sanitizedErrors = [
      ...scopeValidation.errors,
      ...proof.errors,
      ...(cleanupFlagsMatch ? [] : ['cleanup_flags_mismatch']),
    ].map((error) => sanitizeRunnerError(error));
    cleanupErrors.push(...new Set(sanitizedErrors));
    if (!scopeValidation.valid && !errorCode) {
      errorCode = scopeValidation.errors.find(isStableAcceptanceErrorCode);
    }
    if (!cleanupFlagsMatch) errorCode ??= 'cleanup_flags_mismatch';
    if (!proof.scopeVerified && !errorCode)
      errorCode = 'cleanup_verifier_failed';
    if (!cleanupVerified && !errorCode) {
      errorCode = sanitizedErrors.find(isStableAcceptanceErrorCode);
    }
    if (exitCode !== 0) errorCode ??= 'child_exit_nonzero';
    if (!cleanupVerified) errorCode ??= 'cleanup_unverified';
    const status = childValid
      ? 'completed'
      : manifest?.status === 'failed' && terminalManifest
        ? 'failed'
        : manifest
          ? 'invalid'
          : 'missing';
    results.push({
      project: item.project,
      status,
      artifactId,
      exitCode,
      cleanupVerified,
      errorCode,
      cleanupErrors,
      evidence: sanitizeAcceptanceEvidence(manifest?.evidence),
    });
    // A non-zero child, a non-terminal/invalid child manifest, or an
    // unproven cleanup all stop the sequence.  In particular, the next model
    // slot is never acquired while the current child is unresolved.
    if (exitCode !== 0 || !childValid || !cleanupVerified) break;
  }
  return results;
}

/**
 * Reconcile a Capture Workbench scope whose owner was terminated before its
 * final write. This is local evidence repair, not a cleanup claim:
 * `evidenceComplete` remains false and the normal validator must still prove
 * every recorded identity and path before a sequence can continue.
 */
export async function recoverPreparedCaptureScope(
  item: AcceptanceProjectPlan,
  manifest: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (item.project !== 'capture-workbench') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(item.scopePath, 'utf8')) as unknown;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return false;
  const candidate = parsed as Record<string, unknown>;
  const runId = readRunId(item);
  const artifactId = stableAcceptanceArtifactId(item.project, runId);
  if (
    candidate.schemaVersion !== 2 ||
    candidate.project !== item.project ||
    candidate.runId !== runId ||
    candidate.artifactId !== artifactId ||
    candidate.status !== 'prepared' ||
    candidate.evidenceComplete !== false ||
    candidate.launchAttempted !== true ||
    candidate.artifactSha256 !== null ||
    !isScopeExpectation(candidate.expected) ||
    !scopeExpectationEqual(
      candidate.expected,
      acceptanceScopeContractFor(item.project),
    ) ||
    !Array.isArray(candidate.processRecords) ||
    !Array.isArray(candidate.baselineProcessRecords) ||
    !Array.isArray(candidate.listenerRecords) ||
    !Array.isArray(candidate.modelPaths) ||
    !Array.isArray(candidate.appDataPaths) ||
    !Array.isArray(candidate.sessionPaths) ||
    candidate.modelPaths.length === 0 ||
    candidate.appDataPaths.length === 0 ||
    candidate.sessionPaths.length === 0
  ) {
    return false;
  }
  const artifactSha256 = computeAcceptanceArtifactBindingHash(manifest) ?? null;
  const recovered = {
    ...candidate,
    status: 'terminal' as const,
    evidenceComplete: false,
    artifactSha256,
  };
  const temporary = `${item.scopePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(recovered, null, 2)}\n`, 'utf8');
    await rename(temporary, item.scopePath);
    return true;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const captureRoot = resolve(import.meta.dirname, '..');
  const siblingRoot = resolve(captureRoot, '..');
  const captureWorkbenchOnly = process.argv.includes('--capture-workbench-only');
  const runId =
    (captureWorkbenchOnly ? undefined : process.env.E2E_ACCEPTANCE_RUN_ID?.trim()) ||
    `run-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`;
  assertSafeRunId(runId);
  const recordVideo = process.argv.includes('--recorded');
  if (captureWorkbenchOnly) {
    const plan = buildCaptureWorkbenchAcceptancePlan(
      captureRoot,
      runId,
      false,
    );
    const results = await runCaptureWorkbenchAcceptance(
      plan,
      runId,
      false,
    );
    process.exitCode = mapAcceptanceExitCode(results);
    return;
  }
  const plan = buildAcceptancePlan(siblingRoot, runId, recordVideo);
  const results = await runAcceptanceSequence(plan, runId, recordVideo);
  const aggregateRoot = join(
    captureRoot,
    'output',
    'playwright',
    'three-projects',
    runId,
  );
  await mkdir(aggregateRoot, { recursive: true });
  const status =
    mapAcceptanceExitCode(results, plan.length) === 0 ? 'completed' : 'failed';
  const aggregate = {
    schemaVersion: 1,
    runId,
    recordVideo,
    status,
    projects: results,
  };
  await writeFile(
    join(aggregateRoot, 'three-projects-manifest.json'),
    `${JSON.stringify(aggregate, null, 2)}\n`,
    'utf8',
  );
  process.exitCode = status === 'completed' ? 0 : 1;
}

async function spawnAcceptanceChild(
  item: AcceptanceProjectPlan,
): Promise<number> {
  const result = spawnSyncProcess(
    'corepack',
    ['pnpm', 'nx', 'run', item.target],
    // Child output is intentionally discarded.  Acceptance child logs may
    // contain OCR/truth text, tokens, stack traces, or absolute paths; the
    // aggregate reports only the stable project/artifact/error-code tuple.
    {
      cwd: item.cwd,
      env: item.environment,
      stdio: 'ignore',
      shell: true,
      windowsHide: false,
    },
  );
  return result.error ? 1 : (result.status ?? 1);
}

async function spawnCaptureWorkbenchChild(
  request: AcceptanceChildRequest,
): Promise<number> {
  const result = spawnSyncProcess(
    request.command,
    [...request.args],
    request.options,
  );
  return result.error ? 1 : (result.status ?? 1);
}

async function writePreparedScope(item: AcceptanceProjectPlan): Promise<void> {
  const scope: AcceptanceChildScope = {
    schemaVersion: 2,
    project: item.project,
    runId: readRunId(item),
    artifactId: stableAcceptanceArtifactId(item.project, readRunId(item)),
    artifactSha256: null,
    expected: acceptanceScopeContractFor(item.project),
    status: 'prepared',
    evidenceComplete: false,
    launchAttempted: false,
    processRecords: [],
    baselineProcessRecords: [],
    listenerRecords: [],
    modelPaths: [],
    appDataPaths: [],
    sessionPaths: [],
  };
  await mkdir(dirname(item.scopePath), { recursive: true });
  await writeFile(
    item.scopePath,
    `${JSON.stringify(scope, null, 2)}\n`,
    'utf8',
  );
}

function readRunId(item: AcceptanceProjectPlan): string {
  return item.environment.E2E_ACCEPTANCE_RUN_ID?.trim() || '<unknown-run>';
}

interface AcceptancePathProbeResult {
  readonly state: AcceptanceCleanupProbeState;
  readonly code?: string;
}

interface AcceptancePathProbeSummary {
  readonly present: readonly string[];
  readonly unknown: readonly { path: string; code: string }[];
}

interface AcceptanceScopeValidation {
  readonly valid: boolean;
  readonly scope?: AcceptanceChildScope;
  readonly errors: readonly string[];
}

async function validateAcceptanceScope(
  context: AcceptanceCleanupContext,
): Promise<AcceptanceScopeValidation> {
  const scope = await readChildScope(context.scopePath);
  if (!scope)
    return {
      valid: false,
      errors: ['scope_missing_or_invalid'],
    };
  const errors: string[] = [];
  const expectedArtifactId = stableAcceptanceArtifactId(
    context.item.project,
    readRunId(context.item),
  );
  if (
    scope.project !== context.item.project ||
    scope.runId !== readRunId(context.item) ||
    scope.artifactId !== expectedArtifactId
  ) {
    errors.push('scope_artifact_identity_mismatch');
  }
  if (
    scope.status !== 'terminal' ||
    scope.evidenceComplete !== true ||
    scope.launchAttempted !== true
  ) {
    errors.push('scope_not_terminal_or_complete');
  }
  const contract = acceptanceScopeContractFor(context.item.project);
  if (!scopeExpectationEqual(scope.expected, contract)) {
    errors.push('scope_expected_contract_mismatch');
  }
  const artifactHash = computeAcceptanceArtifactBindingHash(context.manifest);
  if (!artifactHash) {
    errors.push('scope_artifact_hash_unavailable');
  } else if (scope.artifactSha256 !== artifactHash) {
    errors.push('scope_artifact_hash_mismatch');
  }
  for (const role of contract.processRoles) {
    if (!scope.processRecords.some((record) => recordRole(record) === role)) {
      errors.push(`scope_required_process_role_${role}`);
    }
  }
  for (const role of contract.listenerRoles) {
    if (!scope.listenerRecords.some((record) => recordRole(record) === role)) {
      errors.push(`scope_required_listener_role_${role}`);
    }
  }
  for (const pathKind of contract.pathKinds) {
    if (!scope[pathKind].length)
      errors.push(`scope_required_path_kind_${pathKind}`);
  }
  if (!scope.baselineProcessRecords.length)
    errors.push('scope_baseline_required');
  if (errors.some((error) => error.startsWith('scope_required_'))) {
    return {
      valid: false,
      scope,
      errors,
    };
  }
  const identityErrors = validateScopeIdentityRecords(scope);
  errors.push(...identityErrors);
  // Do not probe any recorded PID/listener until every identity and binding
  // has passed validation.  In particular, malformed records must not be
  // interpreted as an absent process or listener.
  if (errors.length)
    return {
      valid: false,
      scope,
      errors,
    };
  return { valid: true, scope, errors: [] };
}

function recordRole(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const role = (value as { role?: unknown }).role;
  return typeof role === 'string' ? role : undefined;
}

function validateScopeIdentityRecords(scope: AcceptanceChildScope): string[] {
  const errors: string[] = [];
  if (!scope.processRecords.every(isOwnedProcessRecord))
    errors.push('scope_process_identity_invalid');
  if (!scope.baselineProcessRecords.every(isBaselineProcessRecord))
    errors.push('scope_baseline_identity_invalid');
  if (!scope.listenerRecords.every(isOwnedListenerRecord))
    errors.push('scope_listener_identity_invalid');
  if (errors.length) return errors;

  const allowedProcessRoles = new Set([
    ...scope.expected.processRoles,
    ...scope.expected.optionalProcessRoles,
  ]);
  for (const record of scope.processRecords)
    if (!allowedProcessRoles.has(record.role))
      errors.push('scope_process_role_unexpected');
  const allowedListenerRoles = new Set([
    ...scope.expected.listenerRoles,
    ...scope.expected.optionalListenerRoles,
  ]);
  for (const record of scope.listenerRecords)
    if (!allowedListenerRoles.has(record.role))
      errors.push('scope_listener_role_unexpected');

  const processKeys = new Set<string>();
  const ownedByIdentity = new Map<string, AcceptanceOwnedProcessRecord>();
  for (const record of scope.processRecords) {
    if (
      record.runId !== scope.runId ||
      record.artifactId !== scope.artifactId
    ) {
      errors.push('scope_process_identity_binding_mismatch');
    }
    const key = processIdentityKey(record);
    if (processKeys.has(key))
      errors.push('scope_process_identity_duplicate');
    processKeys.add(key);
    ownedByIdentity.set(key, record);
  }

  const baselineKeys = new Set<string>();
  for (const record of scope.baselineProcessRecords) {
    const key = processIdentityKey(record);
    if (baselineKeys.has(key))
      errors.push('scope_baseline_identity_duplicate');
    if (processKeys.has(key))
      errors.push('scope_baseline_identity_overlap');
    baselineKeys.add(key);
  }

  const listenerKeys = new Set<string>();
  const listenerOwnerRoles: Readonly<
    Record<AcceptanceOwnedListenerRole, AcceptanceOwnedProcessRole>
  > = {
    cdp: 'session',
    runtime: 'sidecar',
    model: 'model',
  };
  for (const record of scope.listenerRecords) {
    if (
      record.runId !== scope.runId ||
      record.artifactId !== scope.artifactId
    ) {
      errors.push('scope_listener_identity_binding_mismatch');
    }
    const owner = ownedByIdentity.get(processIdentityKey(record.owner));
    if (!owner) {
      errors.push('scope_listener_owner_mismatch');
    } else if (owner.role !== listenerOwnerRoles[record.role]) {
      errors.push('scope_listener_owner_role_mismatch');
    }
    // A listener endpoint can be reused by a restarted process. Its owner
    // identity is therefore part of the evidence key; exact replays remain
    // invalid while distinct retry history remains monotonic.
    const listenerKey = `${normalizeHost(record.host)}|${record.port}|${record.protocol}|${processIdentityKey(record.owner)}`;
    if (listenerKeys.has(listenerKey))
      errors.push('scope_listener_identity_duplicate');
    listenerKeys.add(listenerKey);
  }
  return [...new Set(errors)];
}

function processIdentityKey(record: AcceptanceProcessIdentity): string {
  return `${record.pid}|${normalizeCreationIdentity(record.creationTimeUtc)}|${normalizePath(record.executable)}`;
}

function scopeExpectationEqual(
  actual: AcceptanceScopeExpectation,
  expected: AcceptanceScopeExpectation,
): boolean {
  return (
    sameStringSet(actual.processRoles, expected.processRoles) &&
    sameStringSet(actual.listenerRoles, expected.listenerRoles) &&
    sameStringSet(actual.optionalProcessRoles, expected.optionalProcessRoles) &&
    sameStringSet(actual.optionalListenerRoles, expected.optionalListenerRoles) &&
    sameStringSet(actual.pathKinds, expected.pathKinds)
  );
}

function sameStringSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

export async function verifyRecordedCleanupScope(
  context: AcceptanceCleanupContext,
): Promise<AcceptanceCleanupProof> {
  const validation = await validateAcceptanceScope(context);
  if (!validation.valid || !validation.scope)
    return failedCleanupProof(
      validation.errors[0] ?? 'scope_missing_or_invalid',
    );
  const scope = validation.scope;
  const errors: string[] = [];
  const processProbe = context.probes?.processState ?? recordedProcessState;
  const baselineProcessProbe =
    context.probes?.baselineProcessState ?? processProbe;
  const listenerProbe = context.probes?.listenerState ?? recordedListenerState;
  const statProbe = context.probes?.statPath ?? lstat;
  const processStates: Array<{
    record: AcceptanceOwnedProcessRecord;
    state: AcceptanceCleanupProbeState;
  }> = [];
  for (const record of scope.processRecords) {
    processStates.push({ record, state: await processProbe(record) });
  }
  const baselineStates: Array<{
    record: AcceptanceBaselineProcessRecord;
    state: AcceptanceCleanupProbeState;
  }> = [];
  for (const record of scope.baselineProcessRecords) {
    baselineStates.push({
      record,
      state: await baselineProcessProbe(record),
    });
  }
  const listenerStates: Array<{
    record: AcceptanceOwnedListenerRecord;
    state: AcceptanceCleanupProbeState;
  }> = [];
  for (const record of scope.listenerRecords) {
    listenerStates.push({ record, state: await listenerProbe(record) });
  }
  const appDataPaths = [
    ...scope.modelPaths,
    ...scope.appDataPaths,
    ...scope.sessionPaths,
  ];
  const appDataInspection = await inspectExistingPaths(appDataPaths, statProbe);
  const appDataResidue = appDataInspection.present;
  const allPidsGone = processStates.every(({ state }) => state === 'absent');
  const appGone = processStates
    .filter(({ record }) => record.role === 'app')
    .every(({ state }) => state === 'absent');
  const sidecarsGone = processStates
    .filter(({ record }) => record.role === 'sidecar')
    .every(({ state }) => state === 'absent');
  const modelWorkersGone = processStates
    .filter(({ record }) => record.role === 'model')
    .every(({ state }) => state === 'absent');
  const listenersClosed = listenerStates.every(
    ({ state }) => state === 'absent',
  );
  const cdpClosed = listenerStates
    .filter(({ record }) => record.role === 'cdp')
    .every(({ state }) => state === 'absent');
  const baselineHealthy = baselineStates.every(
    ({ state }) => state === 'present',
  );
  const cleanup: AcceptanceCleanup = {
    app: appGone,
    sidecar: sidecarsGone,
    cdpPort: cdpClosed,
    temporaryAppData:
      appDataResidue.length === 0 && appDataInspection.unknown.length === 0,
    ownedPids: allPidsGone,
    ownedListeners: listenersClosed,
    ownedWorkers:
      baselineHealthy &&
      modelWorkersGone &&
      !scope.modelPaths.some(
        (path) =>
          appDataResidue.includes(path) ||
          appDataInspection.unknown.some((entry) => entry.path === path),
      ),
  };
  if (processStates.some(({ state }) => state === 'present'))
    errors.push('Recorded owned process residue remained.');
  if (processStates.some(({ state }) => state === 'unknown'))
    errors.push('cleanup_probe_owned_process_unavailable');
  if (baselineStates.some(({ state }) => state === 'absent'))
    errors.push('scope_baseline_process_absent');
  if (baselineStates.some(({ state }) => state === 'unknown'))
    errors.push('scope_baseline_process_unavailable');
  if (listenerStates.some(({ state }) => state === 'present'))
    errors.push('Recorded owned listener residue remained.');
  if (listenerStates.some(({ state }) => state === 'unknown'))
    errors.push('cleanup_probe_owned_listener_unavailable');
  for (const { code } of appDataInspection.unknown) {
    errors.push(`cleanup_probe_temporary_app_data_${code}`);
  }
  if (appDataResidue.length > 0)
    errors.push('Recorded model or app-data residue remained.');
  return { cleanup, errors, scopeVerified: true };
}

async function readChildScope(
  path: string,
): Promise<AcceptanceChildScope | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<AcceptanceChildScope>;
    if (
      candidate.schemaVersion !== 2 ||
      typeof candidate.project !== 'string' ||
      typeof candidate.runId !== 'string' ||
      typeof candidate.artifactId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.artifactId) ||
      (candidate.artifactSha256 !== null &&
        (typeof candidate.artifactSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(candidate.artifactSha256))) ||
      !isScopeExpectation(candidate.expected) ||
      (candidate.status !== 'prepared' && candidate.status !== 'terminal') ||
      typeof candidate.evidenceComplete !== 'boolean' ||
      typeof candidate.launchAttempted !== 'boolean' ||
      !Array.isArray(candidate.processRecords) ||
      !Array.isArray(candidate.baselineProcessRecords) ||
      !Array.isArray(candidate.listenerRecords) ||
      !Array.isArray(candidate.modelPaths) ||
      !Array.isArray(candidate.appDataPaths) ||
      !Array.isArray(candidate.sessionPaths) ||
      candidate.processRecords.length > 512 ||
      candidate.baselineProcessRecords.length > 512 ||
      candidate.listenerRecords.length > 512 ||
      candidate.modelPaths.length > 512 ||
      candidate.appDataPaths.length > 512 ||
      candidate.sessionPaths.length > 512
    )
      return undefined;
    if (
      [
        ...candidate.modelPaths,
        ...candidate.appDataPaths,
        ...candidate.sessionPaths,
      ].every((path_) => typeof path_ === 'string' && Boolean(path_.trim()))
    ) {
      return candidate as AcceptanceChildScope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isOwnedProcessRecord(
  value: unknown,
): value is AcceptanceOwnedProcessRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AcceptanceOwnedProcessRecord>;
  return (
    isProcessIdentity(value) &&
    typeof record.runId === 'string' &&
    record.runId.trim().length > 0 &&
    typeof record.artifactId === 'string' &&
    /^[a-f0-9]{64}$/u.test(record.artifactId) &&
    (record.role === 'root' ||
      record.role === 'app' ||
      record.role === 'session' ||
      record.role === 'sidecar' ||
      record.role === 'model')
  );
}

function isBaselineProcessRecord(
  value: unknown,
): value is AcceptanceBaselineProcessRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AcceptanceBaselineProcessRecord>;
  return record.role === 'baseline' && isProcessIdentity(record);
}

function isProcessIdentity(value: unknown): value is AcceptanceProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AcceptanceProcessIdentity>;
  return (
    Number.isSafeInteger(record.pid) &&
    Number(record.pid) > 0 &&
    typeof record.creationTimeUtc === 'string' &&
    normalizeCreationIdentity(record.creationTimeUtc) !== undefined &&
    typeof record.executable === 'string' &&
    normalizeExecutableIdentity(record.executable) !== undefined
  );
}

function isScopeExpectation(
  value: unknown,
): value is AcceptanceScopeExpectation {
  if (!value || typeof value !== 'object') return false;
  const expectation = value as Partial<AcceptanceScopeExpectation>;
  return (
    Array.isArray(expectation.processRoles) &&
    Array.isArray(expectation.listenerRoles) &&
    Array.isArray(expectation.optionalProcessRoles) &&
    Array.isArray(expectation.optionalListenerRoles) &&
    Array.isArray(expectation.pathKinds) &&
    expectation.processRoles.every((role) =>
      ['root', 'app', 'session', 'sidecar', 'model'].includes(role),
    ) &&
    expectation.listenerRoles.every((role) =>
      ['cdp', 'runtime', 'model'].includes(role),
    ) &&
    expectation.optionalProcessRoles.every((role) =>
      ['root', 'app', 'session', 'sidecar', 'model'].includes(role),
    ) &&
    expectation.optionalListenerRoles.every((role) =>
      ['cdp', 'runtime', 'model'].includes(role),
    ) &&
    expectation.pathKinds.every((pathKind) =>
      ['modelPaths', 'appDataPaths', 'sessionPaths'].includes(pathKind),
    )
  );
}

function isOwnedListenerRecord(
  value: unknown,
): value is AcceptanceOwnedListenerRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AcceptanceOwnedListenerRecord>;
  return (
    typeof record.host === 'string' &&
    isLoopbackHost(record.host) &&
    Number.isSafeInteger(record.port) &&
    Number(record.port) > 0 &&
    Number(record.port) <= 65_535 &&
    record.protocol === 'tcp' &&
    typeof record.runId === 'string' &&
    record.runId.trim().length > 0 &&
    typeof record.artifactId === 'string' &&
    /^[a-f0-9]{64}$/u.test(record.artifactId) &&
    isProcessIdentity(record.owner) &&
    (record.role === 'cdp' ||
      record.role === 'runtime' ||
      record.role === 'model')
  );
}

async function inspectExistingPaths(
  paths: readonly string[],
  statProbe: (path: string) => Promise<AcceptancePathStat>,
): Promise<AcceptancePathProbeSummary> {
  const present: string[] = [];
  const unknown: Array<{ path: string; code: string }> = [];
  for (const path of paths) {
    const first = await inspectPathOnce(path, statProbe);
    const second = await inspectPathOnce(path, statProbe);
    if (first.state === second.state && first.state !== 'unknown') {
      if (first.state === 'present') present.push(path);
      continue;
    }
    const code =
      first.state === 'unknown' &&
      second.state === 'unknown' &&
      first.code === second.code
        ? (first.code ?? 'unknown_error')
        : 'race_detected';
    unknown.push({ path, code });
  }
  return { present, unknown };
}

async function inspectPathOnce(
  path: string,
  statProbe: (path: string) => Promise<AcceptancePathStat>,
): Promise<AcceptancePathProbeResult> {
  try {
    const metadata = await statProbe(path);
    try {
      // lstat deliberately observes symlinks/junctions instead of following
      // them.  Calling the method also makes mock probes exercise that seam.
      void metadata.isSymbolicLink();
    } catch {
      return { state: 'unknown', code: 'unknown_error' };
    }
    return { state: 'present' };
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === 'ENOENT') return { state: 'absent' };
    return { state: 'unknown', code: stablePathProbeCode(code) };
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function stablePathProbeCode(code: string | undefined): string {
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'EIO') return 'io_error';
  return 'unknown_error';
}

export function createAcceptanceProcessStateProbe(
  adapter: AcceptanceProcessStateProbeAdapter = {},
): (
  record: AcceptanceProcessIdentity,
) => Promise<AcceptanceCleanupProbeState> {
  const platform = adapter.platform ?? process.platform;
  const environment = adapter.environment ?? process.env;
  return async (record) => {
    if (
      platform !== 'win32' ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0
    ) {
      return 'unknown';
    }
    const executable = await resolveWindowsBuiltInPowerShell(
      environment,
      adapter.files,
    );
    if (!executable) return 'unknown';
    const filter = `ProcessId = ${record.pid}`;
    const script = `$p = Get-CimInstance Win32_Process -Filter "${filter}"; if ($null -eq $p) { [ordered]@{ present = $false } | ConvertTo-Json -Compress } else { [ordered]@{ present = $true; executable = [string]$p.ExecutablePath; creation = [string]$p.CreationDate } | ConvertTo-Json -Compress }`;
    let result: AcceptanceProcessStateProbeSpawnResult;
    try {
      result = adapter.spawnSync
        ? adapter.spawnSync(executable, [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script,
          ], {
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
          })
        : (spawnSyncProcess(
            executable,
            ['-NoProfile', '-NonInteractive', '-Command', script],
            {
              encoding: 'utf8',
              shell: false,
              windowsHide: true,
            },
          ) as AcceptanceProcessStateProbeSpawnResult);
    } catch {
      return 'unknown';
    }
    if (result.error || result.status !== 0) return 'unknown';
    try {
      const observed = JSON.parse(String(result.stdout || '{}')) as {
        present?: unknown;
        executable?: unknown;
        creation?: unknown;
      };
      if (observed.present === false) return 'absent';
      if (observed.present !== true) return 'unknown';
      const observedExecutable = String(observed.executable || '').trim();
      const observedCreation = String(observed.creation || '').trim();
      if (!observedExecutable || !observedCreation) return 'unknown';
      const executableMatches =
        normalizePath(observedExecutable) === normalizePath(record.executable);
      const creationMatches = normalizeCreation(
        observedCreation,
        record.creationTimeUtc,
      );
      return executableMatches && creationMatches ? 'present' : 'absent';
    } catch {
      return 'unknown';
    }
  };
}

const recordedProcessState = createAcceptanceProcessStateProbe();

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').toLowerCase();
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function isLoopbackHost(value: string): boolean {
  const host = normalizeHost(value);
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function normalizeExecutableIdentity(value: string): string | undefined {
  const normalized = normalizePath(value);
  if (
    !normalized ||
    /[*?]/u.test(normalized) ||
    !/^(?:[a-z]:\/|\/|\/\/)/u.test(normalized)
  )
    return undefined;
  return normalized;
}

function normalizeCreationIdentity(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return String(parsed);
  // Windows WMI can expose DMTF creation timestamps instead of ISO-8601.
  return /^\d{8,20}(?:\.\d+)?[+-]\d{3,4}$/u.test(trimmed)
    ? trimmed
    : undefined;
}

function normalizeCreation(observed: string, expected: string): boolean {
  const observedMs = Date.parse(observed);
  const expectedMs = Date.parse(expected);
  return Number.isFinite(observedMs) && Number.isFinite(expectedMs)
    ? Math.abs(observedMs - expectedMs) < 2_000
    : observed === expected;
}

async function recordedListenerState(
  record: AcceptanceOwnedListenerRecord,
): Promise<AcceptanceCleanupProbeState> {
  return new Promise((resolveState) => {
    const socket = net.createConnection({
      host: record.host,
      port: record.port,
    });
    let settled = false;
    const finish = (state: AcceptanceCleanupProbeState): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveState(state);
    };
    socket.once('connect', () => finish('present'));
    socket.once('error', (error: unknown) => {
      finish(nodeErrorCode(error) === 'ECONNREFUSED' ? 'absent' : 'unknown');
    });
    socket.setTimeout(250, () => finish('unknown'));
  });
}

function failedCleanupProof(error: string): AcceptanceCleanupProof {
  return {
    cleanup: {
      app: false,
      sidecar: false,
      cdpPort: false,
      temporaryAppData: false,
      ownedPids: false,
      ownedListeners: false,
      ownedWorkers: false,
    },
    errors: [error],
    scopeVerified: false,
  };
}

function sanitizeRunnerError(error: string): string {
  if (isStableAcceptanceErrorCode(error)) {
    return error;
  }
  const normalized = error.toLowerCase();
  if (normalized.includes('pid') || normalized.includes('process')) {
    return 'owned PID residue remained.';
  }
  if (normalized.includes('listener') || normalized.includes('port')) {
    return 'owned listener residue remained.';
  }
  if (
    normalized.includes('model') ||
    normalized.includes('app-data') ||
    normalized.includes('residue')
  ) {
    return 'temporary app-data residue remained.';
  }
  return 'cleanup verification failed closed.';
}

function isStableAcceptanceErrorCode(error: string): boolean {
  return /^(?:cleanup_flags_mismatch|cleanup_verifier_failed|scope_(?:missing_or_invalid|artifact_identity_mismatch|artifact_hash_(?:unavailable|mismatch)|not_terminal_or_complete|expected_contract_mismatch|baseline_required|baseline_process_(?:absent|unavailable)|(?:process|listener)_role_unexpected|duplicate_(?:process|listener)_role_[a-zA-Z]+|(?:process|baseline|listener)_(?:identity_(?:invalid|binding_mismatch|duplicate)|identity_overlap|owner_mismatch|owner_role_mismatch)|required_(?:process_role|listener_role|path_kind)_[a-zA-Z]+)|cleanup_probe_(?:owned_process_unavailable|owned_listener_unavailable|temporary_app_data_(?:permission_denied|io_error|unknown_error|race_detected)))$/u.test(
    error,
  );
}

function cleanupEvidenceEqual(
  left: unknown,
  right: AcceptanceCleanup,
): boolean {
  if (!isCleanupShape(left)) return false;
  return REQUIRED_CLEANUP_EVIDENCE.every((key) => left[key] === right[key]);
}

async function readManifest(
  path: string,
  identity: AcceptanceManifestIdentity,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      containsAbsoluteLocalPath(parsed) ||
      containsBearerToken(parsed) ||
      containsSensitiveEvidence(parsed)
    ) {
      writeManifestDiagnostic(identity, 'manifest_privacy_violation');
      return undefined;
    }
    return parsed;
  } catch (error) {
    writeManifestDiagnostic(
      identity,
      error instanceof SyntaxError
        ? 'manifest_invalid_json'
        : 'manifest_unavailable',
    );
    return undefined;
  }
}

function containsBearerToken(value: unknown): boolean {
  if (typeof value === 'string') return /Bearer\s+[^<\s]+/iu.test(value);
  if (Array.isArray(value))
    return value.some((item) => containsBearerToken(item));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((nested) => containsBearerToken(nested));
  }
  return false;
}

function containsAbsoluteLocalPath(value: unknown): boolean {
  if (typeof value === 'string') {
    // Check the parsed value so UNC paths are detected before JSON escaping.
    return /(?:^|[\s"'=:,(])(?:[A-Za-z]:[\\/]|\\\\|[/](?![/\s]))[^"'<>\r\n\s]*/u.test(
      value,
    );
  }
  if (Array.isArray(value))
    return value.some((item) => containsAbsoluteLocalPath(item));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((nested) =>
      containsAbsoluteLocalPath(nested),
    );
  }
  return false;
}

function writeManifestDiagnostic(
  identity: AcceptanceManifestIdentity,
  code: string,
): void {
  process.stderr.write(
    `acceptance-manifest repo=${identity.project} artifact=${identity.artifactId} code=${code}\n`,
  );
}

function containsSensitiveEvidence(value: unknown, key?: string): boolean {
  if (
    key &&
    /^(?:raw(?:text|segments?|ocr)?|ocr(?:text|result|segments?)|source(?:text|excerpt)?|target(?:text)?|truth)$/iu.test(
      key,
    ) &&
    typeof value !== 'boolean' &&
    typeof value !== 'number' &&
    value !== null
  ) {
    return true;
  }
  if (Array.isArray(value))
    return value.some((item) => containsSensitiveEvidence(item));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([nestedKey, nested]) =>
      containsSensitiveEvidence(nested, nestedKey),
    );
  }
  return false;
}

export async function validateChildManifest(
  manifest: { status?: unknown; [key: string]: unknown } | undefined,
  item: AcceptanceProjectPlan,
  runId: string,
  recordVideo: boolean,
  requireCleanupComplete = true,
): Promise<boolean> {
  if (
    !manifest ||
    !validateTerminalManifest(manifest, item, runId, recordVideo) ||
    manifest.status !== 'completed'
  )
    return false;
  const fixture = manifest.fixture;
  if (!fixture || typeof fixture !== 'object') return false;
  const fixtureRecord = fixture as Record<string, unknown>;
  if (
    typeof fixtureRecord.name !== 'string' ||
    !fixtureRecord.name.trim() ||
    typeof fixtureRecord.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(fixtureRecord.sha256)
  )
    return false;
  if (requireCleanupComplete ? !validateCleanupEvidence(manifest.cleanup) : !isCleanupShape(manifest.cleanup)) return false;
  if (
    manifest.evidence !== undefined &&
    !sanitizeAcceptanceEvidence(manifest.evidence)
  )
    return false;
  for (const key of ['errors', 'consoleErrors', 'pageErrors']) {
    if (
      !Array.isArray(manifest[key]) ||
      (manifest[key] as unknown[]).length !== 0
    )
      return false;
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0)
    return false;
  const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
  for (const artifact of artifacts) {
    if (
      typeof artifact.path !== 'string' ||
      !artifact.path ||
      artifact.path.startsWith('/') ||
      /^[A-Za-z]:/u.test(artifact.path) ||
      artifact.path.split('/').includes('..') ||
      typeof artifact.bytes !== 'number' ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
      return false;
    const absolutePath = resolve(item.artifactRoot, artifact.path);
    const inside = relative(resolve(item.artifactRoot), absolutePath);
    if (
      !inside ||
      inside === '..' ||
      inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      /^[A-Za-z]:/u.test(inside)
    )
      return false;
    const metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata?.isFile() || metadata.size !== artifact.bytes) return false;
    const digest = createHash('sha256')
      .update(await readFile(absolutePath))
      .digest('hex');
    if (digest !== artifact.sha256) return false;
  }
  if (!artifacts.some((artifact) => artifact.kind === 'screenshot'))
    return false;
  if (
    recordVideo &&
    !artifacts.some(
      (artifact) =>
        artifact.kind === 'video' &&
        typeof artifact.path === 'string' &&
        artifact.path.endsWith('.webm'),
    )
  )
    return false;
  return true;
}

export function validateTerminalManifest(
  manifest: { status?: unknown; [key: string]: unknown } | undefined,
  item: AcceptanceProjectPlan,
  runId: string,
  recordVideo: boolean,
): boolean {
  if (
    !manifest ||
    (manifest.status !== 'completed' && manifest.status !== 'failed')
  )
    return false;
  if (manifest.schemaVersion !== 2) return false;
  if (
    manifest.project !== item.project ||
    manifest.runId !== runId ||
    manifest.recordVideo !== recordVideo
  )
    return false;
  if (!isCleanupShape(manifest.cleanup)) return false;
  for (const key of ['errors', 'consoleErrors', 'pageErrors']) {
    if (!Array.isArray(manifest[key])) return false;
  }
  return true;
}

export function validateCleanupEvidence(
  value: unknown,
): value is AcceptanceCleanup {
  if (!isCleanupShape(value)) return false;
  const cleanup = value as unknown as Record<string, unknown>;
  return (
    REQUIRED_CLEANUP_EVIDENCE.every((key) => cleanup[key] === true) &&
    Object.values(cleanup).every((entry) => entry === true)
  );
}

function isCleanupShape(value: unknown): value is AcceptanceCleanup {
  if (!value || typeof value !== 'object') return false;
  const cleanup = value as Record<string, unknown>;
  return Object.keys(cleanup).sort().join('|') === [...REQUIRED_CLEANUP_EVIDENCE].sort().join('|') && REQUIRED_CLEANUP_EVIDENCE.every((key) => typeof cleanup[key] === 'boolean');
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(runId)) {
    throw new Error('E2E_ACCEPTANCE_RUN_ID must be a safe non-empty run ID.');
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  try {
    await main();
  } catch {
    // Keep the three-project process boundary path-free and content-free even
    // when aggregate artifact persistence itself fails.
    process.stderr.write('three_project_acceptance_failed\n');
    process.exitCode = 1;
  }
}
