// eslint-disable-next-line @nx/enforce-module-boundaries -- repository tooling reads shared release intent.
import { RELEASE_VERSION } from '../../../tools/release/release-intent.ts';
// Real OCR journey on the packaged Capture Workbench desktop app: the path a
// user takes with a scanned image or PDF. It launches the app with fresh app
// data, connects over CDP, and walks the routed UI:
//
//   01 first-run setup for text recognition only (with a retry) -> runtime ready
//   02 verify OCR compute mode on Settings › Compute -> import source file on /ocr -> processing
//   03 OCR checkpoint: result pages contain the expectation's anchors and match durable segments,
//      and Settings › Diagnostics exposes matching extraction provenance
//   04 delete verified document on /history -> review complete
//
// then proves the app, the runtime sidecar, the CDP port, and temporary app data are gone.
//
//
// Inputs (one per line):
//   CAPTURE_REAL_DESKTOP_OCR_INPUT: required image source path unless CAPTURE_REAL_DESKTOP_OCR_PDF is set.
//   CAPTURE_REAL_DESKTOP_OCR_PDF: required PDF source path unless CAPTURE_REAL_DESKTOP_OCR_INPUT is set.
//   CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS: optional expectations JSON path (defaults to `<input>.expected.json` beside the input).
//   CAPTURE_REAL_DESKTOP_APP_DATA: required in non-acceptance mode; host-owned app-data directory under %APPDATA%.
//   APPDATA: required in non-acceptance mode to verify CAPTURE_REAL_DESKTOP_APP_DATA.
//   CAPTURE_REAL_DESKTOP_EXECUTABLE: optional path to capture-workbench-desktop.exe (defaults to the release target binary).
//   CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE: optional expected OCR device (`directml` or `cpu`; also `--expected-ocr-device`).
//   CAPTURE_REAL_DESKTOP_TEARDOWN: optional teardown mode (`window-close` default, or `terminate-process`).
//   E2E_ACCEPTANCE_RUN_ID: optional; when set, enables installed OCR-only acceptance mode with privacy-safe evidence.
//   E2E_ACCEPTANCE_EVENT_ROOT: required in acceptance mode; directory for acceptance checkpoint journal events.
//   E2E_ARTIFACT_ROOT: optional diagnostic log root (required in acceptance mode via createAcceptanceRun).
//   E2E_ACCEPTANCE_SCOPE_PATH: optional in acceptance mode; path to the acceptance scope ownership file.
//   E2E_ACCEPTANCE_DIAGNOSTICS: optional; `1` enables stage and OCR lifecycle diagnostic logs.
//   E2E_ACCEPTANCE_KEEP_APP_DATA: optional; `1` retains acceptance app-data directories after teardown.
//   CAPTURE_RUNTIME_CANDIDATE_ROOT: required in acceptance mode; path to the staged runtime candidate directory.
//   CAPTURE_RUNTIME_CANDIDATE_ID: required in acceptance mode; 64-char lowercase SHA-256 of the runtime candidate.
//   CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: required in acceptance mode; must be `1`.
//   CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: required in acceptance mode; path to the local OCR model directory.
//   CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE: required in acceptance mode; path to acceptance installer provenance JSON.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type Browser, type Locator, type Page } from '@playwright/test';

// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance artifacts are a workspace-level test contract.
import {
  assertWebmArtifact,
  createAcceptanceRun,
  readOcrExecutionFailure,
  readOcrExecutionProof,
  writeAcceptanceManifest,
  type AcceptanceEvidenceSummary,
  type AcceptanceOcrExecutionProofSummary,
  type AcceptanceOcrExecutionFailureSummary,
  type AcceptanceRun,
} from '../../../tools/acceptance-contract.ts';
import { assertStagedRuntime } from './assert-staged-runtime.ts';
import { isPackagedWorkbenchUrl } from './packaged-workbench-page.ts';
import {
  nativeClickWebViewElement,
  nativeOpenDialogUiAutomation,
} from './installed-browser.ts';
import {
  assertVisibleOcrPageText,
  expectedVisibleOcrPagesForRaw,
  type ExpectedVisibleOcrPage,
} from './installed-document-assertions.ts';
import { assertRedactedEvidence } from './hash-qa-installer.ts';
import {
  assertDurableOcrSegmentsEqual,
  assertRealOcrOnlyResult,
  loadRealOcrExpectation,
  type RealOcrLocator,
  type RealOcrUiResult,
  type RealOcrUiSegment,
} from './real-ocr-result-assertions.ts';
import {
  buildOcrOnlySemanticEvidence,
  writeOcrSemanticEvidenceArtifact,
  type OcrSemanticArtifactIdentity,
  type OcrSemanticEvidenceV1,
  type OcrSemanticExecutionProofIdentity,
} from './ocr-semantic-evidence.ts';
import {
  CaptureAcceptanceScopeOwner,
  type AcceptanceScopePaths,
} from './acceptance-scope.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance journal is a workspace-level contract.
import {
  openAcceptanceCheckpointWriter,
  type AcceptanceCheckpointWriter,
} from '../../../tools/acceptance-checkpoint-journal.ts';
import { appRoot } from './stage-runtime.ts';
import {
  startLocalCandidateWorkerMirror,
  type LocalCandidateWorkerMirror,
} from './local-candidate-worker-mirror.ts';
import {
  verifyLocalCandidateModel,
  type LocalCandidateModelIdentity,
} from './local-candidate-model.ts';
import {
  attachToLaunchedDesktop,
  checkpointScreenshot,
  closeOwnedDesktopRoot,
  deleteCompletedDocument,
  delay,
  descendantProcessRecords,
  desktopCdpArguments,
  establishOwnedDesktopLaunch,
  finishOwnedDesktopSession,
  injectCheckpointPrivacyStyle,
  invokeTauriCommand,
  isCaptureSidecarProcess,
  isLoopbackPortOpen,
  isProcessAlive,
  isTauriBridgeClosedError,
  navigateToHistoryPage,
  readDurableLibraryDetail,
  pinViewportToWindow,
  readLatestInstallation,
  readRequirementStatus,
  readRuntimeSidecarPid,
  reattachToPackagedPage,
  reservePort,
  resolveDesktopTeardownMode,
  visibleRuntimeError,
  waitForPortClosed,
  waitUntil,
  withTimeout,
  type CdpBrowser,
  type DurableLibraryDetailRecord,
  type OwnedDesktopSessionCleanup,
} from './packaged-workbench-session.ts';
import {
  openFilesystemAuthority,
  type FilesystemAuthority,
} from './filesystem-authority.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const outputDirectory = join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'real-desktop-ocr-smoke');
const evidencePath = join(outputDirectory, 'real-desktop-ocr-smoke.json');
const defaultDesktopExecutable = join(
  appRoot,
  'src-tauri',
  'target',
  'x86_64-pc-windows-msvc',
  'release',
  'capture-workbench-desktop.exe',
);
const productIdentifier = 'io.github.gx-capture.capture-workbench';
const maxSourceBytes = 50 * 1024 * 1024;
const ownedSmokeDocumentPattern =
  /^standalone-real-ocr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/iu;

const localModelEnvironmentKeys = [
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_SHA256',
  'CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_IDENTITY',
] as const;

export function scrubLocalModelEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const scrubbed = { ...environment };
  for (const key of localModelEnvironmentKeys) delete scrubbed[key];
  return scrubbed;
}

function acceptanceStage(stage: string): void {
  if (process.env.E2E_ACCEPTANCE_DIAGNOSTICS === '1') {
    const line = `acceptance-stage=${stage}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(
        join(process.env.E2E_ARTIFACT_ROOT || outputDirectory, 'acceptance-stage.log'),
        line,
        'utf8',
      );
    } catch {
      // The stage log is diagnostic-only; acceptance truth remains in the manifest.
    }
  }
}

type OcrLifecycleDiagnosticEvent =
  | 'page-close'
  | 'browser-disconnected'
  | 'app-exit'
  | 'target-loss'
  | 'liveness'
  | 'teardown-requested';

interface OcrLifecycleDiagnostic {
  readonly event: OcrLifecycleDiagnosticEvent;
  readonly timestamp: string;
  readonly appAlive?: boolean;
  readonly runtimeAlive?: boolean;
  readonly cdpOpen?: boolean;
  readonly teardownRequested?: boolean;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

function recordOcrLifecycleDiagnostic(
  event: OcrLifecycleDiagnosticEvent,
  details: Omit<OcrLifecycleDiagnostic, 'event' | 'timestamp'> = {},
): void {
  if (process.env.E2E_ACCEPTANCE_DIAGNOSTICS !== '1') return;
  const diagnostic: OcrLifecycleDiagnostic = {
    event,
    timestamp: new Date().toISOString(),
    ...details,
  };
  const line = `ocr-diagnostic=${JSON.stringify(diagnostic)}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(
      join(process.env.E2E_ARTIFACT_ROOT || outputDirectory, 'acceptance-diagnostics.jsonl'),
      line,
      'utf8',
    );
  } catch {
    // Diagnostics are optional and must never change acceptance truth.
  }
}

function observeOcrAppLifecycle(app: ReturnType<typeof spawn>): void {
  if (app.listenerCount('exit') === 0) {
    app.once('exit', (exitCode, signal) => recordOcrLifecycleDiagnostic('app-exit', {
      exitCode,
      signal,
    }));
  }
}

function observeOcrPageLifecycle(
  page: Page,
  browser: Browser,
  app: ReturnType<typeof spawn>,
): void {
  page.on('close', () => recordOcrLifecycleDiagnostic('page-close'));
  browser.on('disconnected', () => recordOcrLifecycleDiagnostic('browser-disconnected'));
  observeOcrAppLifecycle(app);
}

export const realDesktopRuntimeReadyTimeoutMs = 3 * 60_000;
/** Dependency downloads and first-run engine probes are allowed a longer budget than readiness polling. */
export const realDesktopDependencyInstallTimeoutMs = 15 * 60_000;
const terminalDesktopDocumentStatuses = new Set(['failed', 'cancelled', 'canceled']);
const safeDesktopDocumentErrorCodePattern = /^[a-z][a-z0-9_-]{1,63}$/u;

export interface DesktopOcrTerminalObservation {
  readonly status: string;
  readonly errorCode: string | null;
}

export class DesktopOcrTerminalFailure extends Error {
  readonly observation: DesktopOcrTerminalObservation;

  constructor(observation: DesktopOcrTerminalObservation, message?: string) {
    super(
      message
        ?? safeTerminalDesktopOcrFailure(observation.status, observation.errorCode)
        ?? 'Standalone desktop OCR terminated with an unknown terminal status.',
    );
    this.name = 'DesktopOcrTerminalFailure';
    this.observation = observation;
  }
}

export type DesktopOcrLifecycleFailureKind =
  | 'host-lifecycle'
  | 'runtime-root-exit'
  | 'target-loss';

export interface DesktopOcrPollingLiveness {
  readonly appAlive: boolean;
  readonly runtimeAlive: boolean;
  readonly cdpOpen: boolean;
  readonly teardownRequested: boolean;
  readonly appExitCode: number | null;
  readonly appSignal: string | null;
}

export interface DesktopOcrPollingRecoveryOptions {
  readonly documentId: string;
  readonly durableCompletion: 'ocr-checkpoint' | 'ocr-checkpoint-or-completed';
  readonly observeLiveness: () => Promise<DesktopOcrPollingLiveness>;
  readonly reattach: () => Promise<{ readonly browser: Browser; readonly page: Page }>;
  readonly exactOcrQueueRow: (page: Page, documentId: string) => Locator;
  readonly readDurableDetail?: (page: Page, documentId: string) => Promise<DurableLibraryDetailRecord>;
  readonly onReattached?: (attached: { readonly browser: Browser; readonly page: Page }) => Promise<void> | void;
  readonly recordDiagnostic?: (
    event: OcrLifecycleDiagnosticEvent,
    details?: Omit<OcrLifecycleDiagnostic, 'event' | 'timestamp'>,
  ) => void;
}

export class DesktopOcrLifecycleFailure extends Error {
  readonly kind: DesktopOcrLifecycleFailureKind;
  readonly liveness: DesktopOcrPollingLiveness;

  constructor(kind: DesktopOcrLifecycleFailureKind, liveness: DesktopOcrPollingLiveness) {
    const reason = kind === 'host-lifecycle'
      ? 'host exited during OCR polling'
      : kind === 'runtime-root-exit'
        ? 'runtime root exited during OCR polling'
        : 'WebView2 target was lost during OCR polling';
    super(`Standalone desktop OCR ${reason}.`);
    this.name = 'DesktopOcrLifecycleFailure';
    this.kind = kind;
    this.liveness = liveness;
  }
}

export function safeTerminalDesktopOcrFailure(
  status: string | null,
  errorCode: string | null,
): string | undefined {
  if (status === null || !terminalDesktopDocumentStatuses.has(status)) return undefined;
  const safeErrorCode = errorCode !== null && safeDesktopDocumentErrorCodePattern.test(errorCode)
    ? errorCode
    : 'unknown';
  return `Standalone desktop OCR terminated. status=${status}; errorCode=${safeErrorCode}.`;
}

export function isRealOcrWorkerFailure(error: unknown): boolean {
  return error instanceof DesktopOcrTerminalFailure
    && error.observation.status === 'failed'
    && error.observation.errorCode === 'ocr_worker_failed';
}

type OcrDevice = 'directml' | 'cpu';
type SourceKind = 'pdf' | 'image' | 'recording' | 'unknown';
type DesktopOcrAcceptanceMode = 'ocr-only';
interface RealDesktopSmokeEvidence {
  readonly evidenceKind: 'real-standalone-tauri-ui-ocr';
  readonly acceptanceMode: DesktopOcrAcceptanceMode;
  readonly releaseGateSatisfied: false;
  readonly realEnginesExercised: true;
  readonly sourceKind: SourceKind;
  readonly rawOcrVisible: true;
  readonly ocrResultVerified: true;
  readonly ocrProjectionVerified: true;
  readonly rawOcrSegmentCount: number;
  readonly structuredBlockCount: 0;
  readonly expectedAnchorCount: number;
  readonly matchedAnchorCount: number;
  readonly ocrDevice: OcrDevice;
  readonly documentDeletedAfterVerification: true;
  readonly sourceSha256?: string;
  readonly ocrExecutionProof?: AcceptanceOcrExecutionProofSummary;
}

