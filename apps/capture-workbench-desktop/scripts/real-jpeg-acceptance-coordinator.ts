import {
  spawn,
  type ChildProcess,
} from 'node:child_process';
import {
  constants as fsConstants,
  lstatSync,
  realpathSync,
} from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';

import { firstValueFrom } from 'rxjs';

// eslint-disable-next-line @nx/enforce-module-boundaries -- the coordinator delegates to the canonical workspace acceptance contract.
import { sha256File } from '../../../tools/acceptance-contract.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- the coordinator delegates typed capture-only environment policy to the canonical runner.
import {
  buildCaptureWorkbenchAcceptancePlan,
  createAcceptanceProcessStateProbe,
  type AcceptanceCleanupProbeState,
  type AcceptanceProcessIdentity,
} from '../../../tools/three-project-acceptance.ts';
import { assertStrictDescendant } from './contracts/installed.ts';
import { createTrackedProcessTreeTerminator } from './installed-process-cleanup.ts';
import {
  assertCanonicalAuthorityContainment,
  openFilesystemAuthority,
  type FilesystemAuthority,
  type FilesystemAuthorityFileAdapter,
  type FilesystemAuthorityFileStat,
} from './filesystem-authority.ts';
import {
  parseLocalCandidateModelDescriptor,
  verifyLocalCandidateModel,
  type LocalCandidateModelDescriptor,
} from './local-candidate-model.ts';
import { readVerifiedLocalCandidateCatalog } from './local-candidate-worker-mirror.ts';
import {
  createWindowsAcceptanceScopeProbe,
  type AcceptanceScopeProcessObservation,
  type AcceptanceScopeSnapshot,
} from './windows-acceptance-scope-probe.ts';

const READINESS_DEADLINE_MS = 30_000;
const READINESS_POLL_MS = 100;
const PRIVATE_ENVIRONMENT_PREFIXES = [
  'OLLAMA_',
  'CAPTURE_OLLAMA_',
  'J53_',
  'CAPTURE_J53_',
] as const;
type J53RequiredEnvironmentKey =
  | 'J53_WORKSPACE_ROOT'
  | 'J53_OWNERSHIP_ROOT'
  | 'J53_OWNED_ROOT'
  | 'J53_JPEG_PATH'
  | 'J53_INSTALLED_EXECUTABLE_PATH'
  | 'J53_INSTALLER_PROVENANCE_PATH'
  | 'J53_RUNTIME_CANDIDATE_ROOT'
  | 'J53_RUNTIME_CANDIDATE_ID'
  | 'J53_MODEL_SOURCE_ROOT'
  | 'J53_OLLAMA_EXECUTABLE_PATH'
  | 'J53_BASELINE_PORT'
  | 'J53_RUN_ID';
const BASELINE_PROCESS_NAMES = new Set([
  'ollama.exe',
  'ollama_llama_server.exe',
  'capture-runtime.exe',
]);

export type RealJpegAcceptanceFailureCode =
  | 'invalid_input'
  | 'authority_verification_failed'
  | 'projection_materialization_failed'
  | 'projection_verification_failed'
  | 'ambient_baseline_process_present'
  | 'baseline_port_preoccupied'
  | 'baseline_spawn_failed'
  | 'baseline_port_collision'
  | 'baseline_root_exited_before_ready'
  | 'baseline_readiness_invalid'
  | 'baseline_readiness_deadline_exceeded'
  | 'baseline_root_lost_before_canonical'
  | 'canonical_spawn_failed'
  | 'canonical_acceptance_failed'
  | 'baseline_not_preserved_after_canonical'
  | 'orchestration_failed';

export type RealJpegAcceptanceCleanupFailureCode =
  | 'baseline_cleanup_failed'
  | 'owned_root_cleanup_failed';

export interface RealJpegAcceptanceResult {
  readonly status: 'passed' | 'failed';
  readonly failureCode?: RealJpegAcceptanceFailureCode;
  readonly canonicalExitCode?: number;
  readonly projectionVerified: boolean;
  readonly baselinePreserved: boolean;
  readonly cleanupComplete: boolean;
  readonly cleanupFailureCode?: RealJpegAcceptanceCleanupFailureCode;
  readonly canonicalStarted: boolean;
}

export interface RealJpegAcceptanceInput {
  readonly workspaceRoot: string;
  readonly ownershipRoot: string;
  readonly ownedRoot: string;
  readonly jpegPath: string;
  readonly installedExecutablePath: string;
  readonly installerProvenancePath: string;
  readonly runtimeCandidateRoot: string;
  readonly runtimeCandidateId: string;
  readonly modelSourceRoot: string;
  readonly ollamaExecutablePath: string;
  readonly baselinePort: number;
  readonly runId: string;
  readonly parentEnvironment: Readonly<NodeJS.ProcessEnv>;
}

export interface RealJpegAcceptanceChildRequest {
  readonly kind: 'baseline' | 'canonical';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface RealJpegAcceptanceChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  waitForExit(): Promise<number>;
}

export interface RealJpegAcceptanceFileAdapter extends FilesystemAuthorityFileAdapter {
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Promise<string | undefined>;
  copyFile(source: string, target: string, mode?: number): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  rm(
    path: string,
    options: { readonly recursive: boolean; readonly force: boolean },
  ): Promise<void>;
}

export interface RealJpegAcceptanceHttpResult {
  readonly statusCode: number;
  readonly body: unknown;
}