export interface AuthenticatedOcrPreflightObservation {
  readonly contractSetSha256: string;
  readonly workerSha256: string;
  readonly mode: 'gpu' | 'cpu-fallback';
}

interface PdfPageScopeEvidence {
  readonly sourcePageCount: number;
  readonly requestedPageNumbers: readonly number[];
  readonly processedPageNumbers: readonly number[];
}

/**
 * Owns the installed Phase 1 PDF page-one gate at the exact semantic artifact
 * seam. The caller passes the same object to the atomic writer only after this
 * assertion succeeds.
 */
export function assertPdfPageOneSemanticEvidence(
  pageScope: PdfPageScopeEvidence,
  semanticEvidence: OcrSemanticEvidenceV1,
): void {
  assert.ok(
    Number.isSafeInteger(pageScope.sourcePageCount)
      && pageScope.sourcePageCount >= 1
      && pageScope.sourcePageCount <= 500,
    'Phase 1 PDF source page count must be a safe integer from 1 through 500.',
  );
  assert.deepEqual(
    pageScope,
    {
      sourcePageCount: pageScope.sourcePageCount,
      requestedPageNumbers: [1],
      processedPageNumbers: [1],
    },
    'Phase 1 PDF page-one scope must request and process exactly page one.',
  );
  assert.equal(semanticEvidence.sourceKind, 'pdf', 'Phase 1 PDF semantic sourceKind must be pdf.');
  assert.equal(semanticEvidence.status, 'completed', 'Phase 1 PDF semantic status must be completed.');
  assert.equal(semanticEvidence.pageCount, 1, 'Phase 1 PDF semantic pageCount must be one.');
  assert.equal(semanticEvidence.pages.length, 1, 'Phase 1 PDF semantic evidence must contain exactly one page.');
  const page = semanticEvidence.pages[0];
  assert.ok(page, 'Phase 1 PDF semantic evidence must contain exactly one page.');
  assert.equal(page.page, 1, 'Phase 1 PDF semantic page number must be one.');
  assert.equal(page.status, 'recognized', 'Phase 1 PDF semantic page must be recognized.');
  assert.ok(page.boxCount > 0, 'Phase 1 PDF semantic page boxCount must be positive.');
  assert.ok(
    typeof page.confidence === 'number'
      && Number.isFinite(page.confidence)
      && page.confidence >= 0
      && page.confidence <= 1,
    'Phase 1 PDF semantic page confidence must be a finite number from 0 through 1.',
  );
  assert.equal(
    page.confidenceSummary.scoreState,
    'numeric',
    'Phase 1 PDF semantic page scoreState must be numeric.',
  );
  assert.ok(
    page.confidenceSummary.numericCount > 0,
    'Phase 1 PDF semantic page numericCount must be positive.',
  );
}

export interface LocalInstalledRuntimeProvenance {
  readonly buildFlavor: 'acceptance';
  readonly stagedRuntimeSha256: string;
  readonly runtimeManifestSha256: string;
}

export interface LocalInstalledRuntimeIdentityOptions {
  readonly installedExecutablePath: string;
  readonly candidateRoot: string;
  readonly candidateId: string;
  readonly installerProvenance: LocalInstalledRuntimeProvenance;
  /** Only recorded in the returned diagnostic object; it is never trusted. */
  readonly sourceStagedRuntimeSha256?: string;
}

export interface LocalInstalledRuntimeIdentity {
  readonly policy: 'local-package-tiered';
  readonly sourceRole: 'actual-installed-runtime';
  readonly installRoot: string;
  readonly runtimePath: string;
  readonly runtimeSha256: string;
  readonly sourceStagedRuntimeSha256?: string;
  readonly runtimeVersion: string;
  readonly runtimeManifestSha256: string;
  readonly contractSetSha256: string;
  readonly candidateId: string;
}

const runtimeManifestSemanticFields = [
  'apiVersion',
  'arch',
  'bytes',
  'captureDocumentSchemaVersion',
  'fileName',
  'manifestVersion',
  'platform',
  'runtimeVersion',
  'schemaFileName',
  'schemaSha256',
  'sha256',
] as const;

export interface DesktopRuntimeStageObservation {
  readonly digest: string;
}

export interface DesktopRuntimePreflightOptions {
  readonly acceptance: boolean;
  readonly readStrictStagedRuntime: () => Promise<DesktopRuntimeStageObservation>;
  readonly readOptionalStagedRuntime: () => Promise<DesktopRuntimeStageObservation | undefined>;
  readonly resolveInstalledRuntime: (
    sourceStagedRuntimeSha256?: string,
  ) => Promise<LocalInstalledRuntimeIdentity>;
}

export interface DesktopRuntimePreflightResult {
  readonly expectedRuntimeSha256: string;
  readonly sourceStagedRuntimeSha256?: string;
  readonly localInstalledRuntime?: LocalInstalledRuntimeIdentity;
}

/**
 * Selects the identity expected by the OCR proof channel for one lane.  The
 * release lane has a strict staged-runtime preflight.  Local installed-app
 * acceptance authenticates the installed candidate independently and treats a
 * source-stage observation as optional diagnostics only.
 */
export async function resolveDesktopRuntimePreflight(
  options: DesktopRuntimePreflightOptions,
): Promise<DesktopRuntimePreflightResult> {
  if (!options.acceptance) {
    const staged = await options.readStrictStagedRuntime();
    const digest = requireDigest(staged.digest, 'staged runtime');
    return {
      expectedRuntimeSha256: digest,
      sourceStagedRuntimeSha256: digest,
    };
  }

  let sourceStagedRuntimeSha256: string | undefined;
  try {
    const staged = await options.readOptionalStagedRuntime();
    if (typeof staged?.digest === 'string' && /^[a-f0-9]{64}$/u.test(staged.digest)) {
      sourceStagedRuntimeSha256 = staged.digest;
    }
  } catch {
    // A local source-stage observation is diagnostic-only.  Its absence or
    // failure must never prevent authenticating the installed candidate.
  }
  const localInstalledRuntime = await options.resolveInstalledRuntime(sourceStagedRuntimeSha256);
  const installedDigest = requireDigest(localInstalledRuntime.runtimeSha256, 'installed runtime');
  return {
    expectedRuntimeSha256: installedDigest,
    ...(sourceStagedRuntimeSha256 === undefined ? {} : { sourceStagedRuntimeSha256 }),
    localInstalledRuntime,
  };
}

/**
 * Authenticates the runtime actually reachable by an installed desktop app.
 *
 * This is deliberately a deep local-package module: callers provide one app
 * executable and one immutable runtime candidate, while this implementation
 * resolves the install root, follows the native launcher's canonical resource
 * layout (manifest under resources and executable under binaries), validates
 * manifest/artifact/provenance identity, and returns the only digest that may
 * be passed to the runtime's execution-proof channel.
 * Source-staged bytes are diagnostic-only and can never become the expected
 * runtime identity for an installed-package run.
 */
export async function resolveLocalInstalledRuntimeIdentity(
  options: LocalInstalledRuntimeIdentityOptions,
): Promise<LocalInstalledRuntimeIdentity> {
  const candidateAuthority = await openFilesystemAuthority(
    options.candidateRoot,
    undefined,
    'runtime candidate root',
  );
  if (!/^[a-f0-9]{64}$/u.test(options.candidateId)) {
    throw new Error('Local package runtime candidate ID is invalid.');
  }
  if (options.sourceStagedRuntimeSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(options.sourceStagedRuntimeSha256)) {
    throw new Error('Source-staged runtime SHA-256 is invalid.');
  }
  const candidateManifestPath = await requireCandidateFile(candidateAuthority, 'candidate-manifest.json', 'Runtime candidate manifest');
  const candidateManifestBytes = await readFile(candidateManifestPath);
  const candidateManifest = parseJsonRecord(candidateManifestBytes, 'Runtime candidate manifest');
  if (candidateManifest.candidateKind !== 'runtime' || candidateManifest.candidateId !== options.candidateId) {
    throw new Error('Runtime candidate manifest identity is invalid.');
  }
  const candidateManifestBase = { ...candidateManifest };
  delete candidateManifestBase.candidateId;
  if (sha256Bytes(Buffer.from(JSON.stringify(candidateManifestBase))) !== options.candidateId) {
    throw new Error('Runtime candidate ID is not bound to its manifest.');
  }
  if (candidateManifest.releaseVersion !== RELEASE_VERSION) {
    throw new Error(`Runtime candidate version is not ${RELEASE_VERSION}.`);
  }
  const candidateContractSetSha256 = requireDigest(candidateManifest.contractSetSha256, 'runtime candidate contract set');
  const candidateContractBytes = await readFile(await requireCandidateFile(candidateAuthority, 'contracts/contract-set.json', 'Runtime candidate contract set'));
  if (sha256Bytes(candidateContractBytes) !== candidateContractSetSha256) {
    throw new Error('Runtime candidate contract-set bytes are not allowed by the candidate.');
  }
  if ((await readFile(await requireCandidateFile(candidateAuthority, 'contracts/contract-set.sha256', 'Runtime candidate contract-set digest file'), 'utf8')).trim() !== candidateContractSetSha256) {
    throw new Error('Runtime candidate contract-set digest file is not self-consistent.');
  }

  const candidateRuntimeManifestPath = await requireCandidateFile(candidateAuthority, 'runtime/capture-runtime-manifest.json', 'Candidate runtime manifest');
  const candidateRuntimeManifestBytes = await readFile(candidateRuntimeManifestPath);
  const candidateRuntimeManifestSha256 = sha256Bytes(candidateRuntimeManifestBytes);
  const candidateRuntimeManifest = parseJsonRecord(candidateRuntimeManifestBytes, 'Candidate runtime manifest');
  const candidateRuntimeSha256 = requireDigest(candidateRuntimeManifest.sha256, 'candidate runtime');
  if (
    candidateRuntimeManifest.runtimeVersion !== candidateManifest.releaseVersion ||
    !Number.isSafeInteger(candidateRuntimeManifest.bytes) ||
    Number(candidateRuntimeManifest.bytes) <= 0
  ) {
    throw new Error('Candidate runtime manifest version or byte count is invalid.');
  }
  const candidateRuntimeArtifact = findCandidateRuntimeArtifact(candidateManifest.artifacts, candidateRuntimeManifest.fileName);
  const candidateRuntimeArtifactPath = await requireCandidateFile(candidateAuthority, candidateRuntimeArtifact.path, 'Runtime candidate executable');
  const candidateRuntimeArtifactBytes = await readFile(candidateRuntimeArtifactPath);
  if (
    candidateRuntimeArtifact.bytes !== candidateRuntimeArtifactBytes.length ||
    candidateRuntimeArtifact.sha256 !== sha256Bytes(candidateRuntimeArtifactBytes) ||
    candidateRuntimeArtifact.sha256 !== candidateRuntimeSha256 ||
    candidateRuntimeManifest.bytes !== candidateRuntimeArtifactBytes.length
  ) {
    throw new Error('Runtime candidate artifact is not self-consistent.');
  }
  const candidateRuntimeManifestArtifact = findCandidateArtifact(
    candidateManifest.artifacts,
    'runtime/capture-runtime-manifest.json',
  );
  if (
    candidateRuntimeManifestArtifact.bytes !== candidateRuntimeManifestBytes.length ||
    candidateRuntimeManifestArtifact.sha256 !== candidateRuntimeManifestSha256
  ) {
    throw new Error('Runtime candidate manifest artifact is not self-consistent.');
  }
  const candidateSchemaPath = await requireCandidateFile(candidateAuthority, 'runtime/capture-document-v2.schema.json', 'Runtime candidate schema');
  const candidateSchemaBytes = await readFile(candidateSchemaPath);
  if (candidateRuntimeManifest.schemaSha256 !== sha256Bytes(candidateSchemaBytes)) {
    throw new Error('Runtime candidate schema identity is not self-consistent.');
  }
  const candidateRuntimeSemanticSha256 = runtimeManifestSemanticSha256(
    candidateRuntimeManifest,
    'Candidate runtime manifest',
  );

  const installedExecutable = await requireInstalledRegularFile(options.installedExecutablePath, 'installed desktop executable');
  const installRoot = dirname(installedExecutable);
  const installedManifestPath = await resolveInstalledResource(
    installRoot,
    'capture-runtime-manifest.json',
    'manifest',
    'installed runtime manifest',
  );
  const installedManifestBytes = await readFile(installedManifestPath);
  const installedManifestSha256 = sha256Bytes(installedManifestBytes);
  const installedManifest = parseJsonRecord(installedManifestBytes, 'Installed runtime manifest');
  const installedRuntimeSemanticSha256 = runtimeManifestSemanticSha256(
    installedManifest,
    'Installed runtime manifest',
  );
  const installedRuntimePath = await resolveInstalledResource(
    installRoot,
    String(installedManifest.fileName),
    'runtime',
    'installed runtime executable',
  );
  const installedRuntimeBytes = await readFile(installedRuntimePath);
  const installedRuntimeSha256 = sha256Bytes(installedRuntimeBytes);
  if (
    Number(installedManifest.bytes) !== installedRuntimeBytes.length ||
    installedManifest.sha256 !== installedRuntimeSha256 ||
    installedRuntimeSha256 !== candidateRuntimeSha256 ||
    installedRuntimeSemanticSha256 !== candidateRuntimeSemanticSha256
  ) {
    throw new Error('installed runtime is not allowed by the candidate: semantic identity mismatch.');
  }
  const installerRuntimeManifestSha256 = requireDigest(
    options.installerProvenance.runtimeManifestSha256,
    'installer runtime manifest',
  );
  if (
    options.installerProvenance.buildFlavor !== 'acceptance' ||
    options.installerProvenance.stagedRuntimeSha256 !== candidateRuntimeSha256 ||
    installerRuntimeManifestSha256 !== installedManifestSha256
  ) {
    throw new Error('Installed runtime is not allowed by installer provenance.');
  }
  return {
    policy: 'local-package-tiered',
    sourceRole: 'actual-installed-runtime',
    installRoot,
    runtimePath: installedRuntimePath,
    runtimeSha256: installedRuntimeSha256,
    sourceStagedRuntimeSha256: options.sourceStagedRuntimeSha256,
    runtimeVersion: String(installedManifest.runtimeVersion),
    runtimeManifestSha256: installedManifestSha256,
    contractSetSha256: candidateContractSetSha256,
    candidateId: options.candidateId,
  };
}

/** Reads the provenance `build-nsis-acceptance` recorded for the staged runtime. */
export async function readLocalInstalledRuntimeProvenance(path: string): Promise<LocalInstalledRuntimeProvenance> {
  const provenancePath = await requireInstalledRegularFile(path, 'Acceptance installer provenance');
  const record = parseJsonRecord(await readFile(provenancePath), 'Acceptance installer provenance');
  if (
    record.buildFlavor !== 'acceptance' ||
    typeof record.stagedRuntimeSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.stagedRuntimeSha256) ||
    typeof record.runtimeManifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.runtimeManifestSha256)
  ) {
    throw new Error('Acceptance installer provenance identity is invalid.');
  }
  return {
    buildFlavor: 'acceptance',
    stagedRuntimeSha256: record.stagedRuntimeSha256,
    runtimeManifestSha256: record.runtimeManifestSha256,
  };
}

async function requireInstalledRegularFile(path: string, label: string): Promise<string> {
  const resolved = resolve(path);
  const parentAuthority = await openFilesystemAuthority(
    dirname(resolved),
    undefined,
    label,
  );
  return parentAuthority.resolveFile(resolved, label);
}

async function requireCandidateFile(
  authority: FilesystemAuthority,
  relativePath: string,
  label: string,
): Promise<string> {
  const candidatePath = authority.child(
    join(authority.canonicalRoot, ...relativePath.split('/')),
    label,
  );
  return authority.resolveFile(candidatePath, label);
}

type InstalledResourceKind = 'manifest' | 'runtime';

async function resolveInstalledResource(
  root: string,
  name: string,
  kind: InstalledResourceKind,
  label: string,
): Promise<string> {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`${label} name is invalid.`);
  }
  const canonical = join(root, kind === 'manifest' ? 'resources' : 'binaries', name);
  const candidates = [join(root, name), join(root, 'resources', name), join(root, 'binaries', name)];
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      existing.push(await requireInstalledRegularFile(candidate, label));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
  }
  const unique = [...new Set(existing.map((path) => path.toLowerCase()))];
  if (unique.length !== 1 || existing[0]?.toLowerCase() !== canonical.toLowerCase()) {
    throw new Error(`${label} must resolve to exactly one canonical file within the installed root.`);
  }
  const selected = existing.find((path) => path.toLowerCase() === unique[0]);
  if (!selected || !isDescendantOrSelf(root, selected)) {
    throw new Error(`${label} escaped the installed root.`);
  }
  return selected;
}

function findCandidateRuntimeArtifact(artifacts: unknown, fileName: unknown): { readonly path: string; readonly bytes: number; readonly sha256: string } {
  if (typeof fileName !== 'string') throw new Error('Candidate runtime file name is invalid.');
  const matches = candidateArtifacts(artifacts).filter((item) => item.path === `runtime/${fileName}`);
  if (matches.length !== 1) throw new Error('Runtime candidate must contain exactly one runtime executable artifact.');
  return matches[0];
}

function findCandidateArtifact(artifacts: unknown, path: string): { readonly path: string; readonly bytes: number; readonly sha256: string } {
  const matches = candidateArtifacts(artifacts).filter((item) => item.path === path);
  if (matches.length !== 1) throw new Error(`Runtime candidate artifact is missing: ${path}.`);
  return matches[0];
}

function candidateArtifacts(value: unknown): Array<{ readonly path: string; readonly bytes: number; readonly sha256: string }> {
  if (!Array.isArray(value)) throw new Error('Runtime candidate artifacts are invalid.');
  return value.map((item) => {
    const record = parseJsonRecord(item, 'Runtime candidate artifact');
    if (
      typeof record.path !== 'string' ||
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(record.path) ||
      !Number.isSafeInteger(record.bytes) || Number(record.bytes) <= 0 ||
      typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256)
    ) throw new Error('Runtime candidate artifact is invalid.');
    return { path: record.path, bytes: Number(record.bytes), sha256: record.sha256 };
  });
}

function parseJsonRecord(value: Buffer | unknown, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Buffer.isBuffer(value) ? JSON.parse(value.toString('utf8')) : value;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function runtimeManifestSemanticSha256(value: Record<string, unknown>, label: string): string {
  const expectedKeys = [...runtimeManifestSemanticFields].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${label} semantic identity fields are unsupported or missing.`);
  }
  const stringFields = runtimeManifestSemanticFields.filter((field) => field !== 'bytes');
  if (
    stringFields.some((field) => typeof value[field] !== 'string') ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) <= 0
  ) {
    throw new Error(`${label} semantic identity field types are invalid.`);
  }
  requireDigest(value.schemaSha256, `${label} schema`);
  requireDigest(value.sha256, `${label} runtime`);
  const semanticIdentity = Object.fromEntries(
    runtimeManifestSemanticFields.map((field) => [field, value[field]]),
  );
  return sha256Bytes(Buffer.from(JSON.stringify(semanticIdentity), 'utf8'));
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} SHA-256 is invalid.`);
  }
  return value;
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isDescendantOrSelf(parent: string, child: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return childRelative === '' || (!childRelative.startsWith(`..${sep}`) && childRelative !== '..' && !childRelative.includes(`..${sep}`));
}

export function assertRealDesktopSmokeEvidence(
  value: unknown,
  options: { readonly acceptance: boolean },
): asserts value is RealDesktopSmokeEvidence {
  const report = value as Partial<RealDesktopSmokeEvidence> & {
    readonly structuringEngine?: unknown;
    readonly model?: unknown;
  } | undefined;
  assert.equal(report?.evidenceKind, 'real-standalone-tauri-ui-ocr');
  // An OCR checkpoint is a completed extraction journey, not a structuring
  // or release success.  Keep those terminal claims explicitly separate.
  assert.equal(report?.acceptanceMode, 'ocr-only');
  assert.equal(report?.releaseGateSatisfied, false);
  assert.equal(report?.ocrProjectionVerified, true);
  assert.equal(report?.structuredBlockCount, 0);
  assert.equal(report?.structuringEngine, undefined);
  assert.equal(report?.model, undefined);
  if (options.acceptance) {
    assert.ok(report?.ocrExecutionProof);
    assert.equal(report.ocrExecutionProof.dmlNodeCount >= 1, true);
  } else {
    assert.equal(report?.ocrExecutionProof, undefined);
  }
  assert.equal(report?.realEnginesExercised, true);
  assert.ok(report?.sourceKind === 'pdf' || report?.sourceKind === 'image' || report?.sourceKind === 'recording' || report?.sourceKind === 'unknown');
  assert.equal(report?.rawOcrVisible, true);
  assert.equal(report?.ocrResultVerified, true);
  assert.ok(Number.isInteger(report?.rawOcrSegmentCount) && Number(report?.rawOcrSegmentCount) > 0);
  assert.ok(Number.isInteger(report?.expectedAnchorCount) && Number(report?.expectedAnchorCount) > 0);
  assert.equal(report?.matchedAnchorCount, report?.expectedAnchorCount);
  assert.ok(report?.ocrDevice === 'directml' || report?.ocrDevice === 'cpu');
  assert.equal(report?.documentDeletedAfterVerification, true);
  if (report?.sourceSha256 !== undefined) {
    assert.match(report.sourceSha256, /^[a-f0-9]{64}$/u);
  }

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u);
  assertRedactedEvidence(report);
}