export interface RealJpegAcceptanceAdapter {
  readonly coordinatorPid: number;
  readonly files: RealJpegAcceptanceFileAdapter;
  readonly nodeExecutable: string;
  now(): number;
  delay(milliseconds: number): Promise<void>;
  snapshot(): Promise<AcceptanceScopeSnapshot>;
  processState(
    identity: AcceptanceProcessIdentity,
  ): Promise<AcceptanceCleanupProbeState>;
  requestJson(url: string): Promise<RealJpegAcceptanceHttpResult>;
  spawnChild(
    request: RealJpegAcceptanceChildRequest,
  ): RealJpegAcceptanceChild | Promise<RealJpegAcceptanceChild>;
  terminateTrackedProcessTree(child: RealJpegAcceptanceChild): Promise<void>;
}

export interface RealJpegAcceptanceCliResult {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
}

export type RealJpegAcceptanceAdapterFactory = (
  input: RealJpegAcceptanceInput,
) => RealJpegAcceptanceAdapter;

interface ExecutionState {
  primaryFailure?: RealJpegAcceptanceFailureCode;
  canonicalExitCode?: number;
  projectionVerified: boolean;
  baselinePreserved: boolean;
  canonicalStarted: boolean;
}

interface BaselineOwnership {
  readonly root: AcceptanceProcessIdentity;
  readonly descendants: Map<number, AcceptanceProcessIdentity>;
}

interface BaselineCleanupResult {
  readonly clean: boolean;
  readonly foreignBaselineObserved: boolean;
}

type BaselineMode =
  | {
      readonly kind: 'external-observe-only';
      readonly root: AcceptanceProcessIdentity;
    }
  | { readonly kind: 'controlled' };

type PreexistingBaselineTopology =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'external';
      readonly root: AcceptanceProcessIdentity;
    }
  | { readonly kind: 'forbidden' };

class CoordinatorFailure extends Error {
  readonly code: RealJpegAcceptanceFailureCode;

  constructor(code: RealJpegAcceptanceFailureCode) {
    super(code);
    this.name = 'CoordinatorFailure';
    this.code = code;
  }
}

/**
 * Runs one fail-closed outer orchestration. The adapter replaces effects only;
 * environment, projection, ordering, readiness, identity and cleanup policy
 * all remain in this public function.
 */