export async function main(options: {
  readonly checkpoint?: (page: Page, name: string) => Promise<void>;
} = {}): Promise<void> {
  const acceptance: AcceptanceRun | undefined = process.env.E2E_ACCEPTANCE_RUN_ID
    ? createAcceptanceRun(process.env, 'capture-workbench', workspaceRoot)
    : undefined;
  const isolated = acceptance !== undefined;
  const checkpointScreenshots: string[] = [];
  const acceptanceErrors: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let acceptanceStatus: 'completed' | 'failed' = 'failed';
  let acceptanceArtifactFailure: Error | undefined;
  let videoPath: string | undefined;
  let videoStarted = false;
  let sessionCleanup: OwnedDesktopSessionCleanup | undefined;
  let sidecarObserved = false;
  let workerMirror: LocalCandidateWorkerMirror | undefined;
  let localCandidateModelIdentity: LocalCandidateModelIdentity | undefined;
  let workerDownloadRequired = false;
  let runtimeSidecarPid: number | undefined;
  let teardownRequested = false;
  let acceptanceEvidence: AcceptanceEvidenceSummary | undefined;
  let semanticArtifactIdentity: OcrSemanticArtifactIdentity | undefined;
  let ocrExecutionProof: AcceptanceOcrExecutionProofSummary | undefined;
  let verifiedOcrExecutionFailure: AcceptanceOcrExecutionFailureSummary | undefined;
  let authenticatedOcrPreflight: AuthenticatedOcrPreflightObservation | undefined;
  let uiGpuBeforeImport = false;
  let importedSourceSha256: string | undefined;
  let localScopeOwner: CaptureAcceptanceScopeOwner | undefined;
  let checkpointJournal: AcceptanceCheckpointWriter | undefined;
  let launchedApp: ReturnType<typeof spawn> | undefined;
  let importedDocumentId: string | undefined;

  const observeOwnedSidecar = (): void => {
    if (!isolated || sidecarObserved) return;
    const children = descendantProcessRecords(launchedApp?.pid);
    sidecarObserved = children?.some(isCaptureSidecarProcess) === true;
    void localScopeOwner?.refresh().catch(() => undefined);
  };

  const observeOwnedSidecarFromExecutableSignal = async (runtimePage: Page): Promise<void> => {
    if (!isolated || sidecarObserved) return;
    const processId = await readRuntimeSidecarPid(runtimePage);
    if (processId === undefined) return;
    runtimeSidecarPid = processId;
    sidecarObserved = isProcessAlive(runtimeSidecarPid);
  };

  if (process.platform !== 'win32') {
    throw new Error('Real standalone desktop OCR smoke requires Windows x64.');
  }

  const teardownMode = resolveDesktopTeardownMode(
    process.env.CAPTURE_REAL_DESKTOP_TEARDOWN,
  );

  const expectedOcrDevice = resolveExpectedOcrDevice(
    process.argv.slice(2),
    process.env.CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE,
  );
  const sourceVariable = process.env.CAPTURE_REAL_DESKTOP_OCR_INPUT?.trim()
    ? 'CAPTURE_REAL_DESKTOP_OCR_INPUT'
    : 'CAPTURE_REAL_DESKTOP_OCR_PDF';
  const sourcePath = requiredPath(sourceVariable);
  const sourceFixtureName = basename(sourcePath);
  const sourceKind = resolveSourceKind(sourcePath);
  const desktopExecutable = resolve(
    process.env.CAPTURE_REAL_DESKTOP_EXECUTABLE?.trim() || defaultDesktopExecutable,
  );
  const candidateRoot = acceptance
    ? requiredPath('CAPTURE_RUNTIME_CANDIDATE_ROOT')
    : undefined;
  const candidateId = acceptance
    ? requiredDigestEnvironment('CAPTURE_RUNTIME_CANDIDATE_ID')
    : undefined;
  let localModelRoot: string | undefined;
  if (acceptance) {
    if (!candidateRoot || !candidateId) {
      throw new Error('Local candidate identity inputs were unavailable.');
    }
    if (process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN !== '1') {
      throw new Error('Local package acceptance requires explicit local model opt-in.');
    }
    localModelRoot = requiredPath('CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT');
  }
  const appData = acceptance
    ? resolve(acceptance.artifactRoot, 'app-data')
    : requiredPath('CAPTURE_REAL_DESKTOP_APP_DATA');
  await requireRegularFile(sourcePath, sourceVariable);
  if (acceptance) {
    await mkdir(appData, { recursive: true });
  } else {
    await requireDirectory(appData, 'CAPTURE_REAL_DESKTOP_APP_DATA');
  }
  await requireRegularFile(desktopExecutable, 'CAPTURE_REAL_DESKTOP_EXECUTABLE');
  assertConfiguredHostAppData(appData, acceptance);

  const sourceBytes = await readFile(sourcePath);
  if (sourceBytes.length === 0 || sourceBytes.length > maxSourceBytes) {
    throw new Error(`${sourceVariable} must contain 1 through ${maxSourceBytes} bytes.`);
  }
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const ocrExpectation = await loadRealOcrExpectation(sourcePath);
  if (acceptance) {
    checkpointJournal = await openAcceptanceCheckpointWriter({
      eventRoot: requiredPath('E2E_ACCEPTANCE_EVENT_ROOT'),
      project: acceptance.project,
      runId: acceptance.runId,
    });
  }

  const runtimePreflight = await resolveDesktopRuntimePreflight({
    acceptance: acceptance !== undefined,
    readStrictStagedRuntime: async () => await observe(assertStagedRuntime('release')) as { digest: string },
    readOptionalStagedRuntime: async () => await observe(assertStagedRuntime('release')) as { digest: string },
    resolveInstalledRuntime: async (sourceStagedRuntimeSha256) => {
      if (!candidateRoot || !candidateId) {
        throw new Error('Local candidate identity inputs were unavailable.');
      }
      return resolveLocalInstalledRuntimeIdentity({
        installedExecutablePath: desktopExecutable,
        candidateRoot,
        candidateId,
        installerProvenance: await readLocalInstalledRuntimeProvenance(
          requiredPath('CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE'),
        ),
        sourceStagedRuntimeSha256,
      });
    },
  });
  const localInstalledRuntime = runtimePreflight.localInstalledRuntime;
  const expectedRuntimeSha256 = runtimePreflight.expectedRuntimeSha256;
  await mkdir(outputDirectory, { recursive: true });
  if (acceptance) {
    await mkdir(acceptance.artifactRoot, { recursive: true });
  }

  let cdpPort = 0;
  let webViewData: string | undefined;
  let pickerSourcePathForCleanup = '';
  try {
    cdpPort = await reservePort();
  if (acceptance) {
    if (!candidateRoot || !candidateId) {
      throw new Error('Local candidate identity inputs were unavailable.');
    }
    workerMirror = await startLocalCandidateWorkerMirror({
      candidateRoot,
      candidateId,
      requirementId: 'text-recognition',
    });
    if (localModelRoot === undefined) {
      throw new Error('Local candidate model root was unavailable.');
    }
    localCandidateModelIdentity = await verifyLocalCandidateModel({
      candidateRoot,
      candidateId,
      modelRoot: localModelRoot,
      requirementId: 'text-recognition',
    });
  }
  const mirrorBaseUrl = workerMirror?.baseUrl;
  const runId = randomUUID();
  webViewData = join(outputDirectory, `webview2-${runId}`);
  if (acceptance) {
    const scopePath = process.env.E2E_ACCEPTANCE_SCOPE_PATH?.trim();
    const scopePaths: AcceptanceScopePaths = {
      modelPaths: [join(acceptance.artifactRoot, 'model-staging')],
      appDataPaths: [
        resolve(acceptance.artifactRoot, 'app-data'),
        resolve(acceptance.artifactRoot, 'local-app-data'),
      ],
      sessionPaths: [webViewData],
    };
    if (scopePath) {
      localScopeOwner = new CaptureAcceptanceScopeOwner({
        scopePath,
        runId: acceptance.runId,
        rootPid: process.pid,
        paths: scopePaths,
      });
      await localScopeOwner.prepare();
      await localScopeOwner.setPaths(scopePaths);
    }
  }
  // Exact-artifact acceptance must exercise the user-provided file itself.
  // The local smoke keeps its isolated copy so it cannot accidentally import
  // or delete a user's existing library source.
  const sourceName = isolated
    ? sourceFixtureName
    : `standalone-real-ocr-${runId}${extname(sourcePath) || '.bin'}`;
  const pickerSourcePath = isolated
    ? sourcePath
    : join(outputDirectory, sourceName);
  pickerSourcePathForCleanup = pickerSourcePath;
  if (!isolated) await writeFile(pickerSourcePath, sourceBytes);
  launchedApp = await establishOwnedDesktopLaunch({
    scopeOwner: localScopeOwner,
    checkpointJournal,
    onChildSpawned: (child) => {
      launchedApp = child;
    },
    spawnChild: () => spawn(desktopExecutable, [], {
      cwd: resolve(desktopExecutable, '..'),
      env: {
        ...scrubLocalModelEnvironment(process.env),
        WEBVIEW2_USER_DATA_FOLDER: webViewData,
        ...(acceptance ? {
          APPDATA: resolve(acceptance.artifactRoot, 'app-data'),
          LOCALAPPDATA: resolve(acceptance.artifactRoot, 'local-app-data'),
          CAPTURE_REAL_DESKTOP_APP_DATA: appData,
          CAPTURE_ACCEPTANCE_APP_DATA_ROOT: appData,
        } : {}),
        ...(mirrorBaseUrl ? {
          CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
          CAPTURE_SMOKE_WORKER_MIRROR_URL: mirrorBaseUrl,
        } : {}),
        ...(acceptance ? {
          CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: '1',
          CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: localModelRoot,
          CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN: '1',
          CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT: acceptance.artifactRoot,
          CAPTURE_OCR_EXECUTION_RUNTIME_SHA256: expectedRuntimeSha256,
        } : {}),
        ...(isolated && sourceKind === 'pdf'
          ? { CAPTURE_ACCEPTANCE_PDF_PAGE_SCOPE: 'page-1' }
          : {}),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: desktopCdpArguments(cdpPort),
      },
      stdio: 'ignore',
      windowsHide: true,
    }),
  });
  if (!launchedApp) throw new Error('Packaged app launch did not produce a process.');
  const app = launchedApp;
  observeOcrAppLifecycle(app);
  observeOwnedSidecar();

  let browser: CdpBrowser | undefined;
  const browserClients: CdpBrowser[] = [];
  let page: Page | undefined;
  try {
    await checkpointJournal?.begin('cdp', 'initial-attach');
    const attached = await attachToLaunchedDesktop(cdpPort);
    browser = attached.browser;
    browserClients.push(browser);
    page = attached.page;
    observeOcrPageLifecycle(page, browser, app);
    await page.waitForLoadState('domcontentloaded');
    const viewport = await pinViewportToWindow(page);
    await injectCheckpointPrivacyStyle(page, isolated);
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    if (acceptance?.recordVideo) {
      videoPath = join(acceptance.artifactRoot, 'capture-workbench-golden-journey.webm');
      await page.screencast.start({
        path: videoPath,
        size: viewport,
      });
      videoStarted = true;
    }
    await checkpointJournal?.complete('cdp', 'initial-attach');

    await checkpointJournal?.begin('runtime', 'runtime-ready');
    await runOcrFirstRunSetup(page, {
      readyTimeoutMs: realDesktopRuntimeReadyTimeoutMs,
      installTimeoutMs: realDesktopDependencyInstallTimeoutMs,
      onConsentRequired: async (consentPage) => {
        await ocrCheckpoint(consentPage, '01-consent-required');
      },
      onInstallStarted: () => {
        observeOwnedSidecar();
        workerDownloadRequired = true;
      },
      onInstallProgress: async (enginesPage) => {
        await ocrCheckpoint(enginesPage, '01-core-install-started');
      },
      onInstallRetry: async (enginesPage) => {
        await ocrCheckpoint(enginesPage, '01-core-install-retry');
      },
    });
    try {
      await waitUntil(
        () => waitForPackagedRuntimeReadySignal(cdpPort, page).then((ready) => ready || undefined),
        realDesktopRuntimeReadyTimeoutMs,
        'Standalone desktop runtime did not publish a ready signal after first-run setup.',
      );
      const reattached = await reattachToPackagedPage(cdpPort);
      observeOwnedSidecar();
      browser = reattached.browser;
      browserClients.push(browser);
      page = reattached.page;
      observeOcrPageLifecycle(page, browser, app);
      await observeOwnedSidecarFromExecutableSignal(page);
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await injectCheckpointPrivacyStyle(page, isolated);
    } catch (error) {
      const state = await queryPackagedUiState(cdpPort).then((value) => value?.runtimeState).catch(() => undefined);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
        `[runtime-state=${state ?? 'unknown'}]`,
        { cause: error },
      );
    }
    await checkpointJournal?.complete('runtime', 'runtime-ready');
    const computeObservation = await readOcrComputeModeFromSettings(page);
    uiGpuBeforeImport = computeObservation.visible && computeObservation.mode === 'gpu';
    if (acceptance) {
      await checkpointJournal?.begin('ocr_compute', 'compute-preflight');
      if (expectedOcrDevice !== 'directml') {
        throw new Error('Capture Workbench exact-artifact acceptance requires DirectML OCR provenance.');
      }
      const readyPayload = await invokeTauriCommand(page, 'runtime_ready', {});
      authenticatedOcrPreflight = parseAuthenticatedOcrPreflight(readyPayload);
      if (localInstalledRuntime && authenticatedOcrPreflight.contractSetSha256 !== localInstalledRuntime.contractSetSha256) {
        throw new Error('Authenticated Capture Runtime contract identity differs from the local candidate.');
      }
      if (authenticatedOcrPreflight.mode !== 'gpu') {
        throw new Error('Authenticated Capture Runtime OCR preflight did not select GPU.');
      }
      const readyUiState = await queryPackagedUiState(cdpPort);
      if (!uiGpuBeforeImport || !readyUiState?.sourceImportEnabled) {
        throw new Error('Capture Workbench UI did not expose GPU OCR readiness before import.');
      }
      const workerArchiveSha256 = workerMirror?.identity.archiveSha256;
      const expectedWorkerExecutableSha256 = workerMirror?.identity.workerExecutableSha256;
      if (!workerMirror || !workerArchiveSha256 || !expectedWorkerExecutableSha256) {
        throw new Error('Local candidate OCR worker mirror identity was unavailable.');
      }
      if (authenticatedOcrPreflight.workerSha256 !== expectedWorkerExecutableSha256) {
        throw new Error('Authenticated OCR preflight worker SHA does not match the exact worker archive manifest.');
      }
      acceptanceEvidence = {
        acceptanceMode: 'ocr-only',
        ocrProofSucceeded: true,
        structuringSucceeded: false,
        releaseGateSatisfied: false,
        sourceSha256,
        runtimeArtifactSha256: expectedRuntimeSha256,
        contractSetSha256: authenticatedOcrPreflight.contractSetSha256,
        workerArchiveSha256,
        workerExecutableSha256: authenticatedOcrPreflight.workerSha256,
        candidateId: localCandidateModelIdentity?.candidateId,
        catalogSha256: localCandidateModelIdentity?.catalogSha256,
        modelManifestSha256: localCandidateModelIdentity?.modelManifestSha256,
        sourceLockSha256: localCandidateModelIdentity?.sourceLockSha256,
        modelFileCount: localCandidateModelIdentity?.modelFileCount,
        modelExtractedBytes: localCandidateModelIdentity?.modelExtractedBytes,
        authenticatedRuntimePreflight: authenticatedOcrPreflight.mode,
        uiGpuBeforeImport,
      } as AcceptanceEvidenceSummary;
      await checkpointJournal?.complete('ocr_compute', 'compute-preflight');
    }
    acceptanceStage('before-runtime-ready-screenshot');
    await ocrCheckpoint(page, '01-runtime-ready');
    acceptanceStage('after-runtime-ready-screenshot');
    await acceptanceResponsiveLayout(page, acceptance);
    acceptanceStage('after-responsive-layout');
    await deleteCompletedOwnedSmokeDocuments(page);
    const intake = page.getByTestId('ocr-choose-files');
    await intake.waitFor({ state: 'visible', timeout: 15_000 });
    acceptanceStage('before-native-picker');
    await nativeOpenDialogUiAutomation(
      pickerSourcePath,
      app.pid ?? 0,
      () => nativeClickWebViewElement(intake, app.pid ?? 0),
    );
    observeOwnedSidecar();
    acceptanceStage('after-native-picker');
    // A Windows brokered picker temporarily owns the native input boundary.
    // The original Playwright CDP page can remain attached to the pre-picker
    // renderer state after that boundary closes, so reconnect to the live
    // packaged target and use the new page as the import acknowledgment.
    acceptanceStage('before-picker-page-reattach');
    const pickerReattached = await reattachToPackagedPage(cdpPort);
    browser = pickerReattached.browser;
    browserClients.push(browser);
    page = pickerReattached.page;
    observeOcrPageLifecycle(page, browser, app);
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await injectCheckpointPrivacyStyle(page, isolated);
    acceptanceStage('after-picker-page-reattach');
    const libraryProbe = await waitForImportedDocumentId(page, sourceName, 30_000);
    importedDocumentId = libraryProbe.documentId;
    acceptanceStage(`after-picker-library-exact-count-${libraryProbe.count}`);
    const queueRow = exactOcrQueueRow(page, importedDocumentId);
    acceptanceStage('before-document-card-wait');
    await queueRow.waitFor({ state: 'visible', timeout: 60_000 });
    acceptanceStage('after-document-card-wait');
    // Let the native picker close and the first durable processing state render
    // before asking WebView2 for a screenshot.
    await page.waitForTimeout(250);
    await ocrCheckpoint(page, '02-document-processing');

    assert.equal(
      await queueRow.count(),
      1,
      'Standalone desktop smoke document row must identify exactly one document.',
    );
    await checkpointJournal?.begin('ocr_semantic', 'ocr-result');
    const completed = await waitForDesktopOcrCompletion(page, queueRow, 10 * 60_000, {
      documentId: importedDocumentId,
      durableCompletion: isolated ? 'ocr-checkpoint' : 'ocr-checkpoint-or-completed',
      observeLiveness: async () => ({
        appAlive: app.exitCode === null && app.signalCode === null && app.pid !== undefined && isProcessAlive(app.pid),
        runtimeAlive: runtimeSidecarPid !== undefined && isProcessAlive(runtimeSidecarPid),
        cdpOpen: await isLoopbackPortOpen(cdpPort),
        teardownRequested,
        appExitCode: app.exitCode,
        appSignal: app.signalCode,
      }),
      reattach: async () => {
        const attachedAgain = await reattachToPackagedPage(cdpPort);
        browser = attachedAgain.browser;
        browserClients.push(browser);
        page = attachedAgain.page;
        observeOcrPageLifecycle(page, browser, app);
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await injectCheckpointPrivacyStyle(page, isolated);
        return attachedAgain;
      },
      exactOcrQueueRow,
      recordDiagnostic: recordOcrLifecycleDiagnostic,
    });
    page = completed.page;
    await completed.row.getByTestId('ocr-row-view').click();

    // Capture Runtime has already been deleted by the time this checkpoint
    // runs. Read one durable library snapshot and derive every semantic claim
    // from it alongside the visible per-page result controls.
    const durableLibraryDetail = await readDurableLibraryDetail(page, importedDocumentId);
    const expectedPages = expectedVisibleOcrPagesForRaw(durableLibraryDetail.raw);
    const visibleOcr = await readAndAssertVisibleOcrPages(page, expectedPages);
    const rawSegments = extractDurableOcrSegments(durableLibraryDetail);
    const uiResult: RealOcrUiResult = {
      rawText: visibleOcr.rawText,
      rawSegments,
    };
    const pdfPageScope = sourceKind === 'pdf'
      ? readPdfPageScope(durableLibraryDetail)
      : undefined;
    if (sourceKind === 'pdf') {
      if (pdfPageScope === undefined) {
        throw new Error('Packaged PDF raw capture omitted page-scope evidence.');
      }
      if (isolated) {
        assert.deepEqual(
          pdfPageScope.processedPageNumbers,
          [1],
          'Packaged PDF acceptance run must process only page one.',
        );
      }
      const visibleRawPages = uiResult.rawSegments
        .map((segment) => segment.locator.kind === 'page' ? segment.locator.page : undefined)
        .filter((pageNumber): pageNumber is number => pageNumber !== undefined);
      assert.deepEqual(
        [...new Set(visibleRawPages)].sort((left, right) => left - right),
        pdfPageScope.processedPageNumbers,
        'Packaged PDF durable OCR segments must match processed page scope.',
      );
      assert.deepEqual(
        expectedPages.map((entry) => entry.page),
        pdfPageScope.processedPageNumbers,
        'Packaged PDF visible UI pages must match processed page scope.',
      );
    }
    const ocrVerification = assertRealOcrOnlyResult(uiResult, ocrExpectation, sourceFixtureName);
    if (acceptance) {
      importedSourceSha256 = readImportedSourceSha256(durableLibraryDetail);
      assert.equal(
        importedSourceSha256,
        sourceSha256,
        'Packaged desktop runtime imported bytes must match the supplied source digest.',
      );
      acceptanceEvidence = {
        ...acceptanceEvidence,
        importedSourceSha256,
      };
      if (sourceKind !== 'pdf' && sourceKind !== 'image') {
        throw new Error('Installed OCR semantic evidence requires an image or PDF fixture.');
      }
      assertDurableOcrCheckpoint(durableLibraryDetail, {
        sourceKind,
        sourceSha256,
        rawSegments: uiResult.rawSegments,
      });
    }
    await ocrCheckpoint(page, '03-ocr-checkpoint');

    const ocr = await assertDiagnosticsMatchesDurableOcr(page, durableLibraryDetail, importedDocumentId);
    assertExpectedOcrDevice(ocr.device, expectedOcrDevice);
    if (acceptance) {
      if (sourceKind !== 'image' && sourceKind !== 'pdf') {
        throw new Error('Installed OCR semantic evidence requires an image or PDF fixture.');
      }
      if (localInstalledRuntime === undefined || authenticatedOcrPreflight === undefined) {
        throw new Error('Installed OCR semantic evidence identity was unavailable after the durable journey.');
      }
      const proof = await verifyInstalledOcrExecutionProof({
        artifactRoot: acceptance.artifactRoot,
        expected: {
          sourceKind,
          sourceSha256,
          runtimeSha256: localInstalledRuntime.runtimeSha256,
          workerSha256: authenticatedOcrPreflight.workerSha256,
          contractSetSha256: authenticatedOcrPreflight.contractSetSha256,
        },
      });
      ocrExecutionProof = proof;
      acceptanceEvidence = {
        ...acceptanceEvidence,
        ocrExecutionProof: proof,
      };
      const proofIdentity: OcrSemanticExecutionProofIdentity = {
        sourceSha256: proof.sourceSha256,
        runtimeSha256: proof.runtimeSha256,
        workerSha256: proof.workerSha256,
        modelSha256: proof.modelSha256,
        profileId: proof.profileId,
        profileSpecSha256: proof.profileSpecSha256,
        contractSetSha256: proof.contractSetSha256,
        requestedPageScope: proof.requestedPageScope === null ? null : [...proof.requestedPageScope],
        device: authenticatedOcrPreflight.mode === 'gpu' ? 'directml' : 'cpu',
      };
      semanticArtifactIdentity = await emitAcceptanceSemanticEvidence({
        sourceKind,
        artifactRoot: acceptance.artifactRoot,
        pdfPageScope,
        buildOcrOnly: () => buildOcrOnlySemanticEvidence(durableLibraryDetail, {
          runId: acceptance.runId,
          fixtureName: sourceFixtureName,
          sourceKind,
          sourceSha256,
          runtimeVersion: localInstalledRuntime.runtimeVersion,
          runtimeSha256: localInstalledRuntime.runtimeSha256,
          contractSetSha256: authenticatedOcrPreflight.contractSetSha256,
          workerSha256: authenticatedOcrPreflight.workerSha256,
          ocrEngine: ocr.engine,
          ocrModel: ocr.model,
          ocrDevice: ocr.device,
          anchors: ocrExpectation.rawTextIncludes,
          executionProof: proofIdentity,
        }),
      });
    }
    await checkpointJournal?.complete('ocr_semantic', 'ocr-result');

    if (!(await deleteCompletedDocument(
      page,
      sourceName,
      importedDocumentId,
      ['done'],
    ))) {
      throw new Error('Standalone desktop smoke document was not deleted after verification.');
    }
    if (acceptance && !ocrExecutionProof) {
      throw new Error('OCR-only acceptance completed without an authenticated execution proof.');
    }

    const report: RealDesktopSmokeEvidence = {
      evidenceKind: 'real-standalone-tauri-ui-ocr',
      acceptanceMode: 'ocr-only',
      releaseGateSatisfied: false,
      realEnginesExercised: true,
      sourceKind,
      rawOcrVisible: true,
      ocrResultVerified: true,
      ocrProjectionVerified: true,
      rawOcrSegmentCount: ocrVerification.rawSegmentCount,
      structuredBlockCount: 0,
      expectedAnchorCount: ocrVerification.expectedAnchorCount,
      matchedAnchorCount: ocrVerification.matchedAnchorCount,
      ocrDevice: ocr.device,
      documentDeletedAfterVerification: true,
      sourceSha256,
      ...(ocrExecutionProof === undefined ? {} : { ocrExecutionProof }),
    };
    assertRealDesktopSmokeEvidence(report, { acceptance: acceptance !== undefined });
    acceptanceEvidence = {
      acceptanceMode: 'ocr-only',
      ocrProofSucceeded: true,
      structuringSucceeded: false,
      releaseGateSatisfied: false,
      ...acceptanceEvidence,
      sourceSha256,
      expectedAnchorCount: ocrVerification.expectedAnchorCount,
      matchedAnchorCount: ocrVerification.matchedAnchorCount,
      provenance: {
        ocrEngine: ocr.engine,
        ocrModel: ocr.model,
        ocrDevice: ocr.device,
      },
      ...(pdfPageScope === undefined ? {} : { pdfPageScope }),
    };
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await ocrCheckpoint(page, '04-review-complete');
    acceptanceStatus = 'completed';
    process.stdout.write('Real standalone desktop OCR smoke completed.\n');
  } catch (error) {
    await checkpointJournal?.failActive().catch(() => undefined);
    if (acceptance && isRealOcrWorkerFailure(error)) {
      try {
        if (!authenticatedOcrPreflight) {
          throw new Error('Authenticated OCR preflight was unavailable for a worker failure artifact.');
        }
        if (sourceKind === 'unknown') {
          throw new Error('OCR failure evidence requires a recognized source role.');
        }
        verifiedOcrExecutionFailure = await readOcrExecutionFailure(
          acceptance.artifactRoot,
          {
            // Acceptance evidence keeps its own role name for recordings.
            sourceRole: sourceKind === 'recording' ? 'audio' : sourceKind,
            sourceSha256,
            runtimeSha256: expectedRuntimeSha256,
            workerSha256: authenticatedOcrPreflight.workerSha256,
          },
        );
        acceptanceEvidence = {
          ...acceptanceEvidence,
          ocrExecutionFailure: verifiedOcrExecutionFailure,
        };
      } catch {
        acceptanceErrors.push('Capture Workbench OCR failure evidence was missing or invalid.');
      }
    }
    acceptanceErrors.push(error instanceof Error ? error.stack || error.message : String(error));
    throw error;
  } finally {
    if (page) {
      await deleteCompletedDocument(
        page,
        sourceName,
        importedDocumentId,
        ['done', 'needs-attention', 'cancelled'],
      ).catch((error: unknown) => {
        void error;
        process.stderr.write('Standalone desktop smoke cleanup warning.\n');
      });
    }
    if (videoStarted && page) {
      await page.screencast.stop().catch((error: unknown) => {
        acceptanceErrors.push(`video stop failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (acceptance && videoPath && videoStarted) {
      try {
        await assertWebmArtifact(videoPath);
      } catch (error) {
        acceptanceErrors.push(error instanceof Error ? error.message : String(error));
        acceptanceStatus = 'failed';
      }
    }
    teardownRequested = true;
    recordOcrLifecycleDiagnostic('teardown-requested', {
      teardownRequested: true,
      exitCode: app.exitCode,
      signal: app.signalCode,
    });
    const keepRunData = process.env.E2E_ACCEPTANCE_KEEP_APP_DATA === '1';
    sessionCleanup = await finishOwnedDesktopSession({
      page,
      app,
      teardownMode,
      runtimeSidecarPid,
      sidecarObserved,
      browserClients,
      cdpPort,
      webViewData,
      workerMirror,
      removeRunData: async () => {
        if (!acceptance) {
          return rm(pickerSourcePath, { force: true }).then(() => true, () => false);
        }
        // Keeping the app data is a diagnostic: its cleanup stays unproven.
        if (keepRunData) return false;
        let removed = true;
        for (const directory of ['app-data', 'local-app-data']) {
          await rm(resolve(acceptance.artifactRoot, directory), { recursive: true, force: true }).catch(() => {
            removed = false;
          });
        }
        return removed && !(await stat(appData).then(() => true).catch(() => false));
      },
      report: (message) => acceptanceErrors.push(message),
    });
    browser = undefined;
    if (acceptance) {
      const artifacts = [
        ...checkpointScreenshots.map((path) => ({ path, kind: 'screenshot' as const })),
        ...(videoPath && videoStarted ? [{ path: videoPath, kind: 'video' as const }] : []),
        ...(acceptanceEvidence?.ocrExecutionProof
          ? [{
              path: join(acceptance.artifactRoot, acceptanceEvidence.ocrExecutionProof.artifactPath),
              kind: 'log' as const,
            }]
          : []),
        ...(acceptanceEvidence?.ocrExecutionFailure
          ? [{
              path: join(acceptance.artifactRoot, acceptanceEvidence.ocrExecutionFailure.artifactPath),
              kind: 'log' as const,
            }]
          : []),
        ...(semanticArtifactIdentity
          ? [{
              path: join(acceptance.artifactRoot, semanticArtifactIdentity.path),
              kind: 'report' as const,
              expectedIdentity: {
                bytes: semanticArtifactIdentity.bytes,
                sha256: semanticArtifactIdentity.sha256,
              },
            }]
          : []),
      ];
      let scopeFinalizationFailed = false;
      try {
        await writeAcceptanceManifest(acceptance.artifactRoot, {
          project: acceptance.project,
          runId: acceptance.runId,
          status: acceptanceStatus,
          recordVideo: acceptance.recordVideo,
          artifacts,
          errors: acceptanceErrors,
          consoleErrors,
          pageErrors,
          cleanup: {
            app: sessionCleanup.app,
            sidecar: sessionCleanup.sidecar,
            cdpPort: sessionCleanup.cdpPort,
            temporaryAppData: sessionCleanup.runData,
            ownedPids: sessionCleanup.app && sessionCleanup.sidecar,
            ownedListeners: sessionCleanup.cdpPort && sessionCleanup.workerMirrorReleased,
            ownedWorkers: sessionCleanup.sidecar && sessionCleanup.workerMirrorReleased &&
              (!workerDownloadRequired || (workerMirror !== undefined && workerMirror.requests > 0)),
          },
          fixture: {
            name: sourceFixtureName,
            sha256: sourceSha256,
          },
          verifiedOcrExecutionFailure,
          evidence: acceptanceEvidence,
        });
      } finally {
        if (localScopeOwner) {
          try {
            await localScopeOwner.finalizeFromManifest(
              join(acceptance.artifactRoot, 'acceptance-manifest.json'),
            );
          } catch {
            scopeFinalizationFailed = true;
            acceptanceErrors.push('Capture Workbench acceptance scope finalization failed.');
          }
        }
      }
      if (scopeFinalizationFailed) {
        acceptanceArtifactFailure = new Error(
          'Capture Workbench acceptance scope evidence was incomplete.',
        );
      }
      if (acceptanceErrors.length > 0) {
        acceptanceArtifactFailure = new Error(
          `Capture Workbench acceptance artifact validation failed: ${acceptanceErrors.join('; ')}`,
        );
      }
    }
  }
  if (acceptanceArtifactFailure) throw acceptanceArtifactFailure;
  } finally {
    if (launchedApp && !await closeOwnedDesktopRoot(launchedApp)) {
      acceptanceErrors.push('Exact packaged-app root close remained unproven after the outer retry.');
    }
    if (!sessionCleanup && workerMirror) {
      await workerMirror.close().catch(() => undefined);
    }
    if (webViewData) await rm(webViewData, { recursive: true, force: true }).catch(() => undefined);
    if (cdpPort) await waitForPortClosed(cdpPort).catch(() => undefined);
    if (!isolated && pickerSourcePathForCleanup) await rm(pickerSourcePathForCleanup, { force: true }).catch(() => undefined);
  }

  async function ocrCheckpoint(checkpointPage: Page, name: DesktopOcrAcceptanceCheckpointName): Promise<void> {
    await checkpointScreenshot(checkpointPage, acceptance?.artifactRoot, checkpointScreenshots, name, options.checkpoint);
  }
}

export const DESKTOP_OCR_ACCEPTANCE_CHECKPOINTS = [
  '01-consent-required',
  '01-core-install-started',
  '01-core-install-retry',
  '01-runtime-ready',
  '02-document-processing',
  '03-ocr-checkpoint',
  '04-review-complete',
] as const;

export type DesktopOcrAcceptanceCheckpointName =
  (typeof DESKTOP_OCR_ACCEPTANCE_CHECKPOINTS)[number];

async function acceptanceResponsiveLayout(
  page: Page,
  acceptance: AcceptanceRun | undefined,
): Promise<void> {
  if (!acceptance) return;
  // A packaged Tauri WebView is not a Playwright-owned browser context:
  // setViewportSize() emulates a CSS viewport and can block WebView2 instead
  // of resizing the native window. Keep the acceptance proof programmatic and
  // run responsive-window coverage in the dedicated browser E2E project.
  const layout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  assert.ok(
    layout.documentWidth <= layout.viewportWidth && layout.bodyWidth <= layout.viewportWidth,
    `Packaged desktop viewport overflowed at ${layout.viewportWidth}px.`,
  );
}

function readPdfPageScope(detail: DurableLibraryDetailRecord): PdfPageScopeEvidence {
  const raw = (detail as { readonly raw?: unknown }).raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Packaged PDF library detail omitted raw OCR data.');
  }
  const scope = (raw as { readonly ocrPageScope?: unknown }).ocrPageScope;
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('Packaged PDF raw OCR data omitted page-scope evidence.');
  }
  const record = scope as {
    readonly sourcePageCount?: unknown;
    readonly requestedPageNumbers?: unknown;
    readonly processedPageNumbers?: unknown;
  };
  assert.ok(
    Number.isSafeInteger(record.sourcePageCount)
      && Number(record.sourcePageCount) >= 1
      && Number(record.sourcePageCount) <= 500,
    'Packaged PDF source page count was invalid.',
  );
  const requested = record.requestedPageNumbers;
  const processed = record.processedPageNumbers;
  assert.ok(
    Array.isArray(requested)
      && requested.length >= 1
      && requested.length <= 500
      && requested.every((value) => Number.isSafeInteger(value) && Number(value) >= 1),
    'Packaged PDF requested page evidence was invalid.',
  );
  assert.ok(
    Array.isArray(processed)
      && processed.length >= 1
      && processed.length <= 500
      && processed.every((value) => Number.isSafeInteger(value) && Number(value) >= 1),
    'Packaged PDF processed page evidence was invalid.',
  );
  const sourcePageCount = Number(record.sourcePageCount);
  const requestedPageNumbers = requested as number[];
  const processedPageNumbers = processed as number[];
  assert.deepEqual(
    requestedPageNumbers,
    requestedPageNumbers.map((_, index) => index + 1),
    'Packaged PDF requested pages were not an ordered prefix.',
  );
  assert.ok(
    requestedPageNumbers.at(-1)! <= sourcePageCount,
    'Packaged PDF requested pages exceeded the source page count.',
  );
  assert.deepEqual(
    processedPageNumbers,
    requestedPageNumbers,
    'Packaged PDF processed pages did not equal requested pages.',
  );
  return {
    sourcePageCount,
    requestedPageNumbers: [...requestedPageNumbers],
    processedPageNumbers: [...processedPageNumbers],
  };
}

export function readImportedSourceSha256(detail: DurableLibraryDetailRecord): string {
  const raw = (detail as { readonly raw?: unknown }).raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Packaged library detail omitted raw OCR data while verifying source identity.');
  }
  const source = (raw as { readonly source?: unknown }).source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Packaged raw OCR data omitted source identity.');
  }
  const sha256 = (source as { readonly sha256?: unknown }).sha256;
  assert.ok(
    typeof sha256 === 'string' && /^[a-f0-9]{64}$/u.test(sha256),
    'Packaged raw OCR source identity digest was invalid.',
  );
  return sha256;
}

export function readDurableOcrProvenance(detail: DurableLibraryDetailRecord): {
  readonly engine: 'text-recognition';
  readonly model: string;
  readonly device: OcrDevice;
  readonly digest: string;
} {
  const raw = detail.raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Packaged OCR checkpoint omitted durable raw capture.');
  }
  const extractionEngine = (raw as { readonly extractionEngine?: unknown }).extractionEngine;
  if (extractionEngine === null || typeof extractionEngine !== 'object' || Array.isArray(extractionEngine)) {
    throw new Error('Packaged OCR checkpoint omitted OCR provenance.');
  }
  const record = extractionEngine as {
    readonly engine?: unknown;
    readonly model?: unknown;
    readonly device?: unknown;
    readonly digest?: unknown;
  };
  if (
    record.engine !== 'text-recognition'
    || typeof record.model !== 'string'
    || !record.model.trim()
    || (record.device !== 'directml' && record.device !== 'cpu')
    || typeof record.digest !== 'string'
    || !record.digest.trim()
  ) {
    throw new Error('Packaged OCR checkpoint exposed unrecognized OCR provenance.');
  }
  return {
    engine: 'text-recognition',
    model: record.model,
    device: record.device,
    digest: record.digest.trim(),
  };
}

export function assertDurableOcrCheckpoint(
  detail: DurableLibraryDetailRecord,
  expected: {
    readonly sourceKind: 'image' | 'pdf';
    readonly sourceSha256: string;
    readonly rawSegments: readonly RealOcrUiSegment[];
  },
): void {
  assert.equal(detail.status, 'awaiting_confirmation', 'OCR checkpoint must retain awaiting_confirmation document status.');
  assert.equal(detail.stage, 'awaiting_structuring', 'OCR checkpoint must retain awaiting_structuring runtime stage.');
  assert.ok(
    detail.captureId === undefined || detail.captureId === null,
    'OCR checkpoint must clear the ephemeral runtime capture ID.',
  );
  assert.ok(
    detail.result === undefined || detail.result === null,
    'OCR checkpoint must not persist a structured result.',
  );
  const raw = detail.raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Packaged OCR checkpoint omitted durable raw capture.');
  }
  const rawRecord = raw as {
    readonly source?: unknown;
    readonly sourceText?: unknown;
    readonly segments?: unknown;
  };
  const source = rawRecord.source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Packaged OCR checkpoint omitted source identity.');
  }
  assert.equal((source as { readonly sha256?: unknown }).sha256, expected.sourceSha256);
  if (typeof rawRecord.sourceText !== 'string' || !rawRecord.sourceText.trim() || !Array.isArray(rawRecord.segments)) {
    throw new Error('Packaged OCR checkpoint omitted a usable raw OCR projection.');
  }
  assert.equal(rawRecord.sourceText, expected.rawSegments.map((segment) => segment.text).join('\n'));
  assertDurableOcrSegmentsEqual(
    rawRecord.segments,
    expected.rawSegments,
    'durable raw OCR segments must equal the public UI projection.',
  );

  const evidence = detail.ocrEvidence;
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Packaged OCR checkpoint omitted durable OcrEvidence.');
  }
  const evidenceRecord = evidence as {
    readonly schemaVersion?: unknown;
    readonly captureId?: unknown;
    readonly sourceSha256?: unknown;
    readonly status?: unknown;
    readonly pageCount?: unknown;
    readonly pages?: unknown;
    readonly digest?: unknown;
    readonly provenance?: unknown;
  };
  assert.equal(evidenceRecord.schemaVersion, 1);
  assert.ok(typeof evidenceRecord.captureId === 'string' && evidenceRecord.captureId.trim());
  assert.equal(evidenceRecord.sourceSha256, expected.sourceSha256);
  assert.equal(evidenceRecord.status, 'completed');
  assert.ok(Number.isSafeInteger(evidenceRecord.pageCount) && Number(evidenceRecord.pageCount) > 0);
  assert.ok(Array.isArray(evidenceRecord.pages) && evidenceRecord.pages.length === evidenceRecord.pageCount);
  assert.match(String(evidenceRecord.digest ?? ''), /^[a-f0-9]{64}$/u);
  const pages = evidenceRecord.pages as readonly unknown[];
  assert.ok(pages.some((page) => page && typeof page === 'object' && (page as { status?: unknown }).status === 'recognized'));
  assert.ok(pages.every((page) => {
    if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
    const status = (page as { status?: unknown }).status;
    return status === 'recognized' || status === 'empty';
  }), 'OCR checkpoint OcrEvidence must not contain a failed page.');
  if (expected.sourceKind === 'image') assert.equal(evidenceRecord.pageCount, 1);
  const provenance = evidenceRecord.provenance;
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error('Packaged OCR checkpoint omitted OcrEvidence provenance.');
  }
  const provenanceRecord = provenance as {
    readonly status?: unknown;
    readonly engine?: unknown;
    readonly model?: unknown;
    readonly modelDigest?: unknown;
    readonly device?: unknown;
    readonly profileId?: unknown;
    readonly profileSpecSha256?: unknown;
    readonly workerSha256?: unknown;
  };
  assert.equal(provenanceRecord.status, 'resolved');
  assert.equal(provenanceRecord.engine, 'text-recognition');
  assert.ok(typeof provenanceRecord.model === 'string' && provenanceRecord.model.trim());
  assert.match(String(provenanceRecord.modelDigest ?? ''), /^sha256:[a-f0-9]{64}$/u);
  assert.ok(provenanceRecord.device === 'directml' || provenanceRecord.device === 'cpu');
  assert.ok(typeof provenanceRecord.profileId === 'string' && provenanceRecord.profileId.trim());
  assert.match(String(provenanceRecord.profileSpecSha256 ?? ''), /^[a-f0-9]{64}$/u);
  assert.match(String(provenanceRecord.workerSha256 ?? ''), /^[a-f0-9]{64}$/u);
}

export async function readOcrProvenance(
  page: Page,
  documentId?: string,
): Promise<{
  engine: 'text-recognition';
  model: string;
  device: OcrDevice;
  digest: string;
  evidenceDigest?: string;
}> {
  await page.getByTestId('result-nav-details').click();
  const diagnosticsLink = page.getByTestId('result-detail-diagnostics');
  await diagnosticsLink.waitFor({ state: 'visible', timeout: 30_000 });
  await diagnosticsLink.click();
  await page.getByTestId('page-settings-diagnostics').waitFor({ state: 'visible', timeout: 30_000 });
  if (documentId !== undefined) {
    const diagnosticsDocument = page.getByTestId('diagnostics-document');
    await diagnosticsDocument.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(
      await diagnosticsDocument.getAttribute('data-document-id'),
      documentId,
      'Diagnostics page did not display the verified document.',
    );
  }
  const element = page.getByTestId('diagnostics-extraction-provenance');
  await element.waitFor({ state: 'visible', timeout: 30_000 });
  const evidenceDigestElement = page.getByTestId('diagnostics-evidence-digest');
  const [engine, model, device, digest, evidenceDigestVisible] = await Promise.all([
    element.getAttribute('data-engine'),
    element.getAttribute('data-model'),
    element.getAttribute('data-device'),
    element.getAttribute('data-digest'),
    evidenceDigestElement.isVisible().catch(() => false),
  ]);
  const evidenceDigest = evidenceDigestVisible
    ? (await evidenceDigestElement.textContent().catch(() => undefined))?.trim() || undefined
    : undefined;
  return {
    ...parseOcrProvenance({ engine, model, device }),
    digest: digest?.trim() ?? '',
    ...(evidenceDigest === undefined ? {} : { evidenceDigest }),
  };
}

export async function assertDiagnosticsMatchesDurableOcr(
  page: Page,
  detail: DurableLibraryDetailRecord,
  documentId: string,
): Promise<{
  readonly engine: 'text-recognition';
  readonly model: string;
  readonly device: OcrDevice;
  readonly digest: string;
}> {
  const durable = readDurableOcrProvenance(detail);
  const ui = await readOcrProvenance(page, documentId);
  assert.equal(ui.engine, durable.engine, 'Diagnostics OCR engine must match durable provenance.');
  assert.equal(ui.model, durable.model, 'Diagnostics OCR model must match durable provenance.');
  assert.equal(ui.device, durable.device, 'Diagnostics OCR device must match durable provenance.');
  assert.equal(ui.digest, durable.digest, 'Diagnostics OCR digest must match durable extraction digest.');
  const evidence = detail.ocrEvidence;
  if (evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const expectedEvidenceDigest = (evidence as { readonly digest?: unknown }).digest;
    if (typeof expectedEvidenceDigest === 'string' && expectedEvidenceDigest.trim()) {
      assert.equal(
        ui.evidenceDigest,
        expectedEvidenceDigest.trim(),
        'Diagnostics OCR evidence digest must match durable OcrEvidence digest.',
      );
    }
  }
  return durable;
}

export function parseOcrProvenance(attributes: {
  readonly engine: string | null | undefined;
  readonly model: string | null | undefined;
  readonly device: string | null | undefined;
}): {
  engine: 'text-recognition';
  model: string;
  device: OcrDevice;
} {
  const engine = attributes.engine?.trim() ?? '';
  const model = attributes.model?.trim() ?? '';
  const device = attributes.device?.trim() ?? '';
  if (
    engine !== 'text-recognition' ||
    !model ||
    (device !== 'directml' && device !== 'cpu')
  ) {
    throw new Error('Standalone desktop UI did not display a recognized OCR device provenance.');
  }
  return { engine, model, device };
}

export interface InstalledJourneyOcrProofExpectation {
  readonly sourceKind: 'image' | 'pdf';
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  readonly workerSha256: string;
  readonly contractSetSha256: string;
}

export async function verifyInstalledOcrExecutionProof(options: {
  readonly artifactRoot: string;
  readonly expected: InstalledJourneyOcrProofExpectation;
  readonly readProof?: typeof readOcrExecutionProof;
  readonly assertMatches?: typeof assertOcrExecutionProofMatchesInstalledJourney;
}): Promise<AcceptanceOcrExecutionProofSummary> {
  const proof = await (options.readProof ?? readOcrExecutionProof)(options.artifactRoot);
  (options.assertMatches ?? assertOcrExecutionProofMatchesInstalledJourney)(proof, options.expected);
  return proof;
}

export async function emitAcceptanceSemanticEvidence(options: {
  readonly sourceKind: 'image' | 'pdf';
  readonly artifactRoot: string;
  readonly pdfPageScope?: PdfPageScopeEvidence;
  readonly buildOcrOnly: () => OcrSemanticEvidenceV1;
  readonly assertPdfPageOne?: typeof assertPdfPageOneSemanticEvidence;
  readonly writeArtifact?: typeof writeOcrSemanticEvidenceArtifact;
}): Promise<OcrSemanticArtifactIdentity> {
  const writeArtifact = options.writeArtifact ?? writeOcrSemanticEvidenceArtifact;
  const semanticEvidence = options.buildOcrOnly();
  if (options.sourceKind === 'pdf') {
    assert.ok(options.pdfPageScope, 'Phase 1 PDF semantic gate requires durable page-scope evidence.');
    (options.assertPdfPageOne ?? assertPdfPageOneSemanticEvidence)(
      options.pdfPageScope,
      semanticEvidence,
    );
  }
  return writeArtifact(
    join(options.artifactRoot, semanticEvidence.artifactPath),
    semanticEvidence,
  );
}

export function assertOcrExecutionProofMatchesInstalledJourney(
  proof: AcceptanceOcrExecutionProofSummary,
  expected: InstalledJourneyOcrProofExpectation,
): void {
  assert.equal(
    proof.sourceSha256,
    expected.sourceSha256,
    'OCR execution proof source digest did not match the supplied fixture.',
  );
  assert.equal(
    proof.runtimeSha256,
    expected.runtimeSha256,
    'OCR execution proof runtime digest did not match the installed candidate.',
  );
  assert.equal(
    proof.workerSha256,
    expected.workerSha256,
    'OCR execution proof worker digest did not match authenticated preflight.',
  );
  assert.equal(
    proof.contractSetSha256,
    expected.contractSetSha256,
    'OCR execution proof contract digest did not match authenticated preflight.',
  );
  assert.deepEqual(
    proof.requestedPageScope,
    expected.sourceKind === 'pdf' ? [1] : null,
    'OCR execution proof page scope did not match the installed journey.',
  );
  if (proof.dmlNodeCount < 1) {
    throw new Error('OCR execution proof did not prove DML execution.');
  }
}

export function parseAuthenticatedOcrPreflight(value: unknown): AuthenticatedOcrPreflightObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Authenticated Capture Runtime readiness payload was invalid.');
  }
  const ready = value as {
    readonly ready?: unknown;
    readonly ocrCompute?: unknown;
  };
  if (ready.ready !== true || ready.ocrCompute === null || typeof ready.ocrCompute !== 'object' || Array.isArray(ready.ocrCompute)) {
    throw new Error('Authenticated Capture Runtime readiness omitted OCR compute evidence.');
  }
  const compute = ready.ocrCompute as {
    readonly contractSetSha256?: unknown;
    readonly workerSha256?: unknown;
    readonly mode?: unknown;
  };
  if (
    typeof compute.contractSetSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(compute.contractSetSha256) ||
    typeof compute.workerSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(compute.workerSha256) ||
    (compute.mode !== 'gpu' && compute.mode !== 'cpu-fallback')
  ) {
    throw new Error('Authenticated Capture Runtime OCR compute evidence was invalid.');
  }
  return {
    contractSetSha256: compute.contractSetSha256,
    workerSha256: compute.workerSha256,
    mode: compute.mode,
  };
}

export function resolveExpectedOcrDevice(
  arguments_: readonly string[],
  environmentValue?: string,
): OcrDevice | undefined {
  const option = '--expected-ocr-device';
  const optionIndexes = arguments_
    .map((argument, index) => (argument === option ? index : -1))
    .filter((index) => index >= 0);
  if (optionIndexes.length > 1) {
    throw new Error(`${option} may be supplied only once.`);
  }
  const value =
    optionIndexes.length === 1
      ? arguments_[optionIndexes[0] + 1]?.trim()
      : environmentValue?.trim();
  if (value === undefined || value === '') return undefined;
  if (value !== 'directml' && value !== 'cpu') {
    throw new Error(`${option} must be directml or cpu.`);
  }
  return value;
}

export function assertExpectedOcrDevice(
  actual: OcrDevice,
  expected: OcrDevice | undefined,
): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`Standalone desktop OCR used ${actual}; expected ${expected}.`);
  }
}

export function isOwnedSmokeDocumentName(value: string): boolean {
  return ownedSmokeDocumentPattern.test(value);
}

async function navigateToOcrPage(page: Page): Promise<void> {
  if (!(await page.getByTestId('page-ocr').isVisible().catch(() => false))) {
    await page.getByTestId('nav-ocr').click();
    await page.getByTestId('page-ocr').waitFor({ state: 'visible', timeout: 30_000 });
  }
  const chooseFiles = page.getByTestId('ocr-choose-files');
  await chooseFiles.waitFor({ state: 'visible', timeout: 15_000 });
}

async function deleteCompletedOwnedSmokeDocuments(page: Page): Promise<void> {
  await navigateToHistoryPage(page);
  const owned = await page.getByTestId('history-row').evaluateAll((elements) => elements.map((element) => ({
    documentId: element.getAttribute('data-document-id') ?? undefined,
    fileName: element.querySelector('td:nth-child(2) a')?.textContent?.trim() ?? '',
  })));
  for (const entry of owned) {
    if (isOwnedSmokeDocumentName(entry.fileName)) {
      await deleteCompletedDocument(page, entry.fileName, entry.documentId);
    }
  }
  await navigateToOcrPage(page);
}

export function exactOcrQueueRow(page: Page, documentId: string): Locator {
  return page.locator(`[data-testid="ocr-queue-row"][data-document-id="${documentId}"]`);
}

export async function waitForDesktopOcrCompletion(
  page: Page,
  row: Locator,
  timeoutMs: number,
  recovery: DesktopOcrPollingRecoveryOptions,
): Promise<{ readonly page: Page; readonly row: Locator }> {
  let currentPage = page;
  let currentRow = row;
  let reattachAttempted = false;
  const deadline = Date.now() + timeoutMs;
  const readDetail = recovery.readDurableDetail ?? readDurableLibraryDetail;

  while (Date.now() < deadline) {
    try {
      const probeBudget = Math.min(5_000, Math.max(1, deadline - Date.now()));
      const userStatus = await withTimeout(
        currentRow.getAttribute('data-user-status'),
        probeBudget,
        'Standalone desktop OCR status probe timed out.',
      );
      if (userStatus === 'done') {
        const detail = await readDetail(currentPage, recovery.documentId);
        // persistOcrCheckpoint$ / persistTerminalData$ clear captureId as the
        // final durable commit step.
        if (detail.captureId === undefined || detail.captureId === null) {
          const isOcrCheckpoint =
            detail.status === 'awaiting_confirmation'
            && detail.stage === 'awaiting_structuring';
          const hasRaw =
            detail.raw !== undefined
            && detail.raw !== null
            && typeof detail.raw === 'object'
            && !Array.isArray(detail.raw);
          if (recovery.durableCompletion === 'ocr-checkpoint') {
            if (isOcrCheckpoint) return { page: currentPage, row: currentRow };
            throw new Error('Standalone desktop OCR checkpoint did not expose awaiting_confirmation / awaiting_structuring durable state.');
          }
          const isCompletedWithRaw = detail.status === 'completed' && hasRaw;
          if ((isOcrCheckpoint && hasRaw) || isCompletedWithRaw) {
            return { page: currentPage, row: currentRow };
          }
          throw new Error('Standalone desktop OCR did not reach an OCR checkpoint or completed state with durable raw capture.');
        }
      } else if (userStatus === 'needs-attention' || userStatus === 'cancelled') {
        const detail = await readDetail(currentPage, recovery.documentId).catch((detailError: unknown) => {
          if (isTauriBridgeClosedError(detailError)) throw detailError;
          return undefined;
        });
        const status = typeof detail?.status === 'string' && detail.status.trim()
          ? detail.status.trim()
          : userStatus;
        const errorCode = typeof detail?.errorCode === 'string' && detail.errorCode.trim()
          ? detail.errorCode.trim()
          : null;
        throw new DesktopOcrTerminalFailure({ status, errorCode });
      }
    } catch (error) {
      if (!isTauriBridgeClosedError(error)) throw error;

      recovery.recordDiagnostic?.('target-loss');
      const liveness = await recovery.observeLiveness().catch(() => ({
        appAlive: false,
        runtimeAlive: false,
        cdpOpen: false,
        teardownRequested: false,
        appExitCode: null,
        appSignal: null,
      } satisfies DesktopOcrPollingLiveness));
      recovery.recordDiagnostic?.('liveness', {
        appAlive: liveness.appAlive,
        runtimeAlive: liveness.runtimeAlive,
        cdpOpen: liveness.cdpOpen,
        teardownRequested: liveness.teardownRequested,
        exitCode: liveness.appExitCode,
        signal: liveness.appSignal,
      });
      if (!liveness.appAlive) throw new DesktopOcrLifecycleFailure('host-lifecycle', liveness);
      if (!liveness.runtimeAlive) throw new DesktopOcrLifecycleFailure('runtime-root-exit', liveness);
      if (!liveness.cdpOpen || liveness.teardownRequested || reattachAttempted) {
        throw new DesktopOcrLifecycleFailure('target-loss', liveness);
      }
      reattachAttempted = true;

      let attached: { readonly browser: Browser; readonly page: Page };
      try {
        attached = await recovery.reattach();
        const nextRow = recovery.exactOcrQueueRow(attached.page, recovery.documentId);
        await nextRow.waitFor({
          state: 'visible',
          timeout: Math.min(15_000, Math.max(1, deadline - Date.now())),
        });
        const count = await withTimeout(
          nextRow.count(),
          Math.min(5_000, Math.max(1, deadline - Date.now())),
          'Reattached desktop OCR queue row probe timed out.',
        );
        if (count !== 1) throw new Error('Reattached desktop OCR queue row was not unique.');
        const nextDocumentId = await nextRow.getAttribute('data-document-id');
        if (nextDocumentId !== recovery.documentId) {
          throw new Error('Reattached desktop OCR document identity changed.');
        }
        await recovery.onReattached?.(attached);
        currentPage = attached.page;
        currentRow = nextRow;
        continue;
      } catch {
        throw new DesktopOcrLifecycleFailure('target-loss', liveness);
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(250, remaining));
  }
  throw new Error('Standalone desktop OCR did not reach completion.');
}

function assertConfiguredHostAppData(appData: string, acceptance?: AcceptanceRun): void {
  if (acceptance) {
    const expected = resolve(acceptance.artifactRoot, 'app-data');
    if (resolve(appData).toLowerCase() !== expected.toLowerCase()) {
      throw new Error('Acceptance Capture app-data must be the run-owned product directory.');
    }
    return;
  }
  const roaming = process.env.APPDATA;
  if (!roaming) {
    throw new Error('APPDATA is required to verify the Tauri host-owned app-data location.');
  }
  if (resolve(appData).toLowerCase() !== resolve(roaming, productIdentifier).toLowerCase()) {
    throw new Error('CAPTURE_REAL_DESKTOP_APP_DATA must be the Tauri host-owned Capture Workbench app-data directory.');
  }
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set explicitly for real standalone desktop OCR smoke.`);
  }
  return resolve(value);
}

function requiredDigestEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be a 64-character lowercase SHA-256 digest.`);
  }
  return value;
}

async function requireRegularFile(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) {
    throw new Error(`${name} must be an existing regular file.`);
  }
}

async function requireDirectory(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isDirectory()) {
    throw new Error(`${name} must be an existing directory.`);
  }
}

export interface PackagedUiState {
  readonly runtimeState: string | null;
  readonly sourceImportEnabled: boolean;
  readonly firstRunOcrVisible: boolean;
  readonly ocrInstallProgressVisible: boolean;
}

interface OcrFirstRunSetupOptions {
  readonly readyTimeoutMs?: number;
  readonly firstRunCardTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly failIfAlreadyReady?: boolean;
  readonly onConsentRequired?: (page: Page) => Promise<void>;
  readonly onInstallStarted?: () => void;
  readonly onInstallProgress?: (page: Page) => Promise<void>;
  readonly onInstallRetry?: (page: Page) => Promise<void>;
}

interface OcrComputeSettingsObservation {
  readonly visible: boolean;
  readonly mode: 'gpu' | 'cpu-fallback' | null;
}

export async function queryPackagedUiState(cdpPort: number): Promise<PackagedUiState | undefined> {
  const response = await withTimeout(
    fetch(`http://127.0.0.1:${cdpPort}/json/list`),
    3_000,
    'Packaged WebView2 CDP target listing timed out.',
  );
  if (!response.ok) throw new Error(`Packaged WebView2 CDP target listing returned ${response.status}.`);
  const targets = await response.json() as Array<{ type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown }>;
  const target = targets.find((candidate) => (
    candidate.type === 'page' &&
    typeof candidate.url === 'string' &&
    isPackagedWorkbenchUrl(candidate.url) &&
    typeof candidate.webSocketDebuggerUrl === 'string'
  ));
  if (!target || typeof target.webSocketDebuggerUrl !== 'string') return undefined;

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Packaged WebView2 CDP socket failed to open.')), { once: true });
    }), 3_000, 'Packaged WebView2 CDP socket open timed out.');
    const responseMessage = await withTimeout(new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      const listener = (event: MessageEvent): void => {
        try {
          const message = JSON.parse(String(event.data)) as { id?: unknown; result?: { result?: { value?: unknown } } };
          if (message.id !== id) return;
          socket.removeEventListener('message', listener);
          resolve(message);
        } catch (error) {
          socket.removeEventListener('message', listener);
          reject(error);
        }
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression: `JSON.stringify({
            runtimeState: document.querySelector('[data-testid="runtime-status"]')?.getAttribute('data-state') ?? null,
            sourceImportEnabled: (() => {
              const element = document.querySelector('[data-testid="ocr-choose-files"]');
              return element instanceof HTMLButtonElement && !element.disabled;
            })(),
            firstRunOcrVisible: Boolean(document.querySelector('[data-testid="first-run-checkbox-ocr"]')),
            ocrInstallProgressVisible: Boolean(document.querySelector('[data-testid="ocr-install-progress"]')),
          })`,
        },
      }));
    }), 3_000, 'Packaged WebView2 UI state probe timed out.');
    const value = (responseMessage as { result?: { result?: { value?: unknown } } }).result?.result?.value;
    if (typeof value !== 'string') return undefined;
    const parsed = JSON.parse(value) as {
      runtimeState?: unknown;
      sourceImportEnabled?: unknown;
      firstRunOcrVisible?: unknown;
      ocrInstallProgressVisible?: unknown;
    };
    return {
      runtimeState: typeof parsed.runtimeState === 'string' ? parsed.runtimeState : null,
      sourceImportEnabled: parsed.sourceImportEnabled === true,
      firstRunOcrVisible: parsed.firstRunOcrVisible === true,
      ocrInstallProgressVisible: parsed.ocrInstallProgressVisible === true,
    };
  } finally {
    socket.close();
  }
}

export function readOcrRequirementStatus(page: Page): Promise<string | null> {
  return readRequirementStatus(page, 'text-recognition');
}

export async function waitForPackagedRuntimeReadySignal(
  cdpPort: number,
  page: Page,
): Promise<boolean> {
  try {
    const state = await queryPackagedUiState(cdpPort);
    if (
      state?.runtimeState !== 'ready'
      || !state.sourceImportEnabled
      || state.firstRunOcrVisible
      || state.ocrInstallProgressVisible
    ) {
      return false;
    }
    const requirementStatus = await readOcrRequirementStatus(page);
    return requirementStatus === 'ready';
  } catch {
    return false;
  }
}

const terminalEngineStatuses = new Set(['failed', 'cancelled', 'manual_action_required']);
const activeOrFailedInstallationStatuses = new Set(['queued', 'running', 'failed', 'cancelled']);

async function ensureCheckboxState(checkbox: Locator, checked: boolean, label: string): Promise<void> {
  if ((await checkbox.count()) === 0 || !(await checkbox.isVisible().catch(() => false))) return;
  if (checked) {
    if (!(await checkbox.isChecked())) await checkbox.check();
    assert.equal(await checkbox.isChecked(), true, `${label} must be checked before installation.`);
  } else {
    if (await checkbox.isChecked()) await checkbox.uncheck();
    assert.equal(await checkbox.isChecked(), false, `${label} must remain unchecked before installation.`);
  }
}