export async function runRealJpegAcceptance(
  input: RealJpegAcceptanceInput,
  adapter: RealJpegAcceptanceAdapter,
): Promise<RealJpegAcceptanceResult> {
  const state: ExecutionState = {
    projectionVerified: false,
    baselinePreserved: false,
    canonicalStarted: false,
  };
  let cleanupFailureCode: RealJpegAcceptanceCleanupFailureCode | undefined;
  let ownedRoot: string | undefined;
  let ownedRootAuthority: FilesystemAuthority | undefined;
  let ownedRootCreated = false;
  let baselineChild: RealJpegAcceptanceChild | undefined;
  let baselineOwnership: BaselineOwnership | undefined;

  try {
    validateInput(input);
    ownedRoot = assertStrictDescendant(
      input.ownershipRoot,
      input.ownedRoot,
      'J53 owned root',
    );
    const initialScope = await adapter.snapshot();
    const initialTopology = classifyPreexistingBaseline(
      initialScope,
      input.ollamaExecutablePath,
      adapter.coordinatorPid,
    );
    if (initialTopology.kind === 'forbidden') {
      state.primaryFailure = 'ambient_baseline_process_present';
    } else {
      const commitScope = await adapter.snapshot();
      const committed = commitBaselineMode(
        initialTopology,
        classifyPreexistingBaseline(
          commitScope,
          input.ollamaExecutablePath,
          adapter.coordinatorPid,
        ),
      );
      if ('failureCode' in committed) {
        state.primaryFailure = committed.failureCode;
      } else if (
        committed.mode.kind === 'controlled' &&
        listenersForPort(commitScope, input.baselinePort).length > 0
      ) {
        state.primaryFailure = 'baseline_port_preoccupied';
      } else {
        const projectionRoot = await createVerifiedProjection(
          input,
          ownedRoot,
          adapter.files,
          (authority) => {
            ownedRootCreated = true;
            ownedRootAuthority = authority;
          },
        );
        state.projectionVerified = true;
        let canonicalEnvironment: NodeJS.ProcessEnv;
        try {
          // Resolve the canonical runner contract before any process side effect.
          // This keeps its typed nine-key resolver as the sole source of truth.
          canonicalEnvironment = buildCanonicalEnvironment(
            input,
            projectionRoot,
          );
        } catch {
          throw new CoordinatorFailure('invalid_input');
        }

        if (committed.mode.kind === 'external-observe-only') {
          const externalReady = await observeExternalBaseline(
            committed.mode.root,
            input.ollamaExecutablePath,
            adapter,
          );
          if (!externalReady) {
            state.primaryFailure = 'baseline_root_lost_before_canonical';
          } else {
            await runCanonicalAcceptance(
              input,
              canonicalEnvironment,
              adapter,
              state,
            );
            if (state.canonicalStarted) {
              state.baselinePreserved = await observeExternalBaseline(
                committed.mode.root,
                input.ollamaExecutablePath,
                adapter,
              );
              if (!state.baselinePreserved && !state.primaryFailure) {
                state.primaryFailure = 'baseline_not_preserved_after_canonical';
              }
            }
          }
        } else {
          const baselineModelsRoot = await createBaselineModelsRoot(
            ownedRootAuthority,
            adapter.files,
          );

          const baselineEnvironment = buildBaselineEnvironment(
            input.parentEnvironment,
            input.baselinePort,
            baselineModelsRoot,
          );
          try {
            baselineChild = await adapter.spawnChild({
              kind: 'baseline',
              command: input.ollamaExecutablePath,
              args: ['serve'],
              cwd: input.workspaceRoot,
              environment: baselineEnvironment,
            });
          } catch {
            state.primaryFailure = 'baseline_spawn_failed';
          }

          if (baselineChild && !state.primaryFailure) {
            const readiness = await waitForBaselineReadiness(
              input,
              baselineChild,
              adapter,
            );
            if ('failureCode' in readiness) {
              state.primaryFailure = readiness.failureCode;
              baselineOwnership = readiness.ownership;
            } else {
              baselineOwnership = readiness.ownership;
            }
          }

          if (baselineChild && baselineOwnership && !state.primaryFailure) {
            const beforeCanonical = await adapter.processState(baselineOwnership.root);
            const scope = await adapter.snapshot();
            const currentOwnership = observeBaselineOwnership(
              scope,
              baselineOwnership.root,
            );
            const currentListeners = listenersForPort(scope, input.baselinePort);
            if (
              currentOwnership &&
              containsForeignBaseline(scope, currentOwnership)
            ) {
              state.primaryFailure = 'ambient_baseline_process_present';
            } else if (
              beforeCanonical !== 'present' ||
              !currentOwnership ||
              currentListeners.length === 0 ||
              currentListeners.some(
                (listener) =>
                  !isOwnedListenerPid(currentOwnership, listener.owningPid),
              )
            ) {
              state.primaryFailure = 'baseline_root_lost_before_canonical';
            } else {
              mergeDescendants(baselineOwnership, currentOwnership);
              await runCanonicalAcceptance(
                input,
                canonicalEnvironment,
                adapter,
                state,
              );
              if (state.canonicalStarted) {
                const preserved = await adapter.processState(baselineOwnership.root);
                const finalScope = await adapter.snapshot();
                const finalOwnership = observeBaselineOwnership(
                  finalScope,
                  baselineOwnership.root,
                );
                state.baselinePreserved =
                  preserved === 'present' && finalOwnership !== undefined;
                if (
                  finalOwnership &&
                  containsForeignBaseline(finalScope, finalOwnership) &&
                  !state.primaryFailure
                ) {
                  state.primaryFailure = 'ambient_baseline_process_present';
                }
                if (!state.baselinePreserved && !state.primaryFailure) {
                  state.primaryFailure = 'baseline_not_preserved_after_canonical';
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    state.primaryFailure ??= error instanceof CoordinatorFailure
      ? error.code
      : state.projectionVerified
        ? 'orchestration_failed'
        : 'authority_verification_failed';
  } finally {
    if (baselineChild) {
      const baselineCleanup = await cleanupBaseline(
        baselineChild,
        baselineOwnership,
        input.baselinePort,
        adapter,
      );
      if (baselineCleanup.foreignBaselineObserved && !state.primaryFailure) {
        state.primaryFailure = 'ambient_baseline_process_present';
      }
      if (!baselineCleanup.clean) cleanupFailureCode = 'baseline_cleanup_failed';
    }
    if (ownedRoot && ownedRootCreated && cleanupFailureCode === undefined) {
      if (!(await removeOwnedRoot(ownedRootAuthority, adapter.files))) {
        cleanupFailureCode = 'owned_root_cleanup_failed';
      }
    }
  }

  const cleanupComplete = cleanupFailureCode === undefined;
  const status = state.primaryFailure || !cleanupComplete ? 'failed' : 'passed';
  return {
    status,
    ...(state.primaryFailure ? { failureCode: state.primaryFailure } : {}),
    ...(state.canonicalExitCode === undefined
      ? {}
      : { canonicalExitCode: state.canonicalExitCode }),
    projectionVerified: state.projectionVerified,
    baselinePreserved: state.baselinePreserved,
    cleanupComplete,
    ...(cleanupFailureCode ? { cleanupFailureCode } : {}),
    canonicalStarted: state.canonicalStarted,
  };
}

function validateInput(input: RealJpegAcceptanceInput): void {
  const requiredText = [
    input.workspaceRoot,
    input.ownershipRoot,
    input.ownedRoot,
    input.jpegPath,
    input.installedExecutablePath,
    input.installerProvenancePath,
    input.runtimeCandidateRoot,
    input.runtimeCandidateId,
    input.modelSourceRoot,
    input.ollamaExecutablePath,
    input.runId,
  ];
  if (
    requiredText.some(
      (value) => typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value),
    ) ||
    !Number.isSafeInteger(input.baselinePort) ||
    input.baselinePort < 1 ||
    input.baselinePort > 65_535
  ) {
    throw new CoordinatorFailure('invalid_input');
  }
}

async function createVerifiedProjection(
  input: RealJpegAcceptanceInput,
  ownedRoot: string,
  files: RealJpegAcceptanceFileAdapter,
  onOwnedRootCreated: (authority: FilesystemAuthority) => void,
): Promise<string> {
  const existing = await files.lstat(ownedRoot).catch(() => undefined);
  if (existing) throw new CoordinatorFailure('projection_materialization_failed');
  let ownershipAuthority: FilesystemAuthority;
  let ownedParentAuthority: FilesystemAuthority;
  let createdOwnedRootAuthority: FilesystemAuthority;
  try {
    ownershipAuthority = await openFilesystemAuthority(
      input.ownershipRoot,
      files,
      'J53 ownership root',
    );
    ownedParentAuthority = await openFilesystemAuthority(
      dirname(ownedRoot),
      files,
      'J53 owned-root parent',
    );
    assertCanonicalAuthorityContainment(
      ownershipAuthority,
      ownedParentAuthority,
      'J53 owned-root parent',
    );
  } catch {
    throw new CoordinatorFailure('projection_materialization_failed');
  }
  let descriptor: LocalCandidateModelDescriptor;
  try {
    const catalog = await readVerifiedLocalCandidateCatalog({
      candidateRoot: input.runtimeCandidateRoot,
      candidateId: input.runtimeCandidateId,
      requirementId: 'windowsml-ocr',
    });
    descriptor = parseLocalCandidateModelDescriptor(
      catalog.requirement.modelFiles,
    );
  } catch {
    throw new CoordinatorFailure('authority_verification_failed');
  }
  try {
    await files.mkdir(ownedRoot, { recursive: false });
    createdOwnedRootAuthority = await openFilesystemAuthority(
      ownedRoot,
      files,
      'J53 owned root',
    );
    assertCanonicalAuthorityContainment(
      ownershipAuthority,
      createdOwnedRootAuthority,
      'J53 owned root',
    );
    onOwnedRootCreated(createdOwnedRootAuthority);
  } catch {
    throw new CoordinatorFailure('projection_materialization_failed');
  }
  const temporaryRoot = createdOwnedRootAuthority.child(
    join(createdOwnedRootAuthority.canonicalRoot, 'model-projection.partial'),
    'Temporary model projection',
  );
  const projectionRoot = createdOwnedRootAuthority.child(
    join(createdOwnedRootAuthority.canonicalRoot, 'model-projection'),
    'Model projection',
  );
  try {
    await materializeDescriptorProjection(
      input.modelSourceRoot,
      temporaryRoot,
      descriptor,
      files,
    );
    await files.rename(temporaryRoot, projectionRoot);
  } catch {
    throw new CoordinatorFailure('projection_materialization_failed');
  }
  try {
    const projectionAuthority = await openFilesystemAuthority(
      projectionRoot,
      files,
      'Model projection',
    );
    assertCanonicalAuthorityContainment(
      createdOwnedRootAuthority,
      projectionAuthority,
      'Model projection',
    );
    await assertProjectionControlFileAbsent(projectionRoot, files);
    await verifyLocalCandidateModel({
      candidateRoot: input.runtimeCandidateRoot,
      candidateId: input.runtimeCandidateId,
      requirementId: 'windowsml-ocr',
      modelRoot: projectionRoot,
    });
  } catch {
    throw new CoordinatorFailure('projection_verification_failed');
  }
  return projectionRoot;
}

async function assertProjectionControlFileAbsent(
  projectionRoot: string,
  files: RealJpegAcceptanceFileAdapter,
): Promise<void> {
  const controlFile = assertStrictDescendant(
    projectionRoot,
    join(projectionRoot, 'transport-manifest.json'),
    'Projection control file',
  );
  try {
    await files.lstat(controlFile);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new Error('real_jpeg_acceptance_projection_control_file_present');
}

async function materializeDescriptorProjection(
  sourceRootInput: string,
  temporaryRoot: string,
  descriptor: LocalCandidateModelDescriptor,
  files: RealJpegAcceptanceFileAdapter,
): Promise<void> {
  const sourceAuthority = await openFilesystemAuthority(
    sourceRootInput,
    files,
    'Descriptor source root',
  );
  await files.mkdir(temporaryRoot, { recursive: false });
  const temporaryAuthority = await openFilesystemAuthority(
    temporaryRoot,
    files,
    'Temporary model projection',
  );
  let copiedBytes = 0;
  for (const descriptorFile of descriptor.files) {
    const source = sourceAuthority.child(
      join(sourceAuthority.canonicalRoot, ...descriptorFile.path.split('/')),
      'Descriptor source file',
    );
    const target = temporaryAuthority.child(
      join(temporaryAuthority.canonicalRoot, ...descriptorFile.path.split('/')),
      'Descriptor projection file',
    );
    const canonicalSource = await sourceAuthority.resolveFile(
      source,
      'Canonical descriptor source file',
    );
    const sourceMetadata = await files.lstat(canonicalSource);
    if (
      !sourceMetadata.isFile() ||
      sourceMetadata.isSymbolicLink() ||
      sourceMetadata.size !== descriptorFile.bytes
    ) {
      throw new Error('real_jpeg_acceptance_source_file_invalid');
    }
    if (await sha256File(canonicalSource) !== descriptorFile.sha256) {
      throw new Error('real_jpeg_acceptance_source_file_digest_invalid');
    }
    const targetParent = dirname(target);
    await files.mkdir(targetParent, { recursive: true });
    await temporaryAuthority.resolveDirectory(
      targetParent,
      'Projection parent directory',
    );
    await files.copyFile(canonicalSource, target, fsConstants.COPYFILE_EXCL);
    await temporaryAuthority.resolveFile(target, 'Descriptor projection file');
    copiedBytes += descriptorFile.bytes;
  }
  if (copiedBytes !== descriptor.extractedBytes) {
    throw new Error('real_jpeg_acceptance_projection_bytes_invalid');
  }
}

async function createBaselineModelsRoot(
  ownedRoot: FilesystemAuthority | undefined,
  files: RealJpegAcceptanceFileAdapter,
): Promise<string> {
  if (!ownedRoot) {
    throw new CoordinatorFailure('projection_materialization_failed');
  }
  const baselineModelsRoot = assertStrictDescendant(
    ownedRoot.canonicalRoot,
    join(ownedRoot.canonicalRoot, 'baseline-ollama-models'),
    'Baseline Ollama models directory',
  );
  try {
    await files.mkdir(baselineModelsRoot, { recursive: false });
    const authority = await openFilesystemAuthority(
      baselineModelsRoot,
      files,
      'Baseline Ollama models directory',
    );
    assertCanonicalAuthorityContainment(
      ownedRoot,
      authority,
      'Baseline Ollama models directory',
    );
    return authority.canonicalRoot;
  } catch {
    throw new CoordinatorFailure('projection_materialization_failed');
  }
}

function buildBaselineEnvironment(
  parent: Readonly<NodeJS.ProcessEnv>,
  port: number,
  projectionRoot: string,
): NodeJS.ProcessEnv {
  const environment = scrubPrivateEnvironment(parent, true);
  environment.OLLAMA_HOST = `http://127.0.0.1:${String(port)}`;
  environment.OLLAMA_MODELS = projectionRoot;
  return environment;
}

function buildCanonicalEnvironment(
  input: RealJpegAcceptanceInput,
  projectionRoot: string,
): NodeJS.ProcessEnv {
  const inherited = scrubPrivateEnvironment(input.parentEnvironment, false);
  Object.assign(inherited, {
    CAPTURE_REAL_DESKTOP_OCR_INPUT: input.jpegPath,
    CAPTURE_REAL_DESKTOP_EXECUTABLE: input.installedExecutablePath,
    CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE: input.installerProvenancePath,
    CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE: 'windowsml-dml',
    CAPTURE_REAL_DESKTOP_TEARDOWN: 'window-close',
    CAPTURE_RUNTIME_CANDIDATE_ROOT: input.runtimeCandidateRoot,
    CAPTURE_RUNTIME_CANDIDATE_ID: input.runtimeCandidateId,
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: '1',
    CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: projectionRoot,
  });
  return buildCaptureWorkbenchAcceptancePlan(
    input.workspaceRoot,
    input.runId,
    false,
    inherited,
  ).environment;
}

function scrubPrivateEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  scrubCaptureEnvironment: boolean,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (
      PRIVATE_ENVIRONMENT_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
      (scrubCaptureEnvironment &&
        (upper.startsWith('CAPTURE_') || upper.startsWith('E2E_')))
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

async function runCanonicalAcceptance(
  input: RealJpegAcceptanceInput,
  environment: NodeJS.ProcessEnv,
  adapter: RealJpegAcceptanceAdapter,
  state: ExecutionState,
): Promise<void> {
  let child: RealJpegAcceptanceChild;
  try {
    child = await adapter.spawnChild({
      kind: 'canonical',
      command: adapter.nodeExecutable,
      args: [
        'tools/three-project-acceptance.ts',
        '--capture-workbench-only',
      ],
      cwd: resolve(input.workspaceRoot),
      environment,
    });
    state.canonicalStarted = true;
  } catch {
    state.primaryFailure = 'canonical_spawn_failed';
    return;
  }
  try {
    state.canonicalExitCode = await child.waitForExit();
  } catch {
    state.canonicalExitCode = 1;
  }
  if (state.canonicalExitCode !== 0) {
    state.primaryFailure = 'canonical_acceptance_failed';
  }
}

async function waitForBaselineReadiness(
  input: RealJpegAcceptanceInput,
  child: RealJpegAcceptanceChild,
  adapter: RealJpegAcceptanceAdapter,
): Promise<
  | { readonly ownership: BaselineOwnership }
  | {
      readonly failureCode:
        | 'baseline_port_collision'
        | 'ambient_baseline_process_present'
        | 'baseline_root_exited_before_ready'
        | 'baseline_readiness_invalid'
        | 'baseline_readiness_deadline_exceeded';
      readonly ownership?: BaselineOwnership;
    }
> {
  if (!Number.isSafeInteger(child.pid) || Number(child.pid) < 1) {
    return { failureCode: 'baseline_root_exited_before_ready' };
  }
  const deadline = adapter.now() + READINESS_DEADLINE_MS;
  let ownership: BaselineOwnership | undefined;
  while (adapter.now() <= deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { failureCode: 'baseline_root_exited_before_ready', ownership };
    }
    const scope = await adapter.snapshot();
    const observedRoot = scope.processes.find(
      (process) =>
        process.pid === child.pid &&
        process.parentPid === adapter.coordinatorPid &&
        samePath(process.executable, input.ollamaExecutablePath),
    );
    let currentOwnership: BaselineOwnership | undefined;
    if (ownership) {
      const current = observeBaselineOwnership(scope, ownership.root);
      if (!current) {
        return { failureCode: 'baseline_root_exited_before_ready', ownership };
      }
      currentOwnership = current;
      mergeDescendants(ownership, current);
    } else if (observedRoot) {
      ownership = ownershipFromRoot(scope, observedRoot);
      currentOwnership = ownership;
    } else if (scope.processes.some((process) => process.pid === child.pid)) {
      return { failureCode: 'baseline_root_exited_before_ready' };
    }
    if (containsForeignBaseline(scope, currentOwnership)) {
      return { failureCode: 'ambient_baseline_process_present', ownership };
    }

    const listeners = listenersForPort(scope, input.baselinePort);
    if (listeners.length > 0) {
      if (
        !currentOwnership ||
        listeners.some(
          (listener) =>
            !isOwnedListenerPid(currentOwnership, listener.owningPid),
        )
      ) {
        return { failureCode: 'baseline_port_collision', ownership };
      }
      let response: RealJpegAcceptanceHttpResult;
      try {
        response = await adapter.requestJson(
          `http://127.0.0.1:${String(input.baselinePort)}/api/tags`,
        );
      } catch {
        return { failureCode: 'baseline_readiness_invalid', ownership };
      }
      if (
        response.statusCode !== 200 ||
        !isRecord(response.body) ||
        !Array.isArray(response.body.models)
      ) {
        return { failureCode: 'baseline_readiness_invalid', ownership };
      }
      const confirmedScope = await adapter.snapshot();
      const confirmed = observeBaselineOwnership(confirmedScope, ownership.root);
      const confirmedListeners = listenersForPort(
        confirmedScope,
        input.baselinePort,
      );
      if (!confirmed) {
        return { failureCode: 'baseline_root_exited_before_ready', ownership };
      }
      if (containsForeignBaseline(confirmedScope, confirmed)) {
        return {
          failureCode: 'ambient_baseline_process_present',
          ownership,
        };
      }
      if (
        confirmedListeners.length === 0 ||
        confirmedListeners.some(
          (listener) =>
            !isOwnedListenerPid(confirmed, listener.owningPid),
        )
      ) {
        return { failureCode: 'baseline_port_collision', ownership };
      }
      mergeDescendants(ownership, confirmed);
      return { ownership };
    }
    if (adapter.now() >= deadline) break;
    await adapter.delay(READINESS_POLL_MS);
  }
  return { failureCode: 'baseline_readiness_deadline_exceeded', ownership };
}

function classifyPreexistingBaseline(
  scope: AcceptanceScopeSnapshot,
  authorizedExecutable: string,
  coordinatorPid: number,
): PreexistingBaselineTopology {
  const coordinatorDescendants = descendantPids(scope, coordinatorPid);
  const baselineProcesses = scope.processes.filter(isBaselineProcess);
  if (baselineProcesses.length === 0) return { kind: 'none' };
  const authorizedRoots = baselineProcesses.filter(
    (process) =>
      process.name.trim().toLowerCase() === 'ollama.exe' &&
      basename(process.executable).trim().toLowerCase() === 'ollama.exe' &&
      samePath(process.executable, authorizedExecutable) &&
      isLockableIdentity(process) &&
      !coordinatorDescendants.has(process.pid),
  );
  if (authorizedRoots.length !== 1) return { kind: 'forbidden' };
  const root = authorizedRoots[0];
  const selectedDescendants = descendantPids(scope, root.pid);
  const validTopology = baselineProcesses.every(
    (process) =>
      process === root ||
      (process.name.trim().toLowerCase() === 'ollama_llama_server.exe' &&
        basename(process.executable).trim().toLowerCase() ===
          'ollama_llama_server.exe' &&
        isLockableIdentity(process) &&
        selectedDescendants.has(process.pid)),
  );
  return validTopology
    ? { kind: 'external', root: identityOf(root) }
    : { kind: 'forbidden' };
}

function commitBaselineMode(
  initial: PreexistingBaselineTopology,
  current: PreexistingBaselineTopology,
):
  | { readonly mode: BaselineMode }
  | {
      readonly failureCode:
        | 'ambient_baseline_process_present'
        | 'baseline_root_lost_before_canonical';
    } {
  if (initial.kind === 'forbidden') {
    return { failureCode: 'ambient_baseline_process_present' };
  }
  if (initial.kind === 'external') {
    return current.kind === 'external' && sameIdentity(current.root, initial.root)
      ? { mode: { kind: 'external-observe-only', root: initial.root } }
      : { failureCode: 'baseline_root_lost_before_canonical' };
  }
  if (current.kind === 'forbidden') {
    return { failureCode: 'ambient_baseline_process_present' };
  }
  return current.kind === 'external'
    ? { mode: { kind: 'external-observe-only', root: current.root } }
    : { mode: { kind: 'controlled' } };
}

async function observeExternalBaseline(
  selected: AcceptanceProcessIdentity,
  authorizedExecutable: string,
  adapter: RealJpegAcceptanceAdapter,
): Promise<boolean> {
  if ((await adapter.processState(selected)) !== 'present') return false;
  const topology = classifyPreexistingBaseline(
    await adapter.snapshot(),
    authorizedExecutable,
    adapter.coordinatorPid,
  );
  return topology.kind === 'external' && sameIdentity(topology.root, selected);
}

function descendantPids(
  scope: AcceptanceScopeSnapshot,
  rootPid: number,
): Set<number> {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of scope.processes) {
      if (
        process.parentPid !== undefined &&
        (process.parentPid === rootPid || descendants.has(process.parentPid)) &&
        !descendants.has(process.pid)
      ) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return descendants;
}

function isBaselineProcess(
  process: AcceptanceScopeProcessObservation,
): boolean {
  return (
    BASELINE_PROCESS_NAMES.has(process.name.trim().toLowerCase()) ||
    BASELINE_PROCESS_NAMES.has(
      basename(process.executable).trim().toLowerCase(),
    )
  );
}

function isLockableIdentity(
  process: AcceptanceScopeProcessObservation,
): boolean {
  return (
    Number.isSafeInteger(process.pid) &&
    process.pid > 0 &&
    process.creationTimeUtc.trim().length > 0 &&
    process.executable.trim().length > 0
  );
}

function listenersForPort(scope: AcceptanceScopeSnapshot, port: number) {
  return scope.listeners.filter((listener) => listener.port === port);
}

function ownershipFromRoot(
  scope: AcceptanceScopeSnapshot,
  root: AcceptanceScopeProcessObservation,
): BaselineOwnership {
  const ownership: BaselineOwnership = {
    root: identityOf(root),
    descendants: new Map(),
  };
  addDescendants(scope, ownership);
  return ownership;
}

function observeBaselineOwnership(
  scope: AcceptanceScopeSnapshot,
  root: AcceptanceProcessIdentity,
): BaselineOwnership | undefined {
  const observed = scope.processes.find((process) => sameIdentity(process, root));
  return observed ? ownershipFromRoot(scope, observed) : undefined;
}

function addDescendants(
  scope: AcceptanceScopeSnapshot,
  ownership: BaselineOwnership,
): void {
  const ownedPids = new Set([ownership.root.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of scope.processes) {
      if (
        process.parentPid !== undefined &&
        ownedPids.has(process.parentPid) &&
        !ownedPids.has(process.pid)
      ) {
        ownedPids.add(process.pid);
        ownership.descendants.set(process.pid, identityOf(process));
        changed = true;
      }
    }
  }
}

function mergeDescendants(
  target: BaselineOwnership,
  observed: BaselineOwnership,
): void {
  for (const [pid, identity] of observed.descendants) {
    target.descendants.set(pid, identity);
  }
}

function isOwnedListenerPid(
  ownership: BaselineOwnership,
  pid: number,
): boolean {
  return pid === ownership.root.pid || ownership.descendants.has(pid);
}

function isOwnedProcess(
  ownership: BaselineOwnership,
  process: AcceptanceScopeProcessObservation,
): boolean {
  return sameIdentity(process, ownership.root) ||
    [...ownership.descendants.values()].some((identity) =>
      sameIdentity(process, identity)
    );
}

function containsForeignBaseline(
  scope: AcceptanceScopeSnapshot,
  ownership: BaselineOwnership | undefined,
): boolean {
  return scope.processes.some(
    (process) =>
      isBaselineProcess(process) &&
      (!ownership || !isOwnedProcess(ownership, process)),
  );
}

async function cleanupBaseline(
  child: RealJpegAcceptanceChild,
  ownership: BaselineOwnership | undefined,
  baselinePort: number,
  adapter: RealJpegAcceptanceAdapter,
): Promise<BaselineCleanupResult> {
  const currentOwnership = ownership;
  let foreignBaselineObserved = false;
  try {
    if (!currentOwnership) {
      // A PID is not an identity. If no executable + creation identity was
      // captured while the child was known-owned, never adopt a later process
      // merely because the operating system reused the numeric PID. A terminal
      // root is not sufficient either: an unrecorded helper may have survived.
      return { clean: false, foreignBaselineObserved };
    }
    const scope = await adapter.snapshot();
    const current = observeBaselineOwnership(scope, currentOwnership.root);
    if (current) mergeDescendants(currentOwnership, current);
    foreignBaselineObserved = containsForeignBaseline(scope, currentOwnership);
    const rootState = await adapter.processState(currentOwnership.root);
    if (rootState === 'absent') {
      if (child.exitCode === null && child.signalCode === null) {
        return { clean: false, foreignBaselineObserved };
      }
      const descendantStates = await Promise.all(
        [...currentOwnership.descendants.values()].map((identity) =>
          adapter.processState(identity),
        ),
      );
      const port = await inspectReleasedBaselinePort(
        baselinePort,
        currentOwnership,
        adapter,
      );
      return {
        clean:
          descendantStates.every((state) => state === 'absent') && port.released,
        foreignBaselineObserved:
          foreignBaselineObserved || port.foreignBaselineObserved,
      };
    }
    if (rootState !== 'present') {
      return { clean: false, foreignBaselineObserved };
    }
    await adapter.terminateTrackedProcessTree(child);
    const identities = [
      currentOwnership.root,
      ...currentOwnership.descendants.values(),
    ];
    const states = await Promise.all(
      identities.map((identity) => adapter.processState(identity)),
    );
    const port = await inspectReleasedBaselinePort(
      baselinePort,
      currentOwnership,
      adapter,
    );
    return {
      clean: states.every((state) => state === 'absent') && port.released,
      foreignBaselineObserved:
        foreignBaselineObserved || port.foreignBaselineObserved,
    };
  } catch {
    return { clean: false, foreignBaselineObserved };
  }
}

async function inspectReleasedBaselinePort(
  baselinePort: number,
  ownership: BaselineOwnership,
  adapter: RealJpegAcceptanceAdapter,
): Promise<{
  readonly released: boolean;
  readonly foreignBaselineObserved: boolean;
}> {
  try {
    const scope = await adapter.snapshot();
    return {
      released: listenersForPort(scope, baselinePort).length === 0,
      foreignBaselineObserved: containsForeignBaseline(scope, ownership),
    };
  } catch {
    return { released: false, foreignBaselineObserved: false };
  }
}

async function removeOwnedRoot(
  ownedRoot: FilesystemAuthority | undefined,
  files: RealJpegAcceptanceFileAdapter,
): Promise<boolean> {
  if (!ownedRoot) return false;
  const ownedRootPath = ownedRoot.lexicalRoot;
  let metadata: FilesystemAuthorityFileStat;
  try {
    metadata = await files.lstat(ownedRootPath);
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
  try {
    const canonical = await ownedRoot.resolveDirectory(
      ownedRootPath,
      'J53 owned root',
    );
    if (!samePath(canonical, ownedRoot.canonicalRoot)) return false;
    await files.rm(ownedRootPath, { recursive: true, force: true });
  } catch {
    return false;
  }
  try {
    await files.lstat(ownedRootPath);
    return false;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
}

function identityOf(
  process: AcceptanceScopeProcessObservation,
): AcceptanceProcessIdentity {
  return {
    pid: process.pid,
    creationTimeUtc: process.creationTimeUtc,
    executable: process.executable,
  };
}

function sameIdentity(
  observed: AcceptanceProcessIdentity,
  expected: AcceptanceProcessIdentity,
): boolean {
  return (
    observed.pid === expected.pid &&
    samePath(observed.executable, expected.executable) &&
    observed.creationTimeUtc === expected.creationTimeUtc
  );
}

function samePath(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  return process.platform === 'win32'
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function createProductionAdapter(
  input: RealJpegAcceptanceInput,
): RealJpegAcceptanceAdapter {
  const processProbe = createAcceptanceProcessStateProbe();
  const scopeProbe = createWindowsAcceptanceScopeProbe();
  const rawChildren = new WeakMap<RealJpegAcceptanceChild, ChildProcess>();
  const terminate = createTrackedProcessTreeTerminator({
    smokeRoot: input.ownedRoot,
    workspaceRoot: input.workspaceRoot,
    baseChildEnvironment: () => systemChildEnvironment(input.parentEnvironment),
    windowsSystemExecutable,
  });
  return {
    coordinatorPid: process.pid,
    files: { copyFile, lstat, mkdir, realpath, rename, rm },
    nodeExecutable: process.execPath,
    now: () => Date.now(),
    delay: (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    snapshot: () => scopeProbe.snapshot(),
    processState: processProbe,
    requestJson,
    spawnChild: (request) =>
      new Promise<RealJpegAcceptanceChild>((resolveChild, rejectSpawn) => {
        const raw = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: request.environment,
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        });
        let spawned = false;
        let terminalExitCode: number | null = null;
        let terminalSignal: NodeJS.Signals | null = null;
        let resolveExit: (code: number) => void = () => undefined;
        const exit = new Promise<number>((resolvePromise) => {
          resolveExit = resolvePromise;
        });
        raw.once('error', (error) => {
          terminalExitCode = 1;
          resolveExit(1);
          if (!spawned) rejectSpawn(error);
        });
        raw.once('exit', (code, signal) => {
          terminalExitCode = code ?? 1;
          terminalSignal = signal;
          resolveExit(code ?? 1);
        });
        raw.once('spawn', () => {
          spawned = true;
          const child: RealJpegAcceptanceChild = {
            get pid() {
              return raw.pid;
            },
            get exitCode() {
              return terminalExitCode ?? raw.exitCode;
            },
            get signalCode() {
              return terminalSignal ?? raw.signalCode;
            },
            waitForExit: () => exit,
          };
          rawChildren.set(child, raw);
          resolveChild(child);
        });
      }),
    terminateTrackedProcessTree: async (child) => {
      const raw = rawChildren.get(child);
      if (!raw) throw new Error('real_jpeg_acceptance_child_not_tracked');
      await firstValueFrom(terminate(raw, 'controlled_ollama_baseline'));
    },
  };
}

function requestJson(url: string): Promise<RealJpegAcceptanceHttpResult> {
  return new Promise((resolvePromise, reject) => {
    const request = requestHttp(url, { method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          response.destroy(new Error('real_jpeg_acceptance_readiness_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          });
        } catch {
          reject(new Error('real_jpeg_acceptance_readiness_json_invalid'));
        }
      });
    });
    request.setTimeout(2_000, () => {
      request.destroy(new Error('real_jpeg_acceptance_readiness_timeout'));
    });
    request.once('error', reject);
    request.end();
  });
}

function windowsSystemExecutable(...segments: string[]): string {
  const root = environmentValue(process.env, 'SystemRoot') ??
    environmentValue(process.env, 'WINDIR');
  if (!root) throw new Error('real_jpeg_acceptance_windows_root_unavailable');
  const executable = join(root, ...segments);
  const metadata = lstatSync(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('real_jpeg_acceptance_windows_executable_invalid');
  }
  const canonical = realpathSync(executable);
  if (!samePath(canonical, executable)) {
    throw new Error('real_jpeg_acceptance_windows_executable_linked');
  }
  return canonical;
}

function systemChildEnvironment(
  parent: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
  ]) {
    const value = environmentValue(parent, key);
    if (value) result[key] = value;
  }
  return result;
}

function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const entry = Object.entries(environment).find(
    ([key, value]) => key.toUpperCase() === name.toUpperCase() && value,
  );
  return entry?.[1];
}

function requiredEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: J53RequiredEnvironmentKey,
): string {
  const matches = Object.entries(environment).filter(
    ([key]) => key.toUpperCase() === name,
  );
  if (matches.length !== 1) {
    throw new Error('real_jpeg_acceptance_configuration_invalid');
  }
  const value = matches[0]?.[1];
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    containsControlCharacter(value)
  ) {
    throw new Error('real_jpeg_acceptance_configuration_invalid');
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function requiredPort(
  environment: Readonly<NodeJS.ProcessEnv>,
): number {
  const raw = requiredEnvironment(environment, 'J53_BASELINE_PORT');
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error('real_jpeg_acceptance_configuration_invalid');
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('real_jpeg_acceptance_configuration_invalid');
  }
  return port;
}

function inputFromEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): RealJpegAcceptanceInput {
  return {
    workspaceRoot: requiredEnvironment(environment, 'J53_WORKSPACE_ROOT'),
    ownershipRoot: requiredEnvironment(environment, 'J53_OWNERSHIP_ROOT'),
    ownedRoot: requiredEnvironment(environment, 'J53_OWNED_ROOT'),
    jpegPath: requiredEnvironment(environment, 'J53_JPEG_PATH'),
    installedExecutablePath: requiredEnvironment(
      environment,
      'J53_INSTALLED_EXECUTABLE_PATH',
    ),
    installerProvenancePath: requiredEnvironment(
      environment,
      'J53_INSTALLER_PROVENANCE_PATH',
    ),
    runtimeCandidateRoot: requiredEnvironment(
      environment,
      'J53_RUNTIME_CANDIDATE_ROOT',
    ),
    runtimeCandidateId: requiredEnvironment(
      environment,
      'J53_RUNTIME_CANDIDATE_ID',
    ),
    modelSourceRoot: requiredEnvironment(environment, 'J53_MODEL_SOURCE_ROOT'),
    ollamaExecutablePath: requiredEnvironment(
      environment,
      'J53_OLLAMA_EXECUTABLE_PATH',
    ),
    baselinePort: requiredPort(environment),
    runId: requiredEnvironment(environment, 'J53_RUN_ID'),
    parentEnvironment: { ...environment },
  };
}

export async function runRealJpegAcceptanceCli(
  environment: Readonly<NodeJS.ProcessEnv>,
  adapterFactory: RealJpegAcceptanceAdapterFactory,
): Promise<RealJpegAcceptanceCliResult> {
  try {
    const input = inputFromEnvironment(environment);
    const result = await runRealJpegAcceptance(input, adapterFactory(input));
    return {
      exitCode: result.status === 'passed' ? 0 : 1,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: '',
    };
  } catch {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'real_jpeg_acceptance_configuration_failed\n',
    };
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const result = await runRealJpegAcceptanceCli(
    process.env,
    createProductionAdapter,
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