const RETRIED_INSTALLATION_CODES: ReadonlySet<string> = new Set([
  'installation_io_failed',
  'installation_timeout',
]);

async function waitForOcrInstallOnEnginesPage(
  page: Page,
  installTimeoutMs: number,
  options: Pick<OcrFirstRunSetupOptions, 'onInstallStarted' | 'onInstallProgress' | 'onInstallRetry'>,
): Promise<void> {
  if (!(await page.getByTestId('page-settings-engines').isVisible().catch(() => false))) {
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('page-settings-engines').waitFor({ state: 'visible', timeout: 30_000 });
  }
  const ocrRow = page.locator('[data-testid="engine-row"][data-requirement-id="text-recognition"]');
  await ocrRow.waitFor({ state: 'visible', timeout: 30_000 });
  await options.onInstallProgress?.(page);
  let transientRetryCount = 0;
  await waitUntil(
    async () => {
      const runtimeError = await visibleRuntimeError(page);
      if (runtimeError) throw new Error(runtimeError);
      const status = await ocrRow.getAttribute('data-status');
      if (status === 'ready') return true;
      if (status !== null && terminalEngineStatuses.has(status)) {
        const installation = await readLatestInstallation(page, 'text-recognition').catch(() => undefined);
        const errorCode = installation?.errorCode && safeDesktopDocumentErrorCodePattern.test(installation.errorCode)
          ? installation.errorCode
          : 'unknown';
        // Both codes replace the former filesystem failure, which the smoke
        // retried once; a timeout is as transient as a disk error.
        if (status === 'failed' && RETRIED_INSTALLATION_CODES.has(errorCode) && transientRetryCount < 1) {
          transientRetryCount += 1;
          const retry = ocrRow.getByTestId('engine-row-retry');
          await waitUntil(
            () => retry.isEnabled().then((enabled) => enabled || undefined),
            10_000,
            'Capture Workbench did not enable text recognition retry after a transient installation failure.',
          );
          await retry.click();
          options.onInstallStarted?.();
          await options.onInstallRetry?.(page);
          return undefined;
        }
        const errorDetails = page.locator('[data-testid="engine-row-details"][data-requirement-id="text-recognition"]');
        if (!(await errorDetails.isVisible().catch(() => false))) {
          await ocrRow.getByTestId('engine-row-toggle').click().catch(() => undefined);
        }
        const detail = await errorDetails.getByTestId('engine-row-error').textContent().catch(() => undefined);
        throw new Error(
          `Capture Workbench text recognition installation ended status=${status}; errorCode=${errorCode}: ` +
          `${detail?.trim() || (await ocrRow.textContent())?.trim() || 'no detail was rendered.'}`,
        );
      }
      return undefined;
    },
    installTimeoutMs,
    `Capture Workbench text recognition installation did not finish. ${await runtimeSetupDiagnostics(page)}`,
  );
  await navigateToOcrPage(page);
}

export async function runOcrFirstRunSetup(
  page: Page,
  options: OcrFirstRunSetupOptions = {},
): Promise<{ readonly installRequired: boolean }> {
  const readyTimeoutMs = options.readyTimeoutMs ?? realDesktopRuntimeReadyTimeoutMs;
  const firstRunCardTimeoutMs = options.firstRunCardTimeoutMs ?? 60_000;
  const installTimeoutMs = options.installTimeoutMs ?? realDesktopDependencyInstallTimeoutMs;
  await navigateToOcrPage(page);
  await waitUntil(
    async () => {
      const runtimeError = await visibleRuntimeError(page);
      if (runtimeError) throw new Error(runtimeError);
      const state = await page.getByTestId('runtime-status').getAttribute('data-state').catch(() => null);
      return state === 'ready' || undefined;
    },
    readyTimeoutMs,
    `Capture Workbench runtime did not reach ready state. ${await runtimeSetupDiagnostics(page)}`,
  );

  const requirementStatus = await waitUntil(
    async () => {
      const runtimeError = await visibleRuntimeError(page);
      if (runtimeError) throw new Error(runtimeError);
      const status = await readOcrRequirementStatus(page);
      return status ?? undefined;
    },
    readyTimeoutMs,
    `Capture Workbench did not publish runtime requirements for text-recognition. ${await runtimeSetupDiagnostics(page)}`,
  );
  if (requirementStatus === 'ready') {
    if (options.failIfAlreadyReady) {
      throw new Error('Fresh first-run desktop installation unexpectedly started already ready without prompting.');
    }
    return { installRequired: false };
  }

  const latestInstallation = await readLatestInstallation(page, 'text-recognition').catch(() => undefined);
  if (latestInstallation && activeOrFailedInstallationStatuses.has(latestInstallation.status)) {
    await waitForOcrInstallOnEnginesPage(page, installTimeoutMs, options);
    return { installRequired: true };
  }

  const ocrCheckbox = page.getByTestId('first-run-checkbox-ocr');
  const firstRunCheckboxVisible = await waitUntil(
    async () => {
      const runtimeError = await visibleRuntimeError(page);
      if (runtimeError) throw new Error(runtimeError);
      return (await ocrCheckbox.isVisible().catch(() => false)) || undefined;
    },
    firstRunCardTimeoutMs,
    'First-run text recognition checkbox check elapsed.',
  ).catch(() => false);

  if (firstRunCheckboxVisible) {
    await options.onConsentRequired?.(page);
    await ensureCheckboxState(ocrCheckbox, true, 'first-run text recognition checkbox');
    await ensureCheckboxState(page.getByTestId('first-run-checkbox-asr'), false, 'first-run speech recognition checkbox');
    await ensureCheckboxState(page.getByTestId('first-run-checkbox-speakers'), false, 'first-run speaker diarization checkbox');
    const installButton = page.getByTestId('first-run-install');
    await waitUntil(
      () => installButton.isEnabled().then((enabled) => enabled || undefined),
      10_000,
      `Capture Workbench first-run install button remained disabled. ${await runtimeSetupDiagnostics(page)}`,
    );
    await installButton.click();
    options.onInstallStarted?.();
    await waitForOcrInstallOnEnginesPage(page, installTimeoutMs, options);
    return { installRequired: true };
  }

  if (options.failIfAlreadyReady) {
    throw new Error(`Fresh first-run desktop installation did not present the text recognition card (requirement status=${requirementStatus}).`);
  }

  await page.getByTestId('nav-settings').click();
  await page.getByTestId('page-settings-engines').waitFor({ state: 'visible', timeout: 15_000 });
  const ocrRow = page.locator('[data-testid="engine-row"][data-requirement-id="text-recognition"]');
  await ocrRow.waitFor({ state: 'visible', timeout: 15_000 });
  const status = await ocrRow.getAttribute('data-status');
  if (status === 'ready') {
    await navigateToOcrPage(page);
    return { installRequired: false };
  }
  if (status === 'installable') {
    const rowInstall = ocrRow.getByTestId('engine-row-install');
    await waitUntil(
      () => rowInstall.isEnabled().then((enabled) => enabled || undefined),
      10_000,
      'Capture Workbench engines page OCR install button remained disabled.',
    );
    await rowInstall.click();
    options.onInstallStarted?.();
  }
  await waitForOcrInstallOnEnginesPage(page, installTimeoutMs, options);
  return { installRequired: true };
}

export async function readOcrComputeModeFromSettings(page: Page): Promise<OcrComputeSettingsObservation> {
  await page.getByTestId('nav-settings').click();
  const computeNav = page.getByTestId('settings-nav-compute');
  await computeNav.waitFor({ state: 'visible', timeout: 15_000 });
  await computeNav.click();
  await page.getByTestId('page-settings-compute').waitFor({ state: 'visible', timeout: 15_000 });
  const section = page.getByTestId('compute-ocr-section');
  await section.waitFor({ state: 'visible', timeout: 15_000 });
  const observation = await waitUntil<OcrComputeSettingsObservation>(
    async () => {
      const statusOrNotice = section.locator('[data-testid="ocr-compute-status"], [data-testid="ocr-compute-notice"]').first();
      if (await statusOrNotice.isVisible().catch(() => false)) {
        const mode = await statusOrNotice.getAttribute('data-mode');
        return {
          visible: true,
          mode: mode === 'gpu' || mode === 'cpu-fallback' ? mode : null,
        };
      }
      const cpuDetected = section.getByTestId('compute-ocr-detected');
      if (await cpuDetected.isVisible().catch(() => false)) {
        return { visible: true, mode: 'cpu-fallback' };
      }
      return undefined;
    },
    15_000,
    'Capture Workbench Settings › Compute did not publish an OCR compute status.',
  );
  await navigateToOcrPage(page);
  return observation;
}

export async function waitForImportedDocumentId(
  page: Page,
  expectedName: string,
  timeoutMs = 30_000,
): Promise<{ readonly count: number; readonly documentId: string }> {
  return waitUntil(
    async () => {
      const result = await invokeTauriCommand(page, 'library_list', { request: { query: '', status: '' } });
      const records = Array.isArray(result) ? result : [];
      const matches = records.filter((record): record is { readonly fileName?: unknown; readonly documentId?: unknown } => (
        record !== null
        && typeof record === 'object'
        && !Array.isArray(record)
        && (record as { readonly fileName?: unknown }).fileName === expectedName
      ));
      if (matches.length === 0) return undefined;
      if (matches.length !== 1) {
        throw new Error('Standalone desktop smoke filename must identify exactly one document.');
      }
      const documentId = matches[0].documentId;
      if (typeof documentId !== 'string' || !documentId.trim()) {
        throw new Error('Standalone desktop smoke document omitted its document identity.');
      }
      return { count: records.length, documentId };
    },
    timeoutMs,
    'Native picker closed without an exact library import acknowledgement.',
  );
}

export function extractDurableOcrSegments(detail: DurableLibraryDetailRecord): readonly RealOcrUiSegment[] {
  const raw = detail.raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Packaged OCR checkpoint omitted durable raw capture.');
  }
  const segments = (raw as { readonly segments?: unknown }).segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('Packaged OCR checkpoint omitted durable raw segments.');
  }
  return segments.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Durable OCR segments[${index}] must be an object.`);
    }
    const record = entry as {
      readonly segmentId?: unknown;
      readonly order?: unknown;
      readonly locator?: unknown;
      readonly text?: unknown;
    };
    const locatorRecord = record.locator;
    if (locatorRecord === null || typeof locatorRecord !== 'object' || Array.isArray(locatorRecord)) {
      throw new Error(`Durable OCR segments[${index}] omitted locator.`);
    }
    const locatorKind = (locatorRecord as { readonly kind?: unknown }).kind;
    let locator: RealOcrLocator;
    if (locatorKind === 'page') {
      locator = { kind: 'page', page: Number((locatorRecord as { readonly page?: unknown }).page) };
    } else if (locatorKind === 'time') {
      locator = {
        kind: 'time',
        startMs: Number((locatorRecord as { readonly startMs?: unknown }).startMs),
        endMs: Number((locatorRecord as { readonly endMs?: unknown }).endMs),
      };
    } else {
      throw new Error(`Durable OCR segments[${index}] did not expose a supported locator kind.`);
    }
    return {
      segmentId: typeof record.segmentId === 'string' ? record.segmentId : '',
      order: Number(record.order),
      locator,
      text: typeof record.text === 'string' ? record.text : '',
    };
  });
}

export async function readAndAssertVisibleOcrPages(
  page: Page,
  expectedPages: readonly ExpectedVisibleOcrPage[],
  timeoutMs = 30_000,
): Promise<{ readonly rawText: string; readonly pageTexts: readonly string[] }> {
  await page.getByTestId('page-result').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.getByTestId('result-ocr-content').waitFor({ state: 'visible', timeout: timeoutMs });
  const textarea = page.getByTestId('result-page-text');
  await textarea.waitFor({ state: 'visible', timeout: timeoutMs });

  const pageTexts: string[] = [];
  for (const [index, expectedPage] of expectedPages.entries()) {
    await textarea.waitFor({ state: 'visible', timeout: timeoutMs });
    const accepted = assertVisibleOcrPageText(await textarea.inputValue(), expectedPage.text, { trim: false });
    pageTexts.push(accepted);

    if (index + 1 < expectedPages.length) {
      const nextButton = page.getByTestId('result-page-next');
      await nextButton.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await nextButton.isEnabled(), true, 'Result next-page control must be enabled before advancing.');
      const indicator = page.getByTestId('result-page-indicator');
      const previousIndicator = (await indicator.textContent()) ?? '';
      await nextButton.click();
      await waitUntil(
        async () => {
          const current = (await indicator.textContent()) ?? '';
          return current !== previousIndicator || undefined;
        },
        10_000,
        'Result page indicator did not advance after clicking the next-page control.',
      );
    }
  }

  if (expectedPages.length === 1) {
    const nextButton = page.getByTestId('result-page-next');
    if ((await nextButton.count()) > 0 && (await nextButton.isVisible().catch(() => false))) {
      assert.equal(await nextButton.isEnabled(), false, 'Single-page OCR result must not leave next-page enabled.');
    }
  }

  assert.ok(
    pageTexts.some((text) => text.trim().length > 0),
    'Standalone desktop UI did not display non-empty OCR page text.',
  );
  return {
    rawText: pageTexts.filter((text) => text.trim().length > 0).join('\n'),
    pageTexts,
  };
}

export async function runtimeSetupDiagnostics(page: Page): Promise<string> {
  try {
    const runtimeState = await page.getByTestId('runtime-status').getAttribute('data-state').catch(() => undefined);
    const firstRunCardVisible = await page.getByTestId('first-run-card').isVisible().catch(() => false);
    const firstRunOcrCheckboxVisible = await page.getByTestId('first-run-checkbox-ocr').isVisible().catch(() => false);
    const installProgressVisible = await page.getByTestId('ocr-install-progress').isVisible().catch(() => false);
    const engineRows = await page.getByTestId('engine-row').evaluateAll((elements) => elements.map((element) => ({
      id: element.getAttribute('data-requirement-id'),
      status: element.getAttribute('data-status'),
      text: element.textContent?.trim(),
    }))).catch(() => []);
    const runtimeError = await page.getByTestId('diagnostics-runtime-error').textContent().catch(() => undefined);
    let url = 'unknown';
    try {
      url = page.url();
    } catch {
      url = 'unknown';
    }
    return JSON.stringify({
      url,
      runtimeState: runtimeState ?? 'unknown',
      firstRunCardVisible,
      firstRunOcrCheckboxVisible,
      installProgressVisible,
      engineRows,
      runtimeError: runtimeError?.trim(),
    });
  } catch {
    return 'diagnostics-unavailable';
  }
}

function resolveSourceKind(sourcePath: string): SourceKind {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'].includes(extension)) return 'image';
  if (['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'].includes(extension)) return 'recording';
  return 'unknown';
}

function observe<T>(observable: { subscribe: (observer: { next: (value: T) => void; error: (error: unknown) => void }) => unknown }): Promise<T> {
  return new Promise((resolveValue, reject) => observable.subscribe({ next: resolveValue, error: reject }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    process.stderr.write('real_desktop_ocr_acceptance_failed\n');
    process.exitCode = 1;
  });
}
