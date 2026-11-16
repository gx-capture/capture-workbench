// eslint-disable-next-line @nx/enforce-module-boundaries -- repository tooling reads shared release intent.
import { RELEASE_VERSION } from '../../../tools/release/release-intent.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- the catalog's `parts` reading is shared with the release tooling.
import {
  type EngineCatalogWorkerPart,
  catalogDeliveries,
  engineCatalogWorkerSource,
  workerPublishedFiles,
} from '../../../tools/release/engine-catalog-parts.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

import { type Browser, type Locator, type Page } from '@playwright/test';
import { firstValueFrom } from 'rxjs';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import { buildInstalledAppEnvironment } from './contracts/installed.ts';
import {
  connectToInstalledWebView,
  dynamicWebViewCdpPort,
  installedPage,
} from './installed-browser.ts';
import { navigatePackagedRoute } from './packaged-workbench-page.ts';
import {
  expectedStructuringEngine,
  expectedStructuringModel,
} from './real-ollama-smoke.ts';
import {
  createTrackedProcessTreeTerminator,
} from './installed-process-cleanup.ts';
import { appRoot } from './stage-runtime.ts';
import {
  assertProgressiveAudioOracleEvidence,
  assertProgressiveAudioSampleMatchesOracle,
  type ProgressiveAudioObservedOutput,
  type ProgressiveAudioOracleEvidence,
} from './progressive-audio-evidence.ts';

export const REAL_MODEL_RELEASE_VERSION = RELEASE_VERSION;
export const REAL_MODEL_CATALOG_VERSION = '2';
export const REAL_MODEL_DEPENDENCY_ORDER_SCOPE = 'source-lock-model-requirements-only';
export const REAL_MODEL_SOURCE_IMPORT_MODE = 'deterministic-feature-gated-picker-bypass';
export const REAL_MODEL_REQUIREMENT_ORDER = [
  'windowsml-ocr',
  'speech-recognition',
] as const;
export const REAL_MODEL_RUNTIME_READY_TIMEOUT_MS = 3 * 60_000;
export const REAL_MODEL_INSTALL_TIMEOUT_MS = 90 * 60_000;
export const REAL_MODEL_CAPTURE_TIMEOUT_MS = 5 * 60_000;
export const REAL_MODEL_CAPTURE_START_TIMEOUT_MS = 30_000;
export const REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS = 10 * 60_000;
// Both the non-Tauri oracle and the Tauri completion lane use the same exact
// 310-second sample. This guarantees that the real five-minute checkpoint is
// exercised before the terminal completion assertions.
export const REAL_MODEL_AUDIO_SAMPLE_SECONDS = 5 * 60 + 10;
export const PROGRESSIVE_AUDIO_CHECKPOINT_MS = 5 * 60_000;

export function audioCheckpointSatisfied(
  sampleSeconds: number | undefined,
  coveredUntilMs: number,
  revision: number,
  text: string,
): boolean {
  if (!Number.isSafeInteger(coveredUntilMs) || coveredUntilMs <= 0
    || !Number.isSafeInteger(revision) || revision <= 0 || text.trim().length === 0) {
    return false;
  }
  return sampleSeconds !== undefined && sampleSeconds < PROGRESSIVE_AUDIO_CHECKPOINT_MS / 1000
    ? coveredUntilMs > 0
    : coveredUntilMs >= PROGRESSIVE_AUDIO_CHECKPOINT_MS;
}

export function assertAudioDeviceMatchesSourceLock(
  actualDevice: string | null,
  expectedDevice: string,
): void {
  assert.equal(actualDevice, expectedDevice);
}

export function whisperCpuFallbackAllowedForSourceLock(expectedDevice: string): boolean {
  return expectedDevice !== 'cuda';
}

export function shouldUseBackendReuseReadiness(
  reuseRunData: boolean,
  audioOnly: boolean,
): boolean {
  return reuseRunData && audioOnly;
}

export const REAL_MODEL_RESULT_TIMEOUT_MS = 60 * 60_000;
export const NATIVE_SOURCE_DIALOG_CLASSES = ['#32770'] as const;
export const NATIVE_SOURCE_BROKER_DIALOG_CLASSES = ['CabinetWClass', 'ApplicationFrameWindow'] as const;

const SAFE_BACKEND_STATUSES = new Set([
  'active',
  'activating',
  'awaiting_confirmation',
  'blocked',
  'canceled',
  'cancelled',
  'completed',
  'downloading',
  'extracting',
  'failed',
  'idle',
  'installable',
  'installing',
  'not-installed',
  'persisting',
  'preparing',
  'probing',
  'processing',
  'queued',
  'ready',
  'recovery_required',
  'running',
  'starting',
  'stopped',
  'structuring',
  'unavailable',
  'verifying',
]);
const SAFE_BACKEND_REQUIREMENTS = new Set([
  'windowsml-ocr',
  'speech-recognition',
  'ollama-runtime',
  'capture-ollama-model',
]);
const SAFE_INSTALLABLE_REQUIREMENTS = new Set(['windowsml-ocr', 'ollama-runtime', 'speech-recognition']);
const SAFE_MODEL_OPTION_IDS = new Set(['qwen3.5-0.8b-v1', 'qwen3.5-4b-v1']);
const SAFE_TERMINAL_DOCUMENT_STATUSES = new Set(['failed', 'canceled']);
const SAFE_TERMINAL_DOCUMENT_STAGES = new Set([
  'queued',
  'extracting',
  'awaiting_structuring',
  'structuring',
  'persisting',
  'completed',
  'failed',
  'cancelled',
]);
const SAFE_TERMINAL_DOCUMENT_ERROR_CODES = new Set([
  'capture_cancelled',
  'extraction_failed',
  'requirement_unavailable',
  'progressive_failed',
  'progressive_no_text_at_sample',
  'progressive_stall',
  'progressive_worker_exit',
  'progressive_decode_failed',
  'progressive_engine_resolution_failed',
  'progressive_decoder_init_failed',
  'progressive_decoder_process_failed',
  'progressive_decoder_finish_failed',
  'progressive_worker_start_failed',
  'progressive_worker_input_failed',
  'progressive_worker_finish_failed',
  'progressive_worker_event_invalid',
  'progressive_event_persist_failed',
  'progressive_partial_invalid',
  'progressive_output_invalid',
  'progressive_session_failed',
  'session_failed',
  'session_cancelled',
  'structuring_failed',
  'structuring_invalid_output',
]);
const SAFE_WORKER_STAGE_TOKEN = '(?:worker-entry(?:-[a-z0-9-]+)?|python-import-[a-z0-9-]+|ocr-[a-z0-9-]+|speech-[a-z0-9-]+|worker-process-[a-z0-9-]+|worker-stage-sequence-truncated)';
const SAFE_WORKER_STAGE_SEQUENCE = `${SAFE_WORKER_STAGE_TOKEN}(?:>${SAFE_WORKER_STAGE_TOKEN})*`;
const SAFE_TERMINAL_DOCUMENT_FAILURE = new RegExp(
  `^Desktop capture terminated\\. status=(?:failed|canceled); stage=(?:queued|extracting|awaiting_structuring|structuring|persisting|completed|failed|cancelled|unknown); errorCode=(?:capture_cancelled|extraction_failed|requirement_unavailable|progressive_failed|progressive_no_text_at_sample|progressive_stall|progressive_worker_exit|progressive_decode_failed|progressive_engine_resolution_failed|progressive_decoder_init_failed|progressive_decoder_process_failed|progressive_decoder_finish_failed|progressive_worker_start_failed|progressive_worker_input_failed|progressive_worker_finish_failed|progressive_worker_event_invalid|progressive_event_persist_failed|progressive_partial_invalid|progressive_output_invalid|progressive_session_failed|session_failed|session_cancelled|structuring_failed|structuring_invalid_output|unknown)(?:; mediaKind=(?:pdf|image|audio))?(?:; (?:workerStage=${SAFE_WORKER_STAGE_SEQUENCE}|failureReason=(?:no-non-empty-output|validation-failed|runtime-boundary|worker-boundary)))?\\.$`,
  'u',
);
const SAFE_WORKER_FAILURE_MESSAGE = new RegExp(
  `^Source extraction worker failed at (?:(?:stage|stages) )?(${SAFE_WORKER_STAGE_SEQUENCE})\\.$`,
  'u',
);
const SAFE_EXTRACTION_FAILURE_REASONS = new Map<string, string>([
  ['Source extraction produced no non-empty content.', 'no-non-empty-output'],
  ['Source extraction failed validation.', 'validation-failed'],
  ['Source extraction failed at the runtime boundary.', 'runtime-boundary'],
  ['Source extraction worker failed.', 'worker-boundary'],
]);
const SAFE_INSTALLATION_STATUSES = new Set(['failed', 'cancelled', 'manual_action_required']);
const SAFE_INSTALLATION_STAGES = new Set([
  'queued',
  'running',
  'preparing',
  'downloading',
  'verifying',
  'installing',
  'probing',
  'activating',
  'failed',
  'cancelled',
  'manual_action_required',
]);
const SAFE_TERMINAL_INSTALLATION_FAILURE = new RegExp(
  `^Desktop runtime installation terminated\\. requirement=(?:windowsml-ocr|ollama-runtime|speech-recognition); status=(?:failed|cancelled|manual_action_required); stage=(?:queued|running|preparing|downloading|verifying|installing|probing|activating|failed|cancelled|manual_action_required|unknown); errorCode=[a-z][a-z0-9_-]{1,63}; progressBand=(?:early|download|late|unknown)(?:; workerStage=worker-process-[a-z0-9-]+(?:>worker-process-[a-z0-9-]+)*)?(?:; failureReason=(?:direct-model-retries-exhausted|direct-model-http-nonretryable|direct-model-content-length|direct-model-byte-count|direct-model-checksum|direct-model-redirect|runtime-install-unexpected))?\\.$`,
  'u',
);
const SAFE_TERMINAL_MODEL_INSTALLATION_FAILURE = /^Desktop model installation terminated\. status=(?:failed|cancelled|manual_action_required); errorCode=[a-z][a-z0-9_-]{1,63}; progressBand=(?:early|download|late|unknown)\.$/u;
const SAFE_MODEL_INSTALLATION_START_FAILURE = /^Desktop model installation did not start\.$/u;

const workspaceRoot = resolve(appRoot, '..', '..');
const smokeRoot = join(
  workspaceRoot,
  'tmp',
  'capture-workbench-desktop',
  'real-media-model',
);
// Frozen OCR dependencies still include MAX_PATH-sensitive files. Keep the
// owned runtime tree short while leaving the redacted report in the workspace.
const runRoot = resolve(workspaceRoot, '..', '.cwm039');
const temporaryRoot = join(runRoot, 't');
const appDataRoot = join(temporaryRoot, 'a');
const localAppDataRoot = join(temporaryRoot, 'l');
const webViewDataRoot = join(runRoot, 'w');
const evidencePath = join(smokeRoot, 'real-media-model.json');
const sourceLockPath = join(
  workspaceRoot,
  'packages',
  'capture-runtime',
  'model-sources',
  'release-model-source-lock.json',
);
export const generatedCatalogCandidates = [
  join(
    workspaceRoot,
    'packages',
    'capture-runtime',
    'dist',
    'release',
    'capture-engine-catalog.json',
  ),
  join(
    workspaceRoot,
    'packages',
    'capture-runtime',
    'dist',
    'catalog',
    'capture-engine-catalog.json',
  ),
] as const;
const projectImagePath = join(
  workspaceRoot,
  'packages',
  'capture-runtime',
  'model-sources',
  'commit-a',
  'fixtures',
  'ocr-reference.png',
);
const projectPdfPath = join(
  workspaceRoot,
  'packages',
  'capture-runtime',
  'model-sources',
  'commit-a',
  'fixtures',
  'ocr-scanned.pdf',
);
const defaultDesktopExecutable = join(
  appRoot,
  'src-tauri',
  'target',
  'x86_64-pc-windows-msvc',
  'release',
  'capture-workbench-desktop.exe',
);
const workerMirrorRoot = join(workspaceRoot, 'packages', 'capture-runtime', 'dist', 'release');

type JsonObject = { readonly [key: string]: unknown };
type RequirementId = (typeof REAL_MODEL_REQUIREMENT_ORDER)[number];
type SetupRequirementId = RequirementId | 'ollama-runtime' | 'capture-ollama-model';
type MediaKind = 'pdf' | 'image' | 'audio';

interface MediaInput {
  readonly kind: MediaKind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly expectedOcrText?: string;
  readonly expectedOcrTextSha256?: string;
  readonly exactWhisperOutput?: boolean;
  readonly sampleSeconds?: number;
}

interface ExpectedProvenance {
  readonly sourceLockSha256: string;
  readonly catalogSha256: string;
  readonly selectedModelOptionId: 'qwen3.5-0.8b-v1';
  readonly ocrText: string;
  readonly ocrImageSha256: string;
  readonly ocrImageBytes: number;
  readonly ocrPdfSha256: string;
  readonly ocrPdfBytes: number;
  readonly ocrEngine: 'windowsml-ocr';
  readonly ocrModel: string;
  readonly ocrDevice: 'windowsml-dml';
  readonly whisperEngine: 'speech-recognition';
  readonly whisperModel: string;
  readonly whisperDevice: string;
  readonly whisperPreferGpu: boolean;
  readonly whisperNormalizedOutputSha256: string;
  readonly whisperSegmentMinimum: number;
  readonly whisperSegmentMaximum: number;
  readonly whisperFixtureSha256: string;
  readonly whisperFixtureBytes: number;
  readonly workerArchives: readonly WorkerArchive[];
}

interface WorkerArchive {
  readonly requirementId: RequirementId;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  // Empty for one archive; otherwise the ordered parts published in its place.
  readonly parts: readonly EngineCatalogWorkerPart[];
}

interface MediaSummary {
  readonly sourceKind: MediaKind;
  readonly sourceSha256: string;
  readonly extractionEngine: string;
  readonly model: string;
  readonly device: string;
  readonly engineDigest: string;
  readonly structuringEngine: string;
  readonly structuringModel: string;
  readonly structuringDigest: string;
  readonly structuredBlockCount: number;
  readonly segmentCount: number;
  readonly pageLocators?: number;
  readonly timeLocators?: number;
  readonly durationMs: number;
}

export interface RealMediaModelEvidence {
  readonly evidenceKind: 'real-model-enabled-tauri-host-smoke';
  readonly sourceImportMode: typeof REAL_MODEL_SOURCE_IMPORT_MODE;
  readonly nativePickerExercised: false;
  readonly releaseGateSatisfied: false;
  readonly localProductionPreflight: true;
  readonly consumerE2e: false;
  readonly runtimeVersion: typeof REAL_MODEL_RELEASE_VERSION;
  readonly catalogVersion: typeof REAL_MODEL_CATALOG_VERSION;
  readonly sourceLockSha256: string;
  readonly catalogSha256: string;
  readonly selectedModelOptionId: 'qwen3.5-0.8b-v1';
  readonly modelDependencyOrder: readonly RequirementId[];
  readonly modelDependencyOrderScope: typeof REAL_MODEL_DEPENDENCY_ORDER_SCOPE;
  readonly media: readonly [MediaSummary, MediaSummary, MediaSummary];
  readonly rawPersisted: true;
  readonly resultPersisted: true;
  readonly consentedInstallation: true;
  readonly capturesDeletedAfterVerification: true;
  readonly ownedProcessCleanupVerified: true;
  readonly cdpPortReleased: true;
  readonly candidateMirrorUsed: true;
  readonly candidateMirrorReleased: true;
  readonly isolatedAppDataUsed: true;
}

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, 'utf8');
}

export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

type CatalogDelivery = ReturnType<typeof catalogDeliveries>[number];

// The cpu speech content ships these model directories plus the license and
// notice files they cite. `cpu_speech_model_delivery` in
// packages/capture-runtime/scripts/model_source_lock.py is the rule the catalog
// generator applies; both sides are tested against
// packages/capture-runtime/tests/fixtures/cpu-speech-subset-samples.json.
const CPU_SPEECH_MODEL_ROOTS = [
  'model/aligner',
  'model/fallback',
  'model/fallback-architecture',
] as const;
const CPU_SPEECH_FORBIDDEN_ROOTS = [
  'model/primary',
  'model/primary-architecture',
] as const;

function pathUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The lock's speech files that the cpu content delivers, in lock order. */
export function cpuSpeechModelFiles(lockFiles: readonly unknown[]): JsonObject[] {
  const records = lockFiles.map((item) => asObject(item, 'speech source-lock file'));
  const byPath = new Map<string, JsonObject>();
  for (const file of records) {
    byPath.set(requiredString(file.path, 'speech source-lock path'), file);
  }
  const selected = new Set(
    [...byPath.keys()].filter((path) => CPU_SPEECH_MODEL_ROOTS.some((root) => pathUnder(path, root))),
  );
  for (const path of [...selected]) {
    const file = byPath.get(path);
    for (const field of ['licensePath', 'noticePath']) {
      const referenced = file?.[field];
      if (referenced === null) continue;
      if (typeof referenced !== 'string' || !byPath.has(referenced)) {
        throw new Error('speech-recognition cpu model files cite a path that is not locked.');
      }
      selected.add(referenced);
    }
  }
  return records.filter((file) => selected.has(String(file.path)));
}

/**
 * One delivery against the files the lock says it must carry: worker
 * metadata, model version, files, lock binding and manifest digest.
 */
function verifiedDeliveryWorker(
  delivery: CatalogDelivery,
  expectedFiles: readonly unknown[],
  lockRequirement: JsonObject,
  sourceLockHash: string,
  label: string,
): Omit<WorkerArchive, 'requirementId'> {
  const { requirementId, artifacts } = delivery;
  const modelFiles = asObject(delivery.modelFiles, `${label} model delivery`);
  if (!Array.isArray(artifacts) || artifacts.length !== 1 || delivery.unavailableReason !== null) {
    throw new Error(`${label} catalog delivery is incomplete or unavailable.`);
  }
  const artifact = asObject(artifacts[0], `${label} worker artifact`);
  if (artifact.role !== 'worker'
    || artifact.requirementId !== requirementId
    || artifact.artifactVersion !== REAL_MODEL_RELEASE_VERSION
    || artifact.platform !== 'windows'
    || artifact.arch !== 'x86_64'
    || typeof artifact.entryPoint !== 'string'
    || !artifact.entryPoint.endsWith('.exe')) {
    throw new Error(`${label} worker artifact version drifted.`);
  }
  if (!Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 1
    || !Number.isSafeInteger(artifact.extractedBytes) || Number(artifact.extractedBytes) < 1
    || typeof artifact.fileName !== 'string') {
    throw new Error(`${label} worker artifact metadata is malformed.`);
  }
  const { parts } = engineCatalogWorkerSource(artifact, artifact.fileName, Number(artifact.bytes));
  if (modelFiles.artifactVersion !== REAL_MODEL_RELEASE_VERSION) {
    throw new Error(`${label} model artifact version drifted.`);
  }
  if (modelFiles.entryPoint !== lockRequirement.entryPoint
    || !canonicalJson(modelFiles.files).equals(canonicalJson(expectedFiles))) {
    throw new Error(`${label} generated model files drifted from the source lock.`);
  }
  if (modelFiles.sourceLockSha256 !== sourceLockHash) {
    throw new Error(`${label} catalog model files are not bound to the source lock.`);
  }
  const modelManifest = {
    artifactVersion: modelFiles.artifactVersion,
    entryPoint: modelFiles.entryPoint,
    files: modelFiles.files,
    manifestVersion: '1',
  };
  if (modelFiles.manifestSha256 !== sha256(canonicalJson(modelManifest))) {
    throw new Error(`${label} model manifest hash drifted.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(artifact.sha256))
    || !/^[a-f0-9]{64}$/u.test(String(artifact.filesManifestSha256))
    || !/^[a-f0-9]{64}$/u.test(String(modelFiles.manifestSha256))) {
    throw new Error(`${label} catalog artifact digests are invalid.`);
  }
  return {
    fileName: requiredString(artifact.fileName, `${label} worker file name`),
    bytes: Number(artifact.bytes),
    sha256: requiredString(artifact.sha256, `${label} worker SHA-256`),
    parts,
  };
}

/**
 * The worker this smoke installs: OCR's single delivery, or speech's `cuda`
 * content. Both must carry the lock's full files. Speech must also offer the
 * `cpu` content, which carries exactly the cpu speech subset and no primary path.
 */
function verifiedRequirementWorker(
  requirement: JsonObject,
  lockRequirement: JsonObject,
  sourceLockHash: string,
  requirementId: RequirementId,
): WorkerArchive {
  const deliveries = catalogDeliveries(requirement);
  if (
    requirementId === 'speech-recognition'
    && deliveries.map((item) => item.contentId ?? '').sort().join(',') !== 'cpu,cuda'
  ) {
    throw new Error('speech-recognition catalog must offer the cuda and cpu contents.');
  }
  const installed = deliveries.find((item) => item.contentId === undefined || item.contentId === 'cuda');
  if (!installed) {
    throw new Error(`${requirementId} catalog delivery is incomplete or unavailable.`);
  }
  // An array of at least one file: checked when the lock was read.
  const lockFiles = lockRequirement.files as readonly unknown[];
  const worker = {
    requirementId,
    ...verifiedDeliveryWorker(installed, lockFiles, lockRequirement, sourceLockHash, requirementId),
  };
  const cpu = deliveries.find((item) => item.contentId === 'cpu');
  if (cpu) {
    const label = `${requirementId} cpu`;
    const files = asObject(cpu.modelFiles, `${label} model delivery`).files;
    if (Array.isArray(files) && files.some((item) => {
      const path = asObject(item, `${label} model file`).path;
      return typeof path === 'string' && CPU_SPEECH_FORBIDDEN_ROOTS.some((root) => pathUnder(path, root));
    })) {
      throw new Error(`${label} model files must not include primary paths.`);
    }
    verifiedDeliveryWorker(cpu, cpuSpeechModelFiles(lockFiles), lockRequirement, sourceLockHash, label);
  }
  return worker;
}

export function validateSourceLockAndCatalog(
  sourceLockBytes: Buffer,
  sourceLock: unknown,
  catalogBytes: Buffer,
  catalog: unknown,
): ExpectedProvenance {
  if (!sourceLockBytes.equals(canonicalJson(sourceLock))) {
    throw new Error('Model source lock is not canonical UTF-8 JSON.');
  }
  if (!catalogBytes.equals(canonicalJson(catalog))) {
    throw new Error('Generated model catalog is not canonical UTF-8 JSON.');
  }
  const lock = asObject(sourceLock, 'Model source lock');
  const catalogObject = asObject(catalog, 'Generated model catalog');
  if (lock.lockVersion !== '2') {
    throw new Error(`Model source lock schema must be v2 for the ${RELEASE_VERSION} gate.`);
  }
  if (lock.releaseVersion !== REAL_MODEL_RELEASE_VERSION) {
    throw new Error(`Model source lock release version is not ${RELEASE_VERSION}.`);
  }
  const approval = asObject(lock.approval, 'Model source lock approval');
  if (approval.status !== 'approved' || !Array.isArray(approval.blockers) || approval.blockers.length !== 0) {
    throw new Error('Model source lock must be approved with no blockers.');
  }
  if (catalogObject.catalogVersion !== REAL_MODEL_CATALOG_VERSION) {
    throw new Error('Generated model catalog schema must be v2.');
  }
  if (catalogObject.runtimeVersion !== REAL_MODEL_RELEASE_VERSION) {
    throw new Error(`Generated model catalog runtime version is not ${RELEASE_VERSION}.`);
  }
  const sourceLockHash = sha256(sourceLockBytes);
  // This journey covers OCR and Whisper; an optional unit in the lock or the
  // catalog is not its subject.
  const requiredOnly = (items: unknown): unknown =>
    Array.isArray(items)
      ? items.filter(
          (item) =>
            !['speaker-diarization', 'vertical-japanese-reader'].includes(
              String((item as { requirementId?: unknown } | null)?.requirementId),
            ),
        )
      : items;
  const rawRequirements = requiredOnly(lock.requirements);
  const rawCatalogRequirements = requiredOnly(catalogObject.requirements);
  if (!Array.isArray(rawRequirements) || rawRequirements.length !== 2) {
    throw new Error('Model source lock must contain exactly OCR and Whisper requirements.');
  }
  if (!Array.isArray(rawCatalogRequirements) || rawCatalogRequirements.length !== 2) {
    throw new Error('Generated model catalog must contain exactly OCR and Whisper requirements.');
  }
  const lockIds = rawRequirements.map((item) => requiredString(asObject(item, 'Source requirement').requirementId, 'Source requirement ID'));
  const catalogIds = rawCatalogRequirements.map((item) => requiredString(asObject(item, 'Catalog requirement').requirementId, 'Catalog requirement ID'));
  assert.deepEqual(lockIds, [...REAL_MODEL_REQUIREMENT_ORDER]);
  assert.deepEqual(catalogIds, [...REAL_MODEL_REQUIREMENT_ORDER]);

  const lockById = new Map<string, JsonObject>();
  rawRequirements.forEach((item) => {
    const requirement = asObject(item, 'Source requirement');
    const requirementId = requiredString(requirement.requirementId, 'Source requirement ID');
    if (requirement.artifactVersion !== REAL_MODEL_RELEASE_VERSION || requirement.entryPoint !== 'model') {
      throw new Error(`${requirementId} source-lock delivery version or entry point drifted.`);
    }
    if (!Array.isArray(requirement.files) || requirement.files.length < 1) {
      throw new Error(`${requirementId} source-lock delivery files are missing.`);
    }
    lockById.set(requirementId, requirement);
  });

  const catalogById = new Map<string, JsonObject>();
  rawCatalogRequirements.forEach((item) => {
    const requirement = asObject(item, 'Catalog requirement');
    catalogById.set(requiredString(requirement.requirementId, 'Catalog requirement ID'), requirement);
  });
  const workerArchives: WorkerArchive[] = [];
  for (const requirementId of REAL_MODEL_REQUIREMENT_ORDER) {
    const requirement = catalogById.get(requirementId);
    if (!requirement) throw new Error(`Generated model catalog omitted ${requirementId}.`);
    const lockRequirement = lockById.get(requirementId);
    if (!lockRequirement) throw new Error(`Model source lock omitted ${requirementId}.`);
    workerArchives.push(verifiedRequirementWorker(requirement, lockRequirement, sourceLockHash, requirementId));
  }

  const rawFixtures = lock.fixtures;
  if (!Array.isArray(rawFixtures)) throw new Error('Model source lock fixtures are malformed.');
  const ocrFixture = asObject(rawFixtures.find((item) => asObject(item, 'Fixture').kind === 'ocr'), 'OCR fixture');
  const whisperFixture = asObject(rawFixtures.find((item) => asObject(item, 'Fixture').kind === 'whisper'), 'Whisper fixture');
  if (
    ocrFixture.expectedEngine !== 'windowsml-ocr' ||
    ocrFixture.expectedDevice !== 'windowsml-dml' ||
    ocrFixture.expectedModel !== 'pp-ocrv6-medium-windowsml' ||
    typeof ocrFixture.expectedText !== 'string' ||
    ocrFixture.expectedText.trim() === '' ||
    !Number.isSafeInteger(ocrFixture.bytes) || Number(ocrFixture.bytes) < 1 ||
    !Number.isSafeInteger(ocrFixture.pdfBytes) || Number(ocrFixture.pdfBytes) < 1 ||
    typeof ocrFixture.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ocrFixture.sha256) ||
    typeof ocrFixture.pdfSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(ocrFixture.pdfSha256)
  ) {
    throw new Error('OCR fixture does not pin exact DirectML provenance and text.');
  }
  if (
    whisperFixture.expectedEngine !== 'speech-recognition' ||
    typeof whisperFixture.expectedModel !== 'string' ||
    typeof whisperFixture.expectedDevice !== 'string' ||
    typeof whisperFixture.preferGpu !== 'boolean' ||
    typeof whisperFixture.expectedNormalizedOutputSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(whisperFixture.expectedNormalizedOutputSha256)
    || typeof whisperFixture.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(whisperFixture.sha256)
    || !Number.isSafeInteger(whisperFixture.bytes)
    || Number(whisperFixture.bytes) < 1
  ) {
    throw new Error('Whisper fixture does not pin exact lock-selected provenance.');
  }
  const expectedSegmentCount = asObject(whisperFixture.expectedSegmentCount, 'Whisper fixture segment count');
  if (!Number.isSafeInteger(expectedSegmentCount.minimum)
    || !Number.isSafeInteger(expectedSegmentCount.maximum)
    || Number(expectedSegmentCount.minimum) < 1
    || Number(expectedSegmentCount.maximum) < Number(expectedSegmentCount.minimum)) {
    throw new Error('Whisper fixture segment count bounds are malformed.');
  }
  return {
    sourceLockSha256: sourceLockHash,
    catalogSha256: sha256(catalogBytes),
    selectedModelOptionId: 'qwen3.5-0.8b-v1',
    ocrText: ocrFixture.expectedText,
    ocrImageSha256: requiredString(ocrFixture.sha256, 'OCR image fixture SHA-256'),
    ocrImageBytes: Number(ocrFixture.bytes),
    ocrPdfSha256: requiredString(ocrFixture.pdfSha256, 'OCR PDF fixture SHA-256'),
    ocrPdfBytes: Number(ocrFixture.pdfBytes),
    ocrEngine: 'windowsml-ocr',
    ocrModel: ocrFixture.expectedModel,
    ocrDevice: 'windowsml-dml',
    whisperEngine: 'speech-recognition',
    whisperModel: whisperFixture.expectedModel,
    whisperDevice: whisperFixture.expectedDevice,
    whisperPreferGpu: whisperFixture.preferGpu,
    whisperNormalizedOutputSha256: whisperFixture.expectedNormalizedOutputSha256,
    whisperSegmentMinimum: Number(expectedSegmentCount.minimum),
    whisperSegmentMaximum: Number(expectedSegmentCount.maximum),
    whisperFixtureSha256: whisperFixture.sha256,
    whisperFixtureBytes: Number(whisperFixture.bytes),
    workerArchives,
  };
}

export async function loadReleaseModelContract(): Promise<ExpectedProvenance> {
  const [sourceLockBytes, catalogCandidate] = await Promise.all([
    readFile(sourceLockPath),
    (async () => {
      for (const candidate of generatedCatalogCandidates) {
        try {
          const metadata = await lstat(candidate);
          if (metadata.isFile() && !metadata.isSymbolicLink()) {
            return { path: candidate, bytes: await readFile(candidate) };
          }
        } catch {
          // Try the next generated/staged release catalog candidate.
        }
      }
      throw new Error('Generated release model catalog is missing; refusing stale source catalog fallback.');
    })(),
  ]);
  let sourceLock: unknown;
  let catalog: unknown;
  try {
    sourceLock = JSON.parse(sourceLockBytes.toString('utf8'));
    catalog = JSON.parse(catalogCandidate.bytes.toString('utf8'));
  } catch {
    throw new Error('Generated model source lock/catalog is not valid JSON.');
  }
  return validateSourceLockAndCatalog(
    sourceLockBytes,
    sourceLock,
    catalogCandidate.bytes,
    catalog,
  );
}

export function safeInputName(kind: MediaKind): string {
  return kind === 'pdf' ? 'model-scanned.pdf' : kind === 'image' ? 'model-reference.png' : 'model-private-audio.mp3';
}

export function mediaTypeFor(kind: MediaKind): string {
  return kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/png' : 'audio/mpeg';
}

async function regularInput(
  inputPath: string,
  envName: string,
  kind: MediaKind,
  destination: string,
  expectedSha256?: string,
  expectedBytes?: number,
  expectedOcrText?: string,
  expectedOcrTextSha256?: string,
): Promise<MediaInput> {
  let metadata;
  try {
    metadata = await lstat(inputPath);
  } catch {
    throw new Error(`${envName} must point to a readable regular file.`);
  }
  const maxSourceBytes = kind === 'audio' ? 2 * 1024 * 1024 * 1024 : 50 * 1024 * 1024;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maxSourceBytes) {
    throw new Error(`${envName} must point to a non-empty regular file within the limit (recordings 2 GiB, documents 50 MiB).`);
  }
  try {
    await copyFile(inputPath, destination);
  } catch {
    throw new Error(`${envName} must point to a readable regular file.`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(destination);
  } catch {
    throw new Error(`${envName} could not be staged into the owned smoke run.`);
  }
  if (bytes.length !== metadata.size) throw new Error(`${envName} changed during preparation.`);
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) {
    throw new Error(`${envName} does not match the lock-selected project fixture.`);
  }
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new Error(`${envName} does not match the lock-selected project fixture size.`);
  }
  return {
    kind,
    fileName: safeInputName(kind),
    mediaType: mediaTypeFor(kind),
    path: destination,
    bytes,
    sha256: digest,
    ...(expectedOcrText ? { expectedOcrText } : {}),
    ...(expectedOcrTextSha256 ? { expectedOcrTextSha256 } : {}),
  };
}

async function prepareAudioInput(expected: ExpectedProvenance): Promise<MediaInput> {
  await mkdir(runRoot, { recursive: true });
  const audioInput = process.env.CAPTURE_REAL_MEDIA_MODEL_AUDIO?.trim();
  if (!audioInput) throw new Error('CAPTURE_REAL_MEDIA_MODEL_AUDIO is required for the private runner audio fixture.');
  return regularInput(
    audioInput,
    'CAPTURE_REAL_MEDIA_MODEL_AUDIO',
    'audio',
    join(runRoot, safeInputName('audio')),
    expected.whisperFixtureSha256,
    expected.whisperFixtureBytes,
  );
}

async function prepareAudioSampleInput(): Promise<MediaInput> {
  await mkdir(runRoot, { recursive: true });
  const audioInput = process.env.CAPTURE_REAL_MEDIA_MODEL_AUDIO?.trim();
  const preparedSample = process.env.CAPTURE_REAL_MEDIA_MODEL_AUDIO_SAMPLE?.trim();
  if (!audioInput && !preparedSample) throw new Error('CAPTURE_REAL_MEDIA_MODEL_AUDIO or CAPTURE_REAL_MEDIA_MODEL_AUDIO_SAMPLE is required for the private runner audio fixture.');
  const sampleSource = preparedSample || join(runRoot, 'model-private-audio-sample-source.wav');
  if (!preparedSample && audioInput) await createAudioSample(audioInput, sampleSource);
  const staged = await regularInput(
    sampleSource,
    preparedSample ? 'CAPTURE_REAL_MEDIA_MODEL_AUDIO_SAMPLE' : 'private audio sample',
    'audio',
    join(runRoot, 'model-private-audio.wav'),
  );
  return {
    ...staged,
    fileName: 'model-private-audio.wav',
    mediaType: 'audio/wav',
    exactWhisperOutput: false,
    sampleSeconds: REAL_MODEL_AUDIO_SAMPLE_SECONDS,
  };
}

async function createAudioSample(inputPath: string, outputPath: string): Promise<void> {
  const python = `
import os
from pathlib import Path
import av

source = Path(os.environ["CAPTURE_AUDIO_SAMPLE_INPUT"])
destination = Path(os.environ["CAPTURE_AUDIO_SAMPLE_OUTPUT"])
with av.open(str(source)) as input_container:
    input_stream = next(iter(input_container.streams.audio))
    with av.open(str(destination), "w", format="wav") as output_container:
        output_stream = output_container.add_stream("pcm_s16le", rate=16000)
        output_stream.layout = "mono"
        resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in input_container.decode(input_stream.index):
            if frame.time is not None and frame.time >= ${String(REAL_MODEL_AUDIO_SAMPLE_SECONDS)}:
                break
            decoded = resampler.resample(frame)
            if decoded is None:
                continue
            if not isinstance(decoded, (list, tuple)):
                decoded = [decoded]
            for item in decoded:
                for packet in output_stream.encode(item):
                    output_container.mux(packet)
        for packet in output_stream.encode():
            output_container.mux(packet)
`;
  const result = spawnSync(
    'uv',
    [
      'run',
      '--no-sync',
      '--project',
      join(workspaceRoot, 'packages', 'capture-runtime'),
      'python',
      '-c',
      python,
    ],
    {
      env: {
        ...process.env,
        CAPTURE_AUDIO_SAMPLE_INPUT: inputPath,
        CAPTURE_AUDIO_SAMPLE_OUTPUT: outputPath,
      },
      stdio: 'ignore',
      windowsHide: true,
      timeout: 120_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error('The private audio sample could not be prepared.');
  }
  const metadata = await lstat(outputPath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
    throw new Error('The private audio sample was not created as a regular file.');
  }
}

async function prepareAudioOnlyInputs(): Promise<readonly [MediaInput, MediaInput, MediaInput]> {
  await mkdir(runRoot, { recursive: true });
  return [
    await regularInput(projectPdfPath, 'project OCR PDF fixture', 'pdf', join(runRoot, safeInputName('pdf'))),
    await regularInput(projectImagePath, 'project OCR image fixture', 'image', join(runRoot, safeInputName('image'))),
    await prepareAudioSampleInput(),
  ];
}

async function prepareInputs(expected: ExpectedProvenance): Promise<readonly [MediaInput, MediaInput, MediaInput]> {
  await mkdir(runRoot, { recursive: true });
  const pdfInput = process.env.CAPTURE_REAL_MEDIA_MODEL_PDF?.trim();
  const privatePdfTextSha256 = process.env.CAPTURE_REAL_MEDIA_MODEL_OCR_TEXT_SHA256?.trim().toLowerCase();
  if (!pdfInput) throw new Error('CAPTURE_REAL_MEDIA_MODEL_PDF is required for the private runner OCR fixture.');
  if (!privatePdfTextSha256 || !/^[a-f0-9]{64}$/u.test(privatePdfTextSha256)) {
    throw new Error('CAPTURE_REAL_MEDIA_MODEL_OCR_TEXT_SHA256 must be a 64-character lowercase SHA-256 digest for the private PDF output.');
  }
  return [
    await regularInput(pdfInput, 'CAPTURE_REAL_MEDIA_MODEL_PDF', 'pdf', join(runRoot, safeInputName('pdf')), undefined, undefined, undefined, privatePdfTextSha256),
    await regularInput(projectImagePath, 'project OCR image fixture', 'image', join(runRoot, safeInputName('image')), expected.ocrImageSha256, expected.ocrImageBytes, expected.ocrText),
    await prepareAudioInput(expected),
  ];
}

interface CandidateWorkerMirror {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

/** SHA-256 of the concatenation of `paths`, streamed so parts above 2 GB in total fit. */
async function sha256OfFiles(paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const path of paths) {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function startCandidateWorkerMirror(expected: ExpectedProvenance): Promise<CandidateWorkerMirror> {
  // Served by published file name: the runtime rewrites the archive URL, or
  // each part URL, to `<mirror>/<fileName>`.
  const archives = new Map<string, { path: string; bytes: number; sha256: string }>();
  for (const archive of expected.workerArchives) {
    if (!archive.fileName || /[\\/]/u.test(archive.fileName) || archive.fileName === '.' || archive.fileName === '..') {
      throw new Error('Candidate worker archive file name is unsafe.');
    }
    const paths: string[] = [];
    for (const file of workerPublishedFiles(archive)) {
      if (archives.has(file.fileName)) {
        throw new Error('Candidate worker archive file names are not unique.');
      }
      const filePath = join(workerMirrorRoot, file.fileName);
      let metadata;
      try {
        metadata = await lstat(filePath);
      } catch {
        throw new Error('Candidate worker archive is missing from the release staging directory.');
      }
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.bytes) {
        throw new Error('Candidate worker archive does not match the generated catalog bytes.');
      }
      if ((await sha256OfFiles([filePath])) !== file.sha256) {
        throw new Error('Candidate worker archive does not match the generated catalog digest.');
      }
      archives.set(file.fileName, { path: filePath, bytes: file.bytes, sha256: file.sha256 });
      paths.push(filePath);
    }
    if (archive.parts.length && (await sha256OfFiles(paths)) !== archive.sha256) {
      throw new Error('Candidate worker archive parts do not join into the generated catalog digest.');
    }
  }
  let requestCount = 0;
  const sockets = new Set<net.Socket>();
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url) {
      response.writeHead(405).end();
      return;
    }
    let name: string;
    try {
      const parsed = new URL(request.url, 'http://127.0.0.1');
      if (parsed.search || parsed.hash || parsed.pathname.split('/').filter(Boolean).length !== 1) {
        response.writeHead(404).end();
        return;
      }
      name = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
      response.writeHead(404).end();
      return;
    }
    const archive = archives.get(name);
    if (!archive) {
      response.writeHead(404).end();
      return;
    }
    requestCount += 1;
    response.writeHead(200, {
      'Content-Length': archive.bytes,
      'Content-Type': 'application/zip',
      Connection: 'close',
    });
    const stream = createReadStream(archive.path);
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  if (!port) {
    server.close();
    throw new Error('Candidate worker mirror did not expose a loopback port.');
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests: () => requestCount,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeIdleConnections();
      server.closeAllConnections();
      await Promise.race([
        new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
        wait(3_000),
      ]);
      server.closeIdleConnections();
      server.closeAllConnections();
    },
  };
}

export function assertNoAmbientModelOverrides(environment: Record<string, string>): void {
  const forbidden = Object.keys(environment).filter((name) =>
    /^(?:CAPTURE_(?:USER_MODEL_DIR|EXTRACTION_PROVIDER|STRUCTURING_PROVIDER|OLLAMA_[A-Z0-9_]+|WINDOWSML_[A-Z0-9_]+|WHISPER_[A-Z0-9_]+|SPEECH_RECOGNITION_[A-Z0-9_]+)|OLLAMA_(?:MODELS|HOST))$/u.test(name),
  );
  if (forbidden.length > 0) throw new Error('Real model smoke environment contains ambient model/provider overrides.');
}

/**
 * The desktop app cannot force a speech content, so the runtime's `auto`
 * installs `cuda` only where the NVIDIA driver is: `System32\nvcuda.dll`
 * under SystemRoot, the file engine_content_selection.py checks. This smoke's
 * oracle is the frozen tea-asr-1.1 / cuda fixture and its mirror serves only
 * the cuda archive, so a machine without the driver stops here instead of
 * asking the mirror for the cpu pack.
 */
export function assertNvidiaDriverForCudaSpeechContent(
  systemRoot: string | undefined,
  isFile: (path: string) => boolean = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
): void {
  const root = systemRoot?.trim();
  if (!root || !isFile(join(root, 'System32', 'nvcuda.dll'))) {
    throw new Error('Real model smoke needs the NVIDIA driver, because the desktop installs the cuda speech content only where it is present.');
  }
}

export function assertCudaPathRetainedForAppLaunch(
  source: NodeJS.ProcessEnv,
  appEnvironment: NodeJS.ProcessEnv,
): void {
  const sourceCudaPath = Object.entries(source).find(
    ([name, value]) =>
      name.toUpperCase() === 'CUDA_PATH' &&
      typeof value === 'string' &&
      value.length > 0,
  )?.[1];
  if (
    sourceCudaPath !== undefined &&
    appEnvironment.CUDA_PATH !== sourceCudaPath
  ) {
    throw new Error('Real model smoke did not retain CUDA_PATH for app launch.');
  }
}

function errorWithoutSecrets(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/[A-Za-z]:[\\/][^\s"']+/gu, '[REDACTED_PATH]')
    .replace(/\\\\[^\s"']+/gu, '[REDACTED_PATH]')
    .replace(/(?:bearer|token|secret|authorization|api[_-]?key)\s*[:=]?\s*[^\s,;]+/giu, '[REDACTED_SECRET]');
  return new Error(redacted.slice(0, 500));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitUntil<T>(
  check: () => Promise<T | false>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== false) return value;
    await wait(250);
  }
  throw new Error(message);
}

export function windowsPowerShellExecutable(systemRoot = process.env.SystemRoot || 'C:\\Windows'): string {
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Trigger a visible WebView control with a real OS mouse event.
 *
 * Playwright's CDP click can dispatch DOM events without crossing the native
 * WebView2/Tauri input boundary. The packaged acceptance flow must open the
 * real native picker, so this helper translates the locator's client-space
 * box to screen coordinates and sends a Win32 mouse down/up pair.
 */
export function normalizedNativeClickPoint(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly xRatio: number; readonly yRatio: number } {
  if (
    !Number.isFinite(viewport.width) || viewport.width <= 0 ||
    !Number.isFinite(viewport.height) || viewport.height <= 0
  ) {
    throw new Error('Native visible UI click target reported an invalid WebView viewport.');
  }
  const xRatio = (box.x + box.width / 2) / viewport.width;
  const yRatio = (box.y + box.height / 2) / viewport.height;
  if (
    !Number.isFinite(xRatio) || xRatio < 0 || xRatio > 1 ||
    !Number.isFinite(yRatio) || yRatio < 0 || yRatio > 1
  ) {
    throw new Error('Native visible UI click target has invalid viewport coordinates.');
  }
  return { xRatio, yRatio };
}

export async function nativeClickWebViewElement(
  target: Locator,
  appPid: number,
): Promise<void> {
  if (!Number.isSafeInteger(appPid) || appPid <= 0) {
    throw new Error('Native visible UI click requires the packaged Tauri process PID.');
  }
  const box = await target.boundingBox();
  if (box === null || box.width <= 0 || box.height <= 0) {
    throw new Error('Native visible UI click target is not visible.');
  }
  const viewport = await target.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  // Playwright reports CSS viewport coordinates, while the Win32 helper below
  // receives the packaged window's native client rectangle.  The acceptance
  // lane intentionally emulates a 1440x900 CSS viewport on a 1280px client
  // at 150% Windows scaling, so devicePixelRatio is not the native mapping.
  // Pass normalized coordinates and map them after GetClientRect instead.
  const { xRatio, yRatio } = normalizedNativeClickPoint(box, viewport);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CaptureSmokeNativeMouse {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct Point { public int X; public int Y; }

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetClientRect(IntPtr handle, out Rect rect);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ClientToScreen(IntPtr handle, ref Point point);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetForegroundWindow(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern IntPtr GetAncestor(IntPtr handle, uint flags);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);

  private static bool OwnsForeground(IntPtr handle) {
    IntPtr targetRoot = GetAncestor(handle, 2);
    return targetRoot != IntPtr.Zero && GetAncestor(GetForegroundWindow(), 2) == targetRoot;
  }

  public static void Click(IntPtr handle, double xRatio, double yRatio) {
    Rect rect;
    if (!GetClientRect(handle, out rect)) throw new InvalidOperationException("GetClientRect failed.");
    if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
      throw new InvalidOperationException("Normalized client coordinates are outside the target window.");
    }
    int clientX = (int)Math.Round(rect.Right * xRatio);
    int clientY = (int)Math.Round(rect.Bottom * yRatio);
    if (clientX < rect.Left || clientY < rect.Top || clientX >= rect.Right || clientY >= rect.Bottom) {
      throw new InvalidOperationException("Client coordinates are outside the target window.");
    }
    Point point = new Point { X = clientX, Y = clientY };
    if (!ClientToScreen(handle, ref point)) throw new InvalidOperationException("ClientToScreen failed.");
    SetForegroundWindow(handle);
    System.Threading.Thread.Sleep(100);
    // The click goes to whatever window is under the cursor, so refuse it
    // unless the packaged window really owns the foreground.
    if (!OwnsForeground(handle) || !SetCursorPos(point.X, point.Y) || !OwnsForeground(handle)) {
      throw new InvalidOperationException("Native window activation failed.");
    }
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
$process = Get-Process -Id ${appPid}
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'Packaged Tauri process has no native window.' }
[CaptureSmokeNativeMouse]::Click($handle, ${xRatio}, ${yRatio})
`;
  try {
    execFileSync(
      windowsPowerShellExecutable(systemRoot),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      {
        env: {
          SystemRoot: systemRoot,
          Path: process.env.Path || process.env.PATH || '',
          TEMP: process.env.TEMP || '',
          TMP: process.env.TMP || '',
        },
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
      },
    );
  } catch {
    throw new Error('Native visible UI click failed.');
  }
}

export function modelSmokeFixtureEnvironment(paths: {
  readonly pdf: string;
  readonly image: string;
  readonly audio: string;
}): Record<string, string> {
  return {
    CAPTURE_SMOKE_FIXTURE_PDF: paths.pdf,
    CAPTURE_SMOKE_FIXTURE_IMAGE: paths.image,
    CAPTURE_SMOKE_FIXTURE_AUDIO: paths.audio,
  };
}

export function nativeDialogUiAutomationDefinitions(): string {
  return `
$ErrorActionPreference = 'Stop'
trap {
  $exceptionType = [System.Text.RegularExpressions.Regex]::Replace($_.Exception.GetType().Name, '[^A-Za-z0-9_.#,:=-]', '_')
  $errorId = [System.Text.RegularExpressions.Regex]::Replace([string]$_.FullyQualifiedErrorId, '[^A-Za-z0-9_.#,:=-]', '_')
  Write-Output ('UIA|stage=unhandled|code=exception|type=' + $exceptionType + '|error=' + $errorId + '|line=' + [string]$_.InvocationInfo.ScriptLineNumber)
  exit 9
}
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CaptureClassicDialogOwner {
  private const uint WM_SETTEXT = 0x000C;
  private const uint WM_COMMAND = 0x0111;
  private const uint SMTO_ABORTIFHUNG = 0x0002;
  private const int IDOK = 1;
  private const int FILENAME_CONTROL_ID = 1148;

  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

  [DllImport("user32.dll")]
  private static extern int GetDlgCtrlID(IntPtr handle);

  [DllImport("user32.dll")]
  private static extern IntPtr GetParent(IntPtr handle);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr handle, StringBuilder className, int maximumCount);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindow(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowEnabled(IntPtr handle);

  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, string lParam, uint flags, uint timeoutMs, out IntPtr result);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  private static string ClassName(IntPtr handle) {
    var buffer = new StringBuilder(256);
    int length = GetClassName(handle, buffer, buffer.Capacity);
    return length > 0 ? buffer.ToString() : string.Empty;
  }

  private static string SafeToken(string value) {
    if (string.IsNullOrWhiteSpace(value)) return "-";
    var builder = new StringBuilder(Math.Min(value.Length, 80));
    for (int i = 0; i < value.Length && builder.Length < 80; i++) {
      char ch = value[i];
      bool allowed = (ch >= 'A' && ch <= 'Z')
        || (ch >= 'a' && ch <= 'z')
        || (ch >= '0' && ch <= '9')
        || ch == '_' || ch == '.' || ch == '#' || ch == ',' || ch == ':' || ch == '=' || ch == '-';
      builder.Append(allowed ? ch : '_');
    }
    return builder.Length > 0 ? builder.ToString() : "-";
  }

  public static IntPtr FindDialog(uint processId, string[] allowedClasses) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((handle, _) => {
      if (handle == IntPtr.Zero || !IsWindow(handle) || !IsWindowVisible(handle)) return true;
      uint actualProcessId;
      GetWindowThreadProcessId(handle, out actualProcessId);
      if (actualProcessId != processId) return true;
      string cls = ClassName(handle);
      for (int i = 0; i < allowedClasses.Length; i++) {
        if (string.Equals(cls, allowedClasses[i], StringComparison.Ordinal)) {
          found = handle;
          return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr FindFilenameEdit(IntPtr dialog) {
    if (dialog == IntPtr.Zero || !IsWindow(dialog)) return IntPtr.Zero;
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, _) => {
      if (!string.Equals(ClassName(handle), "Edit", StringComparison.Ordinal)) return true;
      int id = GetDlgCtrlID(handle);
      IntPtr parent = GetParent(handle);
      int parentId = parent != IntPtr.Zero ? GetDlgCtrlID(parent) : 0;
      if (id == FILENAME_CONTROL_ID || parentId == FILENAME_CONTROL_ID) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    if (found != IntPtr.Zero) return found;

    IntPtr comboBoxEx = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, _) => {
      if (string.Equals(ClassName(handle), "ComboBoxEx32", StringComparison.Ordinal)) {
        comboBoxEx = handle;
        if (GetDlgCtrlID(handle) == FILENAME_CONTROL_ID) return false;
      }
      return true;
    }, IntPtr.Zero);
    if (comboBoxEx == IntPtr.Zero) return IntPtr.Zero;

    EnumChildWindows(comboBoxEx, (handle, _) => {
      if (string.Equals(ClassName(handle), "Edit", StringComparison.Ordinal)) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  private static IntPtr FindChildButton(IntPtr dialog, int controlId) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, _) => {
      if (GetDlgCtrlID(handle) == controlId && string.Equals(ClassName(handle), "Button", StringComparison.Ordinal)) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool SetEditText(IntPtr editHandle, string value) {
    if (editHandle == IntPtr.Zero || value == null) return false;
    IntPtr result;
    return SendMessageTimeout(editHandle, WM_SETTEXT, IntPtr.Zero, value, SMTO_ABORTIFHUNG, 5000, out result) != IntPtr.Zero;
  }
  public static bool SubmitDialog(IntPtr dialog) {
    if (dialog == IntPtr.Zero || !IsWindow(dialog)) return false;
    return PostMessage(dialog, WM_COMMAND, (IntPtr)IDOK, FindChildButton(dialog, IDOK));
  }
  public static bool IsDialogOpen(IntPtr dialog) {
    return dialog != IntPtr.Zero && IsWindow(dialog) && IsWindowVisible(dialog);
  }
  public static string[] GetDialogChildDiagnostics(IntPtr dialog) {
    var lines = new List<string>();
    if (dialog == IntPtr.Zero || !IsWindow(dialog)) return lines.ToArray();
    lines.Add("UIA|stage=dialog-info|class=" + SafeToken(ClassName(dialog))
      + "|visible=" + (IsWindowVisible(dialog) ? "true" : "false")
      + "|enabled=" + (IsWindowEnabled(dialog) ? "true" : "false"));
    EnumChildWindows(dialog, (handle, _) => {
      if (lines.Count >= 60) return false;
      lines.Add("UIA|child-id=" + GetDlgCtrlID(handle)
        + "|class=" + SafeToken(ClassName(handle))
        + "|visible=" + (IsWindowVisible(handle) ? "true" : "false")
        + "|enabled=" + (IsWindowEnabled(handle) ? "true" : "false"));
      return true;
    }, IntPtr.Zero);
    return lines.ToArray();
  }
}
'@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CaptureDialogOwner {
  public const uint GW_OWNER = 4;
  private const int SW_RESTORE = 9;
  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
  private delegate bool EnumChildWindowsProc(IntPtr handle, IntPtr parameter);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr parent, EnumChildWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr handle, uint command);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

  [DllImport("user32.dll")]
  private static extern int GetDlgCtrlID(IntPtr handle);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr handle, StringBuilder className, int maximumCount);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindow(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr handle);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr handle, uint flags);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowEnabled(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsIconic(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ShowWindowAsync(IntPtr handle, int command);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool BringWindowToTop(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetForegroundWindow(IntPtr handle);

  [DllImport("user32.dll")]
  private static extern IntPtr SetActiveWindow(IntPtr handle);

  [DllImport("user32.dll")]
  private static extern IntPtr SetFocus(IntPtr handle);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool AttachThreadInput(uint firstThreadId, uint secondThreadId, bool attach);

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);

  public static bool ClickAt(int x, int y) {
    if (!SetCursorPos(x, y)) return false;
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    return true;
  }

  public static long[] SnapshotTopLevelWindowHandles() {
    var handles = new List<long>();
    EnumWindows((handle, _) => {
      if (handle != IntPtr.Zero) handles.Add(handle.ToInt64());
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }

  public static long[] FindExactTopLevelWindows(uint processId, string expectedClass) {
    var handles = new List<long>();
    EnumWindows((handle, _) => {
      if (HasExactIdentity(handle, processId, expectedClass, true)) handles.Add(handle.ToInt64());
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }

  public static IntPtr FindChildControl(IntPtr parent, int controlId) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, (handle, _) => {
      if (GetDlgCtrlID(handle) == controlId) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool ActivateWindow(IntPtr handle) {
    if (handle == IntPtr.Zero || !IsWindow(handle)) return false;
    if (IsIconic(handle)) ShowWindowAsync(handle, SW_RESTORE);
    uint targetProcessId;
    var targetThreadId = GetWindowThreadProcessId(handle, out targetProcessId);
    if (targetThreadId == 0) return false;
    var currentThreadId = GetCurrentThreadId();
    var foregroundHandle = GetForegroundWindow();
    uint foregroundProcessId;
    var foregroundThreadId = foregroundHandle == IntPtr.Zero
      ? 0
      : GetWindowThreadProcessId(foregroundHandle, out foregroundProcessId);
    var attachedTarget = false;
    var attachedForeground = false;
    try {
      if (targetThreadId != currentThreadId) {
        attachedTarget = AttachThreadInput(currentThreadId, targetThreadId, true);
      }
      if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId && foregroundThreadId != targetThreadId) {
        attachedForeground = AttachThreadInput(currentThreadId, foregroundThreadId, true);
      }
      BringWindowToTop(handle);
      SetForegroundWindow(handle);
      SetActiveWindow(handle);
      SetFocus(handle);
    } finally {
      if (attachedForeground) AttachThreadInput(currentThreadId, foregroundThreadId, false);
      if (attachedTarget) AttachThreadInput(currentThreadId, targetThreadId, false);
    }
    return GetForegroundWindow() == handle;
  }

  private static bool HasExactIdentity(IntPtr handle, uint processId, string expectedClass, bool requireUsable) {
    if (handle == IntPtr.Zero || !IsWindow(handle)) return false;
    uint actualProcessId;
    GetWindowThreadProcessId(handle, out actualProcessId);
    if (actualProcessId != processId || GetWindow(handle, GW_OWNER) != IntPtr.Zero) return false;
    if (requireUsable && (!IsWindowVisible(handle) || !IsWindowEnabled(handle))) return false;
    var className = new StringBuilder(256);
    return GetClassName(handle, className, className.Capacity) > 0 &&
      string.Equals(className.ToString(), expectedClass, StringComparison.Ordinal);
  }
}
'@

function Get-TargetMainWindowHandles {
  return [CaptureDialogOwner]::FindExactTopLevelWindows([uint32]$targetProcessId, 'Tauri Window')
}

function Get-SafeMetadata($value) {
  if ($null -eq $value) { return '-' }
  $text = [string]$value
  if ($text -match '[\\/]' -or $text -match '^[A-Za-z]:') { return 'redacted' }
  $text = [System.Text.RegularExpressions.Regex]::Replace($text, '[^A-Za-z0-9_.#,:=-]', '_')
  if ($text.Length -gt 80) { $text = $text.Substring(0, 80) }
  if ([string]::IsNullOrWhiteSpace($text)) { return '-' }
  return $text
}

function Get-PatternNames($element) {
  $patterns = @()
  foreach ($candidate in @(
    @{ Name = 'Value'; Pattern = [System.Windows.Automation.ValuePattern]::Pattern },
    @{ Name = 'Invoke'; Pattern = [System.Windows.Automation.InvokePattern]::Pattern }
  )) {
    try {
      [void]$element.GetCurrentPattern($candidate.Pattern)
      $patterns += $candidate.Name
    } catch { }
  }
  try {
    if ($element.Current.IsKeyboardFocusable) { $patterns += 'Focus' }
  } catch { }
  try {
    if ($element.Current.NativeWindowHandle -ne 0) { $patterns += 'Hwnd' }
  } catch { }
  return ($patterns -join ',')
}

function Get-ElementState($element) {
  try {
    $current = $element.Current
    return 'enabled=' + (Get-BoolMetadata ([bool]$current.IsEnabled)) + '|offscreen=' + (Get-BoolMetadata ([bool]$current.IsOffscreen))
  } catch {
    return 'enabled=-|offscreen=-'
  }
}

function Invoke-NativeElementClick($dialog, $element) {
  if ($null -eq $element) { return $false }
  try {
    $point = New-Object System.Windows.Point
    if ($element.TryGetClickablePoint([ref]$point)) {
      return (Invoke-GuardedClick $dialog ([int]$point.X) ([int]$point.Y))
    }
    # Explorer's brokered picker can expose a visible control without a
    # clickable point from its UIA provider. Its screen-space bounding rectangle
    # is still a process-owned, metadata-only native interaction target.
    $rectangle = $element.Current.BoundingRectangle
    if ($rectangle.Width -le 0 -or $rectangle.Height -le 0) { return $false }
    $x = [int][Math]::Round($rectangle.X + ($rectangle.Width / 2))
    $y = [int][Math]::Round($rectangle.Y + ($rectangle.Height / 2))
    return (Invoke-GuardedClick $dialog $x $y)
  } catch {
    return $false
  }
}

function Get-WindowProcessId([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return 0 }
  [uint32]$processId = 0
  [void][CaptureDialogOwner]::GetWindowThreadProcessId($handle, [ref]$processId)
  return [int]$processId
}

function Get-Win32CommitControl([IntPtr]$dialogHandle) {
  if ($dialogHandle -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  try { return [CaptureDialogOwner]::FindChildControl($dialogHandle, 1) } catch { return [IntPtr]::Zero }
}

function Test-OwnedByTarget([IntPtr]$handle) {
  $current = $handle
  for ($depth = 0; $depth -lt 8 -and $current -ne [IntPtr]::Zero; $depth += 1) {
    $owner = [CaptureDialogOwner]::GetWindow($current, [CaptureDialogOwner]::GW_OWNER)
    if ($owner -eq [IntPtr]::Zero) { return $false }
    if ((Get-WindowProcessId $owner) -eq $targetProcessId) { return $true }
    $current = $owner
  }
  return $false
}

function Get-ElementRelation($element) {
  try {
    $current = $element.Current
    if ([int]$current.ProcessId -eq $targetProcessId) { return 'target' }
    if (Test-OwnedByTarget ([IntPtr]$current.NativeWindowHandle)) { return 'owned' }
  } catch { }
  return 'other'
}

function Get-BrokerCandidateFacts($element) {
  $facts = @{
    ClassAllowed = $false
    DifferentProcess = $false
     BrokerProcess = $false
     PickerControls = $false
     ExplorerProcess = $false
     ForegroundBrokerProcess = $false
    Foreground = $false
    Modal = $false
    NewWindow = $false
    SingleTarget = $false
    TargetStillOwned = $false
    TargetWasEnabled = $false
    TargetDisabled = $false
    Eligible = $false
  }
  try {
    $current = $element.Current
    if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Window) { return $facts }
    $facts.ClassAllowed = $brokerDialogClasses -contains [string]$current.ClassName
    $facts.DifferentProcess = [int]$current.ProcessId -ne $targetProcessId
    $handle = [IntPtr]$current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return $facts }
    $facts.NewWindow = -not $baselineWindowHandles.Contains([long]$handle.ToInt64())
     $facts.Foreground = [CaptureDialogOwner]::GetForegroundWindow() -eq $handle
     $foregroundHandle = [CaptureDialogOwner]::GetForegroundWindow()
     $facts.ForegroundBrokerProcess = (Get-WindowProcessId $foregroundHandle) -eq [int]$current.ProcessId
    $facts.SingleTarget = $targetMainWindowHandles.Count -eq 1
    $facts.TargetWasEnabled = $targetMainWindowWasEnabled
    if ($facts.SingleTarget) {
      $targetHandle = [IntPtr]$targetMainWindowHandles[0]
      $facts.TargetStillOwned = (Get-WindowProcessId $targetHandle) -eq $targetProcessId
      if ($facts.TargetStillOwned) {
        $facts.TargetDisabled = -not [CaptureDialogOwner]::IsWindowEnabled($targetHandle)
      }
    }
    try {
      $processName = [System.Diagnostics.Process]::GetProcessById([int]$current.ProcessId).ProcessName
      $facts.ExplorerProcess = $processName -ceq 'explorer'
      # Windows 11 can host the same IFileOpenDialog surface in Explorer or
      # the system picker broker. Keep the process boundary explicit while
      # allowing only the known native broker executables.
      $facts.BrokerProcess = @('explorer', 'ApplicationFrameHost', 'PickerHost') -contains $processName
    } catch { }
    try {
      $windowPattern = $element.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $facts.Modal = [bool]$windowPattern.Current.IsModal
    } catch { }
    try {
      $textBoxCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        'TextBox'
      )
      $facts.PickerControls = $null -ne $element.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $textBoxCondition
      )
    } catch { }
    $facts.Eligible = $facts.ClassAllowed -and
      $facts.DifferentProcess -and
      $facts.BrokerProcess -and
      $facts.PickerControls -and
      $facts.SingleTarget -and
      $facts.TargetStillOwned -and
       $facts.TargetWasEnabled -and
       (
         $facts.TargetDisabled -or $facts.ForegroundBrokerProcess
       ) -and
       (
         ($facts.ForegroundBrokerProcess -and $facts.PickerControls) -or
         # Windows 11 can reuse the existing Explorer shell window for the
        # brokered picker. The target being disabled is the ownership signal
        # in that form; Find-FilenameTarget/Find-OpenTarget still gate the
        # actual interaction on the picker controls.
         ($facts.NewWindow -and $facts.Foreground -and $facts.Modal)
       )
  } catch { }
  return $facts
}

function Test-BrokeredDialog($element) {
  $facts = Get-BrokerCandidateFacts $element
  return [bool]$facts.Eligible
}

function Find-ByAutomationId($element, [string]$automationId) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $automationId
  )
  return $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-ValueAction($element) {
  if ($null -eq $element) { return $null }
  try {
    return @{ Kind = 'Value'; Pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) }
  } catch { }
  try {
    if ($element.Current.IsKeyboardFocusable) { return @{ Kind = 'Keyboard'; Pattern = $null } }
  } catch { }
  return $null
}

function Get-InvokeAction($element) {
  if ($null -eq $element) { return $null }
  try {
    return @{ Kind = 'Invoke'; Pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) }
  } catch { }
  try {
    if ($element.Current.IsKeyboardFocusable) { return @{ Kind = 'Keyboard'; Pattern = $null } }
  } catch { }
  return $null
}

function ConvertTo-SendKeysLiteral([string]$value) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $value.ToCharArray()) {
    switch ($character) {
      '+' { [void]$builder.Append('{+}') }
      '^' { [void]$builder.Append('{^}') }
      '%' { [void]$builder.Append('{%}') }
      '~' { [void]$builder.Append('{~}') }
      '(' { [void]$builder.Append('{(}') }
      ')' { [void]$builder.Append('{)}') }
      '{' { [void]$builder.Append('{{}') }
      '}' { [void]$builder.Append('{}}') }
      default { [void]$builder.Append($character) }
    }
  }
  return $builder.ToString()
}

function Invoke-RawKeySend([string]$value) {
  [System.Windows.Forms.SendKeys]::SendWait($value)
}

function Invoke-RawClick([int]$x, [int]$y) {
  return [CaptureDialogOwner]::ClickAt($x, $y)
}

function Get-NativeRoot([IntPtr]$handle) {
  return [CaptureDialogOwner]::GetAncestor($handle, 2)
}

function Get-ForegroundRoot {
  return Get-NativeRoot ([CaptureDialogOwner]::GetForegroundWindow())
}

function Invoke-PickerActivation([IntPtr]$handle) {
  return [CaptureDialogOwner]::ActivateWindow($handle)
}

function Test-TargetEnabled {
  return [CaptureDialogOwner]::IsWindowEnabled($targetHandle)
}

function Test-PickerInputOwnership($dialog) {
  try {
    $handle = [IntPtr]$dialog.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
      $pickerRoot = Get-NativeRoot $handle
      if ($pickerRoot -ne [IntPtr]::Zero) {
        if ((Get-ForegroundRoot) -eq $pickerRoot) { return $true }
        try { [void](Invoke-PickerActivation $handle) } catch { }
        if ((Get-ForegroundRoot) -eq $pickerRoot) { return $true }
      }
    }
  } catch { }
  $script:pickerInputRefused = $true
  Write-Host 'UIA|stage=input-guard|code=foreground-not-owned'
  return $false
}

function Invoke-GuardedKeys($dialog, [string]$value) {
  if (-not (Test-PickerInputOwnership $dialog)) { return $false }
  Invoke-RawKeySend $value
  return $true
}

function Invoke-GuardedClick($dialog, [int]$x, [int]$y) {
  if (-not (Test-PickerInputOwnership $dialog)) { return $false }
  return Invoke-RawClick $x $y
}

function Get-LegacyInvokeAction($element) {
  if ($null -eq $element) { return $null }
  try {
    return @{ Kind = 'LegacyInvoke'; Pattern = $element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern) }
  } catch { }
  return $null
}

function Get-ElementRectangle($element) {
  if ($null -eq $element) { return $null }
  try {
    $rectangle = $element.Current.BoundingRectangle
    if ($rectangle.Width -le 0 -or $rectangle.Height -le 0) { return $null }
    return [pscustomobject]@{
      X = [double]$rectangle.X
      Y = [double]$rectangle.Y
      Width = [double]$rectangle.Width
      Height = [double]$rectangle.Height
    }
  } catch {
    return $null
  }
}

function Get-SelectionAction($element) {
  if ($null -eq $element) { return $null }
  try {
    return @{ Kind = 'Select'; Pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern) }
  } catch { }
  return $null
}

function Get-SelectionState($element) {
  if ($null -eq $element) { return 'unknown' }
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    return (Get-BoolMetadata ([bool]$pattern.Current.IsSelected))
  } catch {
    return 'unknown'
  }
}

function Find-OpenTarget($dialog) {
  # Classic common dialogs expose the affirmative action as id=1. The Windows
  # 11 brokered picker also exposes an unrelated toolbar AddButton near the
  # top-right corner; do not mistake that toolbar control for the commit.
  foreach ($automationId in @('1')) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $automationId
    )
    $buttons = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $condition
    )
    foreach ($button in $buttons) {
      try {
        $current = $button.Current
        if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Button -and $current.ClassName -notmatch 'Button') { continue }
        if (-not [bool]$current.IsEnabled) { continue }
      } catch { continue }
      $action = Get-InvokeAction $button
      if ($null -ne $action) {
        $rectangle = Get-ElementRectangle $button
        if ($null -ne $rectangle) { return @{ Element = $button; Action = $action } }
      }
      try {
        if ($button.Current.NativeWindowHandle -ne 0) {
          return @{ Element = $button; Action = @{ Kind = 'Win32Click'; Handle = [IntPtr]$button.Current.NativeWindowHandle } }
        }
      } catch { }
    }
  }

  $dialogRectangle = Get-ElementRectangle $dialog
  if ($null -eq $dialogRectangle) { return $null }
  $candidates = @()
  $buttons = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
  )
  foreach ($button in $buttons) {
    try {
      if (-not [bool]$button.Current.IsEnabled) { continue }
    } catch { continue }
    $rectangle = Get-ElementRectangle $button
    if ($null -eq $rectangle) { continue }
    $action = Get-InvokeAction $button
    if ($null -eq $action) { continue }
    if ($rectangle.Y -lt ($dialogRectangle.Y + ($dialogRectangle.Height * 0.65))) { continue }
    if ($rectangle.X -lt ($dialogRectangle.X + ($dialogRectangle.Width * 0.45))) { continue }
    $candidates += [pscustomobject]@{
      Element = $button
      Action = $action
      X = $rectangle.X
      Y = $rectangle.Y
    }
  }
  if ($candidates.Count -eq 0) { return $null }
  $bottomY = ($candidates | Measure-Object -Property Y -Maximum).Maximum
  $bottomRow = @($candidates | Where-Object { $_.Y -ge ($bottomY - 60) } | Sort-Object X)
  if ($bottomRow.Count -gt 0) { return @{ Element = $bottomRow[0].Element; Action = $bottomRow[0].Action } }
  return $null
}

 $script:BrokeredListProbeWritten = $false

function Find-BrokeredFileTarget($dialog) {
  $targetName = [System.IO.Path]::GetFileName($env:CAPTURE_SMOKE_DIALOG_FILE)
  if ([string]::IsNullOrWhiteSpace($targetName)) { return $null }
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $targetName
  )
  $items = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )
  if (-not $script:BrokeredListProbeWritten) {
    $listCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ListItem
    )
    $listItems = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $listCondition
    )
    # Write-Host: this function's pipeline output is its return value.
    Write-Host ('UIA|stage=brokered-list|code=observed|count=' + [string]$listItems.Count + '|matches=' + [string]$items.Count)
    $script:BrokeredListProbeWritten = $true
  }
  foreach ($item in $items) {
    try {
      if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) { continue }
    } catch { continue }
    $action = Get-SelectionAction $item
    if ($null -ne $action) { return @{ Element = $item; Action = $action } }
    $action = Get-InvokeAction $item
    if ($null -ne $action) { return @{ Element = $item; Action = $action } }
  }
  return $null
}

function Invoke-BrokeredItemClick($dialog, $itemElement) {
  if ($null -eq $itemElement) { return $false }
  if (Invoke-NativeElementClick $dialog $itemElement) { return $true }
  try {
    $nodes = $itemElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($node in $nodes) {
      try {
        if (-not [bool]$node.Current.IsEnabled -or [bool]$node.Current.IsOffscreen) { continue }
        $rectangle = Get-ElementRectangle $node
        if ($null -eq $rectangle) { continue }
        if (Invoke-NativeElementClick $dialog $node) { return $true }
      } catch { }
    }
  } catch { }
  return $false
}

function Invoke-BrokeredPicker($dialog) {
  Write-Output 'UIA|stage=brokered-flow|code=entered'
  $filename = Find-ByAutomationId $dialog 'TextBox'
  if ($null -eq $filename) {
    Write-Output 'UIA|stage=brokered-flow|code=textbox-missing'
    return $false
  }
  $action = Get-ValueAction $filename
  if ($null -eq $action -or $action.Kind -ne 'Value') {
    Write-Output 'UIA|stage=brokered-flow|code=textbox-value-missing'
    return $false
  }
  $directory = [System.IO.Path]::GetDirectoryName($env:CAPTURE_SMOKE_DIALOG_FILE)
  if ([string]::IsNullOrWhiteSpace($directory)) {
    Write-Output 'UIA|stage=brokered-flow|code=directory-missing'
    return $false
  }

  # The brokered Windows 11 picker exposes the current folder breadcrumb as a
  # TextBox. Navigate through the focused picker with SendKeys, then select the
  # exact fixture ListItem and acknowledge the picker commit control. The
  # path/name is used only as an input to UIA and never emitted in diagnostics.
  try { $dialog.SetFocus() } catch { }
  try { $filename.SetFocus() } catch { }
  if (-not (Invoke-GuardedKeys $dialog '^l')) { return $false }
  Start-Sleep -Milliseconds 100
  if (-not (Invoke-GuardedKeys $dialog '^a')) { return $false }
  if (-not (Invoke-GuardedKeys $dialog (ConvertTo-SendKeysLiteral $directory))) { return $false }
  if (-not (Invoke-GuardedKeys $dialog '{ENTER}')) { return $false }
  $itemDeadline = [DateTime]::UtcNow.AddSeconds(10)
  $item = $null
  while ([DateTime]::UtcNow -lt $itemDeadline) {
    $item = Find-BrokeredFileTarget $dialog
    if ($null -ne $item) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($null -eq $item) {
    Write-Output 'UIA|stage=brokered-file|code=missing'
    return $false
  }
  Write-Output 'UIA|stage=brokered-file|code=found'
  # The address TextBox is first used for directory navigation. A full-path
  # commit is attempted only after the exact fixture item is observed; if the
  # provider refreshes, the item is reacquired before any item signal.
  $dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
  try {
    $action.Pattern.SetValue($env:CAPTURE_SMOKE_DIALOG_FILE)
    try { $filename.SetFocus() } catch { }
    [void](Invoke-GuardedKeys $dialog '{ENTER}')
    Write-Output 'UIA|stage=brokered-file|code=full-path-commit'
    $fullPathDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $fullPathDeadline) {
      if (Test-TargetEnabled) { exit 0 }
      if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
        Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-full-path'
        exit 0
      }
      Start-Sleep -Milliseconds 100
    }
    $refreshedItem = Find-BrokeredFileTarget $dialog
    if ($null -ne $refreshedItem) { $item = $refreshedItem }
  } catch {
    Write-Output 'UIA|stage=brokered-file|code=full-path-commit-failed'
  }
  if ($item.Action.Kind -eq 'Select') {
    $item.Action.Pattern.Select()
  } elseif ($item.Action.Kind -eq 'Invoke') {
    $item.Action.Pattern.Invoke()
  }
  Write-Output 'UIA|stage=brokered-file|code=selected'
  Write-Output ('UIA|stage=brokered-file|code=selection-state|selected=' + (Get-SelectionState $item.Element))
  $nativeItemClicked = Invoke-BrokeredItemClick $dialog $item.Element
  Write-Output ('UIA|stage=brokered-file|code=native-click|result=' + (Get-BoolMetadata $nativeItemClicked))
  Start-Sleep -Milliseconds 250
  if (Test-TargetEnabled) { exit 0 }
  if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
    Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-item-click'
    exit 0
  }
  try { $item.Element.SetFocus() } catch { }
  [void](Invoke-GuardedKeys $dialog '{ENTER}')
  Write-Output 'UIA|stage=brokered-file|code=keyboard-commit'
  $keyboardCommitDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $keyboardCommitDeadline) {
    if (Test-TargetEnabled) { exit 0 }
    if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
      Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-keyboard-commit'
      exit 0
    }
    Start-Sleep -Milliseconds 100
  }
  # The multiple-file broker can expose the list item without a
  # SelectionItemPattern. Ctrl+A is the non-localized native selection signal
  # for the current folder; with the isolated fixture directory it selects
  # exactly the verified fixture before Enter commits the picker.
  [void](Invoke-GuardedKeys $dialog '^a')
  Start-Sleep -Milliseconds 150
  [void](Invoke-GuardedKeys $dialog '{ENTER}')
  Write-Output 'UIA|stage=brokered-file|code=select-all-commit'
  $selectAllDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $selectAllDeadline) {
    if (Test-TargetEnabled) { exit 0 }
    if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
      Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-select-all'
      exit 0
    }
    Start-Sleep -Milliseconds 100
  }
  $win32CommitControl = Get-Win32CommitControl $dialogHandle
  if ($win32CommitControl -ne [IntPtr]::Zero) {
    Write-Output 'UIA|stage=brokered-win32|code=commit-control-found'
    $messageResult = [IntPtr]::Zero
    $sent = [CaptureDialogOwner]::SendMessageTimeout(
      $win32CommitControl,
      0x00F5,
      [IntPtr]::Zero,
      [IntPtr]::Zero,
      0x0002,
      2000,
      [ref]$messageResult
    )
    Write-Output ('UIA|stage=brokered-win32|code=commit-control-click|result=' + (Get-BoolMetadata ($sent -ne [IntPtr]::Zero)))
    $win32Deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $win32Deadline) {
      if (Test-TargetEnabled) { exit 0 }
      if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
        Write-Output 'UIA|stage=brokered-win32|code=dialog-closed-after-commit-control'
        exit 0
      }
      Start-Sleep -Milliseconds 100
    }
  }
  $itemInvoke = Get-InvokeAction $item.Element
  if ($null -ne $itemInvoke) {
    $itemInvoke.Pattern.Invoke()
    Start-Sleep -Milliseconds 500
    if (Test-TargetEnabled) { exit 0 }
    if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
      Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-item-invoke'
      exit 0
    }
  }
  $itemLegacyInvoke = Get-LegacyInvokeAction $item.Element
  if ($null -ne $itemLegacyInvoke) {
    try {
      $itemLegacyInvoke.Pattern.DoDefaultAction()
      Write-Output 'UIA|stage=brokered-file|code=legacy-default-action'
      Start-Sleep -Milliseconds 500
      if (Test-TargetEnabled) { exit 0 }
      if (-not (Test-DialogStillOpen $dialog $dialogHandle)) {
        Write-Output 'UIA|stage=brokered-file|code=dialog-closed-after-legacy-action'
        exit 0
      }
    } catch {
      Write-Output 'UIA|stage=brokered-file|code=legacy-default-action-failed'
    }
  }
  Write-Output 'UIA|stage=brokered-controls|code=observed'
  Write-DialogDiagnostics $dialog $relation
  Write-ProcessButtonDiagnostics ([int]$dialog.Current.ProcessId)
  $open = Find-OpenTarget $dialog
  if ($null -eq $open) {
    Write-Output 'UIA|stage=brokered-add|code=missing'
    return $false
  }
  Write-ElementDiagnostics 'UIA' $open.Element 'brokered-add-target'
  $nativeClicked = Invoke-NativeElementClick $dialog $open.Element
  Write-Output ('UIA|stage=brokered-add|code=native-click|result=' + (Get-BoolMetadata $nativeClicked))
  Start-Sleep -Milliseconds 250
  if (Test-TargetEnabled) { exit 0 }
  if ($open.Action.Kind -eq 'Invoke') {
    try { $open.Element.SetFocus() } catch { }
    $open.Action.Pattern.Invoke()
    Start-Sleep -Milliseconds 150
    if (-not (Test-TargetEnabled)) {
      [void](Invoke-GuardedKeys $dialog '{ENTER}')
    }
  } elseif ($open.Action.Kind -eq 'Keyboard') {
    $open.Element.SetFocus()
    [void](Invoke-GuardedKeys $dialog '{ENTER}')
  } else {
    $messageResult = [IntPtr]::Zero
    $sent = [CaptureDialogOwner]::SendMessageTimeout($open.Action.Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 2000, [ref]$messageResult)
    if ($sent -eq [IntPtr]::Zero) { return $false }
  }
  Write-Output 'UIA|stage=brokered-add|code=invoked'
  $retryClick = $false
  Start-Sleep -Milliseconds 250
  if (-not (Test-TargetEnabled)) {
      $retryClick = Invoke-NativeElementClick $dialog $open.Element
    Write-Output ('UIA|stage=brokered-add|code=native-click-retry|result=' + (Get-BoolMetadata $retryClick))
  }
  $dialogDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $dialogDeadline) {
    if (Test-TargetEnabled) { exit 0 }
    Start-Sleep -Milliseconds 100
  }
  Write-Output 'UIA|stage=brokered-add|code=timeout'
  Write-DialogDiagnostics $dialog $relation
  return $false
}

function Invoke-BrokeredPickerKeyboardFallback($dialog) {
  if (Test-TargetEnabled) { return $false }
  # The Windows 11 broker can expose only the existing Explorer shell window
  # through UIA. Alt+N reaches the file-name field in the common dialog, while
  # the second Enter also covers the brokered picker after it resolves the
  # selected path. No text is logged by this fallback.
  if (-not (Invoke-GuardedKeys $dialog '%n')) { return $false }
  Start-Sleep -Milliseconds 100
  if (-not (Invoke-GuardedKeys $dialog (ConvertTo-SendKeysLiteral $env:CAPTURE_SMOKE_DIALOG_FILE))) { return $false }
  if (-not (Invoke-GuardedKeys $dialog '{ENTER}')) { return $false }
  Start-Sleep -Milliseconds 250
  if (-not (Test-TargetEnabled)) {
    if (-not (Invoke-GuardedKeys $dialog '^l')) { return $false }
    Start-Sleep -Milliseconds 100
    if (-not (Invoke-GuardedKeys $dialog (ConvertTo-SendKeysLiteral $env:CAPTURE_SMOKE_DIALOG_FILE))) { return $false }
    if (-not (Invoke-GuardedKeys $dialog '{ENTER}')) { return $false }
    Start-Sleep -Milliseconds 250
    if (-not (Invoke-GuardedKeys $dialog '{ENTER}')) { return $false }
  }
  Write-Host 'UIA|stage=keyboard-fallback|code=sent'
  return $true
}

function Write-ElementDiagnostics($prefix, $element, $relation) {
  try {
    $current = $element.Current
    $controlType = Get-SafeMetadata $current.ControlType.ProgrammaticName
    $automationId = Get-SafeMetadata $current.AutomationId
    $className = Get-SafeMetadata $current.ClassName
    $patterns = Get-SafeMetadata (Get-PatternNames $element)
    $controlName = '-'
    $bounds = '-'
    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
      try {
        $controlName = Get-SafeMetadata $element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
      } catch { }
      try {
        $rectangle = $current.BoundingRectangle
        if ($rectangle.Width -gt 0 -and $rectangle.Height -gt 0) {
          $bounds = ([string]([int][Math]::Round($rectangle.X)) + ',' + [string]([int][Math]::Round($rectangle.Y)) + ',' + [string]([int][Math]::Round($rectangle.Width)) + ',' + [string]([int][Math]::Round($rectangle.Height)))
        }
      } catch { }
    }
    Write-Output ($prefix + '|pid=' + [string]$current.ProcessId + '|relation=' + (Get-SafeMetadata $relation) + '|aid=' + $automationId + '|type=' + $controlType + '|class=' + $className + '|patterns=' + $patterns + '|' + (Get-ElementState $element) + '|name=' + $controlName + '|bounds=' + $bounds)
  } catch { }
}

function Get-BoolMetadata([bool]$value) {
  if ($value) { return 'true' }
  return 'false'
}

function Write-BrokerCandidateDiagnostics($element) {
  $facts = Get-BrokerCandidateFacts $element
  Write-Output ('UIA|stage=broker-candidate|class-allowed=' + (Get-BoolMetadata $facts.ClassAllowed) +
    '|different-process=' + (Get-BoolMetadata $facts.DifferentProcess) +
    '|broker-process=' + (Get-BoolMetadata $facts.BrokerProcess) +
    '|picker-controls=' + (Get-BoolMetadata $facts.PickerControls) +
    '|foreground-broker-process=' + (Get-BoolMetadata $facts.ForegroundBrokerProcess) +
    '|explorer-process=' + (Get-BoolMetadata $facts.ExplorerProcess) +
    '|foreground=' + (Get-BoolMetadata $facts.Foreground) +
    '|modal=' + (Get-BoolMetadata $facts.Modal) +
    '|new-window=' + (Get-BoolMetadata $facts.NewWindow) +
    '|single-target=' + (Get-BoolMetadata $facts.SingleTarget) +
    '|target-still-owned=' + (Get-BoolMetadata $facts.TargetStillOwned) +
    '|target-was-enabled=' + (Get-BoolMetadata $facts.TargetWasEnabled) +
    '|target-disabled=' + (Get-BoolMetadata $facts.TargetDisabled) +
    '|eligible=' + (Get-BoolMetadata $facts.Eligible))
}

function Write-DialogDiagnostics($dialog, $relation) {
  Write-ElementDiagnostics 'UIA' $dialog $relation
  $nodes = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $written = 0
  foreach ($node in $nodes) {
    if ($written -ge 100) { break }
    try {
      $current = $node.Current
      $controlType = $current.ControlType.ProgrammaticName
      if ($current.AutomationId -notmatch '^System\\.' -and ($controlType -match 'Edit|ComboBox|Button|SplitButton' -or $current.ClassName -match 'Edit|ComboBox|Button' -or $current.AutomationId -match '^(?:FileNameControlHost|1148|1001|1)$')) {
        Write-ElementDiagnostics 'UIA' $node $relation
        $written += 1
      }
    } catch { }
  }
}

function Write-ProcessButtonDiagnostics([int]$processId) {
  $buttons = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
  )
  $written = 0
  foreach ($button in $buttons) {
    if ($written -ge 80) { break }
    try {
      if ([int]$button.Current.ProcessId -ne $processId) { continue }
      Write-ElementDiagnostics 'UIA' $button 'brokered-process-button'
      $written += 1
    } catch { }
  }
}

function Write-TopLevelDiagnostics {
  $nodes = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $written = 0
  foreach ($node in $nodes) {
    if ($written -ge 80) { break }
    $relation = Get-ElementRelation $node
    Write-ElementDiagnostics 'TOP' $node $relation
    try {
      if ($relation -ne 'other' -and $commonDialogClasses -contains [string]$node.Current.ClassName) {
        Write-DialogDiagnostics $node $relation
      } elseif ($brokerDialogClasses -contains [string]$node.Current.ClassName) {
        Write-BrokerCandidateDiagnostics $node
        if (Test-BrokeredDialog $node) { Write-DialogDiagnostics $node 'brokered' }
      }
    } catch { }
    $written += 1
  }
}

function Test-DialogStillOpen($dialog, [IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) {
    try {
      [void]$dialog.Current.ProcessId
      return $true
    } catch {
      return $false
    }
  }
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($window in $windows) {
    try {
      if ([IntPtr]$window.Current.NativeWindowHandle -eq $handle) { return $true }
    } catch { }
  }
  return $false
}

`;
}

export function nativeDialogUiAutomationScript(): string {
  const commonDialogClasses = NATIVE_SOURCE_DIALOG_CLASSES.map((value) => `'${value}'`).join(', ');
  const brokerDialogClasses = NATIVE_SOURCE_BROKER_DIALOG_CLASSES.map((value) => `'${value}'`).join(', ');
  return nativeDialogUiAutomationDefinitions() + `
try {
  [void][CaptureClassicDialogOwner]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
} catch { }
$dialogFile = [string]$env:CAPTURE_SMOKE_DIALOG_FILE
if ([string]::IsNullOrWhiteSpace($dialogFile)) {
  Write-Output 'UIA|stage=input|code=missing'
  exit 8
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$targetProcessId = [int]$env:CAPTURE_SMOKE_APP_PID
$commonDialogClasses = @(${commonDialogClasses})
$brokerDialogClasses = @(${brokerDialogClasses})

$targetMainWindowHandles = @(Get-TargetMainWindowHandles)
if ($targetMainWindowHandles.Count -ne 1) {
  Write-Output ('UIA|stage=target-window|code=count-invalid|count=' + [string]$targetMainWindowHandles.Count)
  exit 6
}
$targetHandle = [IntPtr][long]$targetMainWindowHandles[0]
$baselineWindowHandles = New-Object 'System.Collections.Generic.HashSet[long]'
foreach ($handle in [CaptureDialogOwner]::SnapshotTopLevelWindowHandles()) {
  [void]$baselineWindowHandles.Add([long]$handle)
}
$targetMainWindowWasEnabled = [CaptureDialogOwner]::IsWindowEnabled($targetHandle)
Write-Output 'UIA|stage=ready|code=listening'
if ($env:E2E_ACCEPTANCE_DIAGNOSTICS -eq '1') {
  Write-TopLevelDiagnostics
}

$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  # Classic dialog: native window messages only, without foreground changes.
  $dialogHandle = [CaptureClassicDialogOwner]::FindDialog([uint32]$targetProcessId, $commonDialogClasses)
  if ($dialogHandle -ne [IntPtr]::Zero) {
    $editDeadline = [DateTime]::UtcNow.AddSeconds(2)
    $editHandle = [IntPtr]::Zero
    while ([DateTime]::UtcNow -lt $editDeadline) {
      $editHandle = [CaptureClassicDialogOwner]::FindFilenameEdit($dialogHandle)
      if ($editHandle -ne [IntPtr]::Zero) { break }
      Start-Sleep -Milliseconds 50
    }
    if ($editHandle -eq [IntPtr]::Zero) {
      Write-Output 'UIA|stage=find-edit|code=missing'
      [CaptureClassicDialogOwner]::GetDialogChildDiagnostics($dialogHandle) | Write-Output
      exit 2
    }
    if (-not [CaptureClassicDialogOwner]::SetEditText($editHandle, $dialogFile)) {
      Write-Output 'UIA|stage=set-value|code=failed'
      [CaptureClassicDialogOwner]::GetDialogChildDiagnostics($dialogHandle) | Write-Output
      exit 3
    }
    if (-not [CaptureClassicDialogOwner]::SubmitDialog($dialogHandle)) {
      Write-Output 'UIA|stage=invoke-open|code=failed'
      [CaptureClassicDialogOwner]::GetDialogChildDiagnostics($dialogHandle) | Write-Output
      exit 4
    }
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $closeDeadline) {
      if (-not [CaptureClassicDialogOwner]::IsDialogOpen($dialogHandle)) { exit 0 }
      Start-Sleep -Milliseconds 100
    }
    Write-Output 'UIA|stage=close-dialog|code=timeout'
    [CaptureClassicDialogOwner]::GetDialogChildDiagnostics($dialogHandle) | Write-Output
    exit 5
  }
  # Brokered picker: validated UI Automation and keyboard fallback.
  $windows = @($root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  ))
  # Some WebView2/Tauri dialog implementations expose the Win32 dialog as a
  # descendant of the shell broker rather than as a desktop top-level window.
  # Include owned Window descendants so the same control-level validation is
  # applied without relying on localized titles.
  try {
    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Window
    )
    $windows += @($root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $windowCondition
    ))
  } catch { }
  $windows = @($windows | Sort-Object -Property @{
    Expression = {
      try {
        if ([string]$_.Current.ClassName -eq 'ApplicationFrameWindow') { return 0 }
      } catch { }
      return 1
    }
  })
  foreach ($dialog in $windows) {
    $relation = Get-ElementRelation $dialog
    $dialogKind = ''
    try {
      $current = $dialog.Current
      if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Window) { continue }
      if (Test-BrokeredDialog $dialog) {
        $dialogKind = 'brokered'
        $relation = 'brokered'
        Write-Output 'UIA|stage=brokered-flow|code=dialog-found'
      }
    } catch { continue }
    if ([string]::IsNullOrEmpty($dialogKind)) { continue }

    if ($dialogKind -eq 'brokered') {
      $brokeredSucceeded = $false
      Invoke-BrokeredPicker $dialog | ForEach-Object {
        if ($_ -is [bool]) {
          $brokeredSucceeded = $brokeredSucceeded -or $_
        } elseif ($_ -is [string] -and $_.StartsWith('UIA|', [System.StringComparison]::Ordinal)) {
          Write-Output $_
        }
      }
      if ($brokeredSucceeded) { exit 0 }
      $script:pickerInputRefused = $false
      if (Invoke-BrokeredPickerKeyboardFallback $dialog) {
        $fallbackDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $fallbackDeadline) {
          if ([CaptureDialogOwner]::IsWindowEnabled($targetHandle)) { exit 0 }
          Start-Sleep -Milliseconds 100
        }
        Write-Output 'UIA|stage=keyboard-fallback|code=timeout'
        Write-TopLevelDiagnostics
        exit 5
      }
      if ($script:pickerInputRefused) { exit 10 }
      Write-Output 'UIA|stage=brokered-flow|code=commit-unacknowledged'
      Write-DialogDiagnostics $dialog $relation
      exit 5
    }

  }
  Start-Sleep -Milliseconds 100
}
Write-Output 'UIA|stage=find-dialog|code=timeout'
Write-TopLevelDiagnostics
exit 1
`;
}

export function safeUiAutomationDiagnostics(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length <= 500 && /^(?:UIA|TOP)\|[A-Za-z0-9_.#,:;=|-]+$/u.test(line))
    .slice(0, 120);
  const prioritized = lines.filter(
    (line) => line.startsWith('UIA|stage=') || !line.includes('|relation=other|'),
  );
  const diagnostics = [...new Set([...prioritized, ...lines])]
    .slice(0, 120)
    .join(' ');
  return diagnostics || 'none';
}

class NativePickerAutomationError extends Error {
  readonly diagnostics: string;

  constructor(diagnostics: string, inputRefused = false) {
    super(`Native source picker automation failed.${inputRefused ? ' Picker input refused because the foreground is not owned by the picker.' : ''}${diagnostics === 'none' ? '' : ` diagnostics=${diagnostics}`}`);
    this.name = 'NativePickerAutomationError';
    this.diagnostics = diagnostics;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type TauriInvoke = (
  command: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

function progressBandOf(
  progress: unknown,
  middleLabel: 'middle' | 'download' = 'download',
): 'early' | 'middle' | 'download' | 'late' | 'unknown' {
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0) {
    return 'unknown';
  }
  const bounded = Math.min(1, progress);
  if (bounded < 0.35) return 'early';
  if (bounded < 0.85) return middleLabel;
  return 'late';
}

function allowlistedErrorCode(code: unknown, fallback = 'none'): string {
  return typeof code === 'string' && /^[a-z][a-z0-9_-]{1,63}$/u.test(code) ? code : fallback;
}

function safeAllowlistedStatus(value: unknown): string {
  return typeof value === 'string' && SAFE_BACKEND_STATUSES.has(value) ? value : 'unknown';
}

export function safeBackendStateSnapshot(state: unknown): string {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return JSON.stringify({});
  }
  const candidate = state as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  if (typeof candidate.runtimeStatus === 'string') {
    safe.runtimeStatus = safeAllowlistedStatus(candidate.runtimeStatus);
  }
  if (Array.isArray(candidate.requirements)) {
    safe.requirements = candidate.requirements.slice(0, 16).flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (typeof row.requirementId !== 'string' || !SAFE_BACKEND_REQUIREMENTS.has(row.requirementId)) {
        return [];
      }
      return [{ requirementId: row.requirementId, status: safeAllowlistedStatus(row.status) }];
    });
  }
  if (Array.isArray(candidate.modelOptions)) {
    safe.modelOptions = candidate.modelOptions.slice(0, 16).flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
      const option = item as Record<string, unknown>;
      if (typeof option.optionId !== 'string' || !SAFE_MODEL_OPTION_IDS.has(option.optionId)) {
        return [];
      }
      return [{ optionId: option.optionId, status: safeAllowlistedStatus(option.status) }];
    });
  }
  if (
    candidate.modelInstallation !== null
    && typeof candidate.modelInstallation === 'object'
    && !Array.isArray(candidate.modelInstallation)
  ) {
    const install = candidate.modelInstallation as Record<string, unknown>;
    const installError = install.error !== null && typeof install.error === 'object' && !Array.isArray(install.error)
      ? install.error as Record<string, unknown>
      : undefined;
    safe.modelInstallation = {
      optionId: typeof install.optionId === 'string' && SAFE_MODEL_OPTION_IDS.has(install.optionId)
        ? install.optionId
        : 'unknown',
      status: safeAllowlistedStatus(install.status),
      progressBand: progressBandOf(install.progress, 'download'),
      errorCode: allowlistedErrorCode(installError?.code),
    };
  }
  return JSON.stringify(safe);
}

function smokeFailureKind(error: unknown): string {
  if (error instanceof NativePickerAutomationError) return 'native-source-picker';
  if (error instanceof Error && SAFE_TERMINAL_DOCUMENT_FAILURE.test(error.message)) {
    return 'terminal-document';
  }
  if (error instanceof Error && SAFE_TERMINAL_INSTALLATION_FAILURE.test(error.message)) {
    return 'terminal-installation';
  }
  if (error instanceof Error && SAFE_TERMINAL_MODEL_INSTALLATION_FAILURE.test(error.message)) {
    return 'terminal-model-installation';
  }
  if (error instanceof Error && SAFE_MODEL_INSTALLATION_START_FAILURE.test(error.message)) {
    return 'model-installation-start';
  }
  return 'unexpected';
}

export function safeSmokeFailureMessage(
  error: unknown,
  workerMirrorRequests: number,
  backendState: unknown,
  backendCaptureState?: string,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const failureKind = smokeFailureKind(error);
  const errorDigest = sha256(Buffer.from(raw, 'utf8'));
  const requestCount = Number.isSafeInteger(workerMirrorRequests) && workerMirrorRequests >= 0
    ? Math.min(workerMirrorRequests, 1_000_000)
    : 0;
  const diagnostics = error instanceof NativePickerAutomationError
    ? `; diagnostics=${error.diagnostics}`
    : '';
  const terminal = error instanceof Error
    && (SAFE_TERMINAL_DOCUMENT_FAILURE.test(error.message)
      || SAFE_TERMINAL_INSTALLATION_FAILURE.test(error.message)
      || SAFE_TERMINAL_MODEL_INSTALLATION_FAILURE.test(error.message)
      || SAFE_MODEL_INSTALLATION_START_FAILURE.test(error.message))
    ? `; terminal=${error.message}`
    : '';
  const backend = backendCaptureState ? ` Backend capture state: ${backendCaptureState}.` : '';
  return `Real model smoke failed. failure=${failureKind}; error-sha256=${errorDigest}${diagnostics}${terminal}. Candidate worker mirror requests: ${requestCount}. Backend state: ${safeBackendStateSnapshot(backendState)}${backend}`;
}

export async function collectSafeBackendCaptureState(
  invoke: TauriInvoke,
  documentId: string | undefined,
): Promise<string | undefined> {
  if (!documentId) return undefined;
  try {
    const library = await invoke('library_list', {
      request: { query: '', status: '' },
    });
    if (!Array.isArray(library)) return undefined;
    const document = findLibraryDocument(library, documentId);
    if (!document) return undefined;
    const captureId = typeof document.captureId === 'string' ? document.captureId : undefined;
    if (!captureId) {
      const status = safeAllowlistedStatus(document.status);
      const stage = typeof document.stage === 'string' && SAFE_TERMINAL_DOCUMENT_STAGES.has(document.stage)
        ? document.stage
        : 'unknown';
      const errorCode = allowlistedErrorCode(document.errorCode, 'not-started');
      return JSON.stringify({ status, stage, progressBand: 'unknown', errorCode });
    }
    const capture = await invoke('runtime_get_capture', { input: { id: captureId } });
    if (capture === null || typeof capture !== 'object' || Array.isArray(capture)) return undefined;
    const job = capture as Record<string, unknown>;
    const status = safeAllowlistedStatus(job.status);
    const stage = typeof job.stage === 'string' && SAFE_TERMINAL_DOCUMENT_STAGES.has(job.stage)
      ? job.stage
      : 'unknown';
    const progressBand = progressBandOf(job.progress, 'middle');
    const error = job.error;
    const errorCode = error !== null && typeof error === 'object' && !Array.isArray(error)
      ? allowlistedErrorCode((error as Record<string, unknown>).code)
      : 'none';
    return JSON.stringify({ status, stage, progressBand, errorCode });
  } catch {
    return undefined;
  }
}

export async function collectSafeBackendState(
  invoke: TauriInvoke,
  activeModelInstallationId?: string,
): Promise<Record<string, unknown>> {
  const [runtimeStatus, requirements, modelOptions, modelInstallation] = await Promise.all([
    invoke('desktop_runtime_status', {})
      .then((value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).status
        : undefined))
      .catch(() => undefined),
    invoke('runtime_requirements', {})
      .then((value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).items
        : undefined))
      .catch(() => undefined),
    invoke('runtime_model_options', {})
      .then((value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).items
        : undefined))
      .catch(() => undefined),
    activeModelInstallationId
      ? invoke('runtime_get_model_installation', { input: { id: activeModelInstallationId } }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  return {
    ...(runtimeStatus !== undefined ? { runtimeStatus } : {}),
    ...(requirements !== undefined ? { requirements } : {}),
    ...(modelOptions !== undefined ? { modelOptions } : {}),
    ...(modelInstallation !== undefined ? { modelInstallation } : {}),
  };
}

export async function nativeOpenDialogUiAutomation(
  filePath: string,
  appPid: number,
  onReady?: () => void | Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(appPid) || appPid <= 0) {
    throw new Error('Native source picker automation requires the packaged Tauri process PID.');
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const scriptDirectory = process.env.TEMP?.trim() || process.env.TMP?.trim() || workspaceRoot;
  const scriptPath = join(scriptDirectory, `capture-workbench-uia-${randomUUID()}.ps1`);
  await writeFile(scriptPath, nativeDialogUiAutomationScript(), { encoding: 'utf8', flag: 'wx' });
  const removeScript = async (): Promise<void> => {
    await rm(scriptPath, { force: true }).catch(() => undefined);
  };
  const child = spawn(windowsPowerShellExecutable(systemRoot), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', scriptPath], {
    env: {
      SystemRoot: systemRoot,
      Path: process.env.Path || process.env.PATH || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      CAPTURE_SMOKE_APP_PID: String(appPid),
      CAPTURE_SMOKE_DIALOG_FILE: filePath,
      ...(process.env.E2E_ACCEPTANCE_DIAGNOSTICS === '1'
        ? { E2E_ACCEPTANCE_DIAGNOSTICS: '1' }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const readyMarker = 'UIA|stage=ready|code=listening';
  let stdout = '';
  let stderr = '';
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const settleReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };
  const failReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new NativePickerAutomationError(safeUiAutomationDiagnostics(stdout)));
  };
  let resultSettled = false;
  let resolveResult!: (result: { code: number | null; stdout: string; stderr: string }) => void;
  const settleResult = (result: { code: number | null; stdout: string; stderr: string }): void => {
    if (resultSettled) return;
    resultSettled = true;
    resolveResult(result);
  };
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
    resolveResult = resolvePromise;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString().slice(0, 65_536 - stdout.length);
      if (stdout.includes(readyMarker)) settleReady();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString().slice(0, 65_536 - stderr.length);
    });
    child.once('error', () => {
      failReady();
      settleResult({ code: null, stdout, stderr });
    });
    child.once('close', (code) => {
      failReady();
      settleResult({ code, stdout, stderr });
    });
  });
  const childTimeout = setTimeout(() => {
    if (resultSettled) return;
    stdout += '\nUIA|stage=node-timeout|code=timeout';
    child.kill();
    settleResult({ code: null, stdout, stderr });
  }, 60_000);
  if (resultSettled) clearTimeout(childTimeout);
  const readyTimeout = setTimeout(failReady, 15_000);
  try {
    await ready;
  } catch (error) {
    child.kill();
    await result;
    clearTimeout(childTimeout);
    await removeScript();
    throw error;
  } finally {
    clearTimeout(readyTimeout);
  }
  try {
    await withTimeout(
      Promise.resolve(onReady?.()),
      15_000,
      'Native source picker click callback timed out.',
    );
  } catch (error) {
    child.kill();
    await result;
    clearTimeout(childTimeout);
    await removeScript();
    throw error;
  }
  const completed = await result;
  clearTimeout(childTimeout);
  if (completed.code !== 0) {
    const diagnostics = safeUiAutomationDiagnostics(completed.stdout);
    await removeScript();
    throw new NativePickerAutomationError(diagnostics, completed.code === 10);
  }
  if (process.env.E2E_ACCEPTANCE_DIAGNOSTICS === '1') {
    const diagnostics = safeUiAutomationDiagnostics(completed.stdout);
    if (diagnostics !== 'none') process.stderr.write(`Native picker UIA: ${diagnostics}\n`);
  }
  await removeScript();
}

function findLibraryDocument(
  documents: readonly unknown[],
  documentId: string,
): Record<string, unknown> | undefined {
  for (const item of documents) {
    if (
      item !== null
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as Record<string, unknown>).documentId === documentId
    ) {
      return item as Record<string, unknown>;
    }
  }
  return undefined;
}

async function invokeTauriCommand(
  page: Page,
  command: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return page.evaluate(async ({ commandName, commandArgs }) => {
    const internals = (globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke?: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    }).__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== 'function') {
      throw new Error('Packaged Tauri command bridge is unavailable.');
    }
    return internals.invoke(commandName, commandArgs);
  }, { commandName: command, commandArgs: args });
}

export function modelSmokeInjectedDocumentId(value: unknown): string {
  const document = asObject(value, 'Injected fixture document');
  const documentId = requiredString(document.documentId, 'Injected fixture document ID');
  if (!/^[a-f0-9]{32}$/u.test(documentId)) {
    throw new Error('Injected fixture document ID is invalid.');
  }
  return documentId;
}

export async function importModelSmokeFixtureDocument(
  fixtureKey: MediaKind,
  invoke: TauriInvoke,
): Promise<string> {
  const result = await invoke('model_smoke_import_fixture', {
    request: { fixtureKey },
  });
  return modelSmokeInjectedDocumentId(result);
}

async function waitForImportedDocumentInLibrary(
  documentId: string,
  invoke: TauriInvoke,
): Promise<void> {
  await waitUntil(
    async () => {
      const value = await invoke('library_list', {
        request: { query: '', status: '' },
      }).catch(() => undefined);
      if (!Array.isArray(value)) return false;
      return findLibraryDocument(value, documentId) !== undefined;
    },
    30_000,
    'Imported smoke document did not persist in the desktop library.',
  );
}

async function installRequirementThroughTauri(
  requirementId: SetupRequirementId,
  invoke: TauriInvoke,
): Promise<void> {
  const start = asObject(await invoke('runtime_start_installation', {
    input: {
      clientRequestId: randomUUID(),
      requirementId,
    },
  }), 'Runtime installation');
  const installationId = requiredString(start.installationId, 'Runtime installation ID');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(installationId)) {
    throw new Error('Runtime installation ID is invalid.');
  }
  await waitUntil(async () => {
    const installation = asObject(await invoke('runtime_get_installation', {
      input: { id: installationId },
    }), 'Runtime installation');
    const status = requiredString(installation.status, 'Runtime installation status');
    if (status === 'completed') return true;
    if (status !== 'queued' && status !== 'running') {
      const installationError = installation.error !== null
        && typeof installation.error === 'object'
        && !Array.isArray(installation.error)
        ? installation.error as Record<string, unknown>
        : undefined;
      const failure = safeTerminalInstallationFailure(
        requirementId,
        status,
        typeof installation.stage === 'string' ? installation.stage : null,
        typeof installationError?.code === 'string' ? installationError.code : null,
        typeof installation.progress === 'number' ? installation.progress : null,
        typeof installationError?.message === 'string' ? installationError.message : null,
      );
      throw new Error(failure ?? 'Consented runtime installation did not complete.');
    }
    return false;
  }, REAL_MODEL_INSTALL_TIMEOUT_MS, `Consented runtime installation timed out: ${requirementId}.`);
}

export function safeTerminalInstallationFailure(
  requirementId: string,
  status: string | null,
  stage: string | null,
  errorCode: string | null,
  progress: number | null,
  errorMessage: string | null = null,
): string | undefined {
  if (!SAFE_INSTALLABLE_REQUIREMENTS.has(requirementId) || status === null || !SAFE_INSTALLATION_STATUSES.has(status)) {
    return undefined;
  }
  const safeStage = stage !== null && SAFE_INSTALLATION_STAGES.has(stage) ? stage : 'unknown';
  const safeErrorCode = allowlistedErrorCode(errorCode, 'unknown');
  const progressBand = progressBandOf(progress, 'download');
  const workerStage = errorMessage?.match(/\bat (?:stage|stages) (worker-process-[a-z0-9-]+(?:>worker-process-[a-z0-9-]+)*)\b/u)?.[1];
  const failureReason = errorMessage?.includes('direct model download exhausted bounded retries')
    ? 'direct-model-retries-exhausted'
    : errorMessage?.includes('direct model source returned a non-retryable response')
      ? 'direct-model-http-nonretryable'
      : errorMessage?.includes('Content-Length')
        ? 'direct-model-content-length'
        : errorMessage?.includes('byte count') || errorMessage?.includes('exceeded catalog')
          ? 'direct-model-byte-count'
          : errorMessage?.includes('checksum')
            ? 'direct-model-checksum'
            : errorMessage?.includes('redirect')
              ? 'direct-model-redirect'
              : 'runtime-install-unexpected';
  return `Desktop runtime installation terminated. requirement=${requirementId}; status=${status}; stage=${safeStage}; errorCode=${safeErrorCode}; progressBand=${progressBand}${workerStage ? `; workerStage=${workerStage}` : ''}; failureReason=${failureReason}.`;
}

export function runtimeRequirementsReady(value: unknown, requiredIds: readonly SetupRequirementId[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const items = (value as JsonObject).items;
  if (!Array.isArray(items)) return false;
  return requiredIds.every((requiredId) => items.some((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const candidate = item as JsonObject;
    return candidate.requirementId === requiredId && candidate.status === 'ready';
  }));
}

export function desktopRuntimeReady(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as JsonObject).status === 'ready';
}

export function runtimeModelOptionActive(value: unknown, optionId: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const items = (value as JsonObject).items;
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const candidate = item as JsonObject;
    return candidate.optionId === optionId && candidate.status === 'active';
  });
}

export function safeTerminalModelInstallationFailure(
  status: string | null,
  errorCode: string | null,
  progress: number | null,
): string | undefined {
  if (status === null || !SAFE_INSTALLATION_STATUSES.has(status)) return undefined;
  return `Desktop model installation terminated. status=${status}; errorCode=${allowlistedErrorCode(errorCode, 'unknown')}; progressBand=${progressBandOf(progress, 'download')}.`;
}

async function waitForRuntimeRequirementsReady(
  requiredIds: readonly SetupRequirementId[],
  invoke: TauriInvoke,
): Promise<void> {
  await waitUntil(
    async () => runtimeRequirementsReady(
      await invoke('runtime_requirements', {}).catch(() => undefined),
      requiredIds,
    ),
    REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
    `Runtime requirements did not become ready: ${requiredIds.join(', ')}.`,
  );
}

async function waitForRuntimeRequirementsLoaded(invoke: TauriInvoke): Promise<void> {
  await waitUntil(
    async () => {
      const value = await invoke('runtime_requirements', {}).catch(() => undefined);
      return value !== null && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as JsonObject).items);
    },
    REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
    'Runtime requirements bridge did not become ready.',
  );
}

async function waitForDesktopRuntimeReady(invoke: TauriInvoke): Promise<void> {
  await waitUntil(
    async () => desktopRuntimeReady(
      await invoke('desktop_runtime_status', {}).catch(() => undefined),
    ),
    REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
    'Desktop runtime did not become ready.',
  );
}

async function waitForRuntimeModelOptionActive(optionId: string, invoke: TauriInvoke): Promise<void> {
  await waitUntil(
    async () => runtimeModelOptionActive(
      await invoke('runtime_model_options', {}).catch(() => undefined),
      optionId,
    ),
    REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
    `Runtime model option did not become active: ${optionId}.`,
  );
}

export async function installConsentedRequirementsThroughTauri(
  requiredIds: readonly SetupRequirementId[],
  completionOrder: RequirementId[],
  invoke: TauriInvoke,
): Promise<void> {
  if (requiredIds.length === 0) return;
  const listed = asObject(await invoke('runtime_requirements', {}), 'Runtime requirements');
  const items = Array.isArray(listed.items) ? listed.items : [];
  for (const requirementId of requiredIds) {
    const existing = items.find((item) => (
      item !== null
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as Record<string, unknown>).requirementId === requirementId
    )) as Record<string, unknown> | undefined;
    if (existing?.status !== 'ready') {
      await installRequirementThroughTauri(requirementId, invoke);
    }
    if (requirementId !== 'ollama-runtime' && requirementId !== 'capture-ollama-model' && !completionOrder.includes(requirementId)) {
      completionOrder.push(requirementId);
    }
  }
  await waitForRuntimeRequirementsReady(requiredIds, invoke);
}

export async function installModelThroughTauri(
  optionId: 'qwen3.5-0.8b-v1',
  invoke: TauriInvoke,
  onInstallationStarted?: (installationId: string) => void,
): Promise<void> {
  const options = asObject(await invoke('runtime_model_options', {}), 'Runtime model options');
  if (runtimeModelOptionActive(options, optionId)) {
    await waitForRuntimeRequirementsReady(['capture-ollama-model'], invoke);
    return;
  }
  let startValue: unknown;
  try {
    startValue = await invoke('runtime_start_model_installation', {
      input: {
        clientRequestId: randomUUID(),
        optionId,
      },
    });
  } catch {
    throw new Error('Desktop model installation did not start.');
  }
  const start = asObject(startValue, 'Runtime model installation');
  const installationId = requiredString(start.installationId, 'Runtime model installation ID');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(installationId)) {
    throw new Error('The model install action did not expose a valid installation identity.');
  }
  if (requiredString(start.optionId, 'Runtime model installation option ID') !== optionId) {
    throw new Error('The model install action started a different allowlisted option.');
  }
  onInstallationStarted?.(installationId);

  await waitUntil(
    async () => {
      const installation = asObject(await invoke('runtime_get_model_installation', {
        input: { id: installationId },
      }), 'Runtime model installation');
      if (requiredString(installation.installationId, 'Runtime model installation ID') !== installationId
        || requiredString(installation.optionId, 'Runtime model installation option ID') !== optionId) {
        throw new Error('Runtime model installation identity changed while polling.');
      }
      const status = requiredString(installation.status, 'Runtime model installation status');
      if (status === 'completed') return true;
      if (status === 'queued' || status === 'running') return false;
      const installationError = installation.error !== null
        && typeof installation.error === 'object'
        && !Array.isArray(installation.error)
        ? installation.error as JsonObject
        : undefined;
      const failure = safeTerminalModelInstallationFailure(
        status,
        typeof installationError?.code === 'string' ? installationError.code : null,
        typeof installation.progress === 'number' ? installation.progress : null,
      );
      throw new Error(failure ?? 'Runtime model installation did not complete.');
    },
    REAL_MODEL_INSTALL_TIMEOUT_MS,
    'The selected qwen3.5 0.8B model installation timed out.',
  );
  await waitForRuntimeModelOptionActive(optionId, invoke);
  await waitForRuntimeRequirementsReady(['capture-ollama-model'], invoke);
}

function validCaptureId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value) ? value : undefined;
}

export async function waitForCaptureAccepted(
  documentId: string,
  invoke: TauriInvoke,
  timeoutMs = REAL_MODEL_CAPTURE_START_TIMEOUT_MS,
): Promise<string | undefined> {
  let observedCaptureId: string | undefined;
  await waitUntil(
    async () => {
      const documents = await invoke('library_list', {
        request: { query: '', status: '' },
      }).catch(() => undefined);
      if (!Array.isArray(documents)) return false;
      const record = findLibraryDocument(documents, documentId);
      if (!record) return false;
      observedCaptureId ??= validCaptureId(record.captureId);
      const status = typeof record.status === 'string' ? record.status : '';
      return observedCaptureId !== undefined
        || status === 'processing'
        || status === 'persisting'
        || status === 'awaiting_confirmation'
        || status === 'completed'
        || status === 'recovery_required'
        || SAFE_TERMINAL_DOCUMENT_STATUSES.has(status);
    },
    timeoutMs,
    'Desktop capture start was not accepted.',
  );
  return observedCaptureId;
}

export function safeTerminalDocumentFailure(
  status: string | null,
  stage: string | null,
  errorCode: string | null,
  errorMessage: string | null = null,
  mediaKind: MediaKind | null = null,
): string | undefined {
  if (status === null || !SAFE_TERMINAL_DOCUMENT_STATUSES.has(status)) return undefined;
  const safeStage = stage !== null && SAFE_TERMINAL_DOCUMENT_STAGES.has(stage) ? stage : 'unknown';
  const safeErrorCode = errorCode !== null && SAFE_TERMINAL_DOCUMENT_ERROR_CODES.has(errorCode)
    ? errorCode
    : 'unknown';
  const workerStage = errorMessage?.match(SAFE_WORKER_FAILURE_MESSAGE)?.[1];
  const failureReason = errorMessage === null
    ? null
    : SAFE_EXTRACTION_FAILURE_REASONS.get(errorMessage) ?? null;
  const detail = workerStage
    ? `; workerStage=${workerStage}`
    : failureReason
      ? `; failureReason=${failureReason}`
      : '';
  const safeMediaKind = mediaKind !== null && ['pdf', 'image', 'audio'].includes(mediaKind)
    ? `; mediaKind=${mediaKind}`
    : '';
  return `Desktop capture terminated. status=${status}; stage=${safeStage}; errorCode=${safeErrorCode}${safeMediaKind}${detail}.`;
}

function throwIfTerminalRecordFailure(
  record: JsonObject,
  mediaKind: MediaKind | null = null,
): void {
  const status = typeof record.status === 'string' ? record.status : null;
  if (status === 'recovery_required') {
    throw new Error(`Desktop capture requires recovery. mediaKind=${mediaKind ?? 'unknown'}.`);
  }
  const failure = safeTerminalDocumentFailure(
    status,
    typeof record.stage === 'string' ? record.stage : null,
    typeof record.errorCode === 'string' ? record.errorCode : null,
    typeof record.errorMessage === 'string' ? record.errorMessage : null,
    mediaKind,
  );
  if (failure !== undefined) throw new Error(failure);
}

function partialSegmentText(partial: JsonObject): string {
  if (typeof partial.sourceText === 'string' && partial.sourceText.trim().length > 0) {
    return partial.sourceText.trim();
  }
  if (!Array.isArray(partial.segments)) return '';
  return partial.segments
    .map((segment) => (segment !== null && typeof segment === 'object' && !Array.isArray(segment)
      && typeof (segment as JsonObject).text === 'string'
      ? ((segment as JsonObject).text as string).trim()
      : ''))
    .filter(Boolean)
    .join('\n');
}

function assertExtractionProvenance(
  raw: JsonObject,
  result: JsonObject,
  input: MediaInput,
  expected: ExpectedProvenance,
): { readonly engine: string; readonly model: string; readonly device: string; readonly digest: string } {
  const extraction = asObject(
    result.extractionEngine ?? raw.extractionEngine,
    `${input.kind} extraction provenance`,
  );
  const expectedEngine = input.kind === 'audio' ? expected.whisperEngine : expected.ocrEngine;
  const expectedModel = input.kind === 'audio' ? expected.whisperModel : expected.ocrModel;
  const expectedDevice = input.kind === 'audio' ? expected.whisperDevice : expected.ocrDevice;
  const actualDevice = typeof extraction.device === 'string' ? extraction.device : null;
  assert.equal(extraction.engine, expectedEngine);
  assert.equal(extraction.model, expectedModel);
  if (input.kind === 'audio' && expected.whisperPreferGpu && input.exactWhisperOutput !== false) {
    assertAudioDeviceMatchesSourceLock(actualDevice, expectedDevice);
  } else if (input.kind === 'audio' && expected.whisperPreferGpu) {
    assert.ok(actualDevice === 'cuda' || actualDevice === 'cpu');
  } else {
    assert.equal(actualDevice, expectedDevice);
  }
  const extractionDigest = requiredString(extraction.digest, `${input.kind} extraction digest`);
  assert.match(extractionDigest, /^sha256:[a-f0-9]{64}$/u);
  return {
    engine: expectedEngine,
    model: expectedModel,
    device: actualDevice || expectedDevice,
    digest: extractionDigest,
  };
}

function assertStructuringResult(
  rawSegments: readonly unknown[],
  result: JsonObject,
  input: MediaInput,
): {
  readonly structuringEngine: string;
  readonly structuringModel: string;
  readonly structuringDigest: string;
  readonly structuredBlockCount: number;
} {
  const structuring = asObject(result.structuringEngine, `${input.kind} structuring provenance`);
  assert.equal(structuring.engine, expectedStructuringEngine);
  assert.equal(structuring.model, expectedStructuringModel);
  const structuringDigest = requiredString(structuring.digest, `${input.kind} structuring digest`);
  assert.match(structuringDigest, /^sha256:[a-f0-9]{64}$/u);
  if (!Array.isArray(result.blocks) || result.blocks.length < 1) {
    throw new Error(`${input.kind} structured result did not contain any blocks.`);
  }
  const rawSegmentIds = new Set<string>();
  for (const segment of rawSegments) {
    const segmentObject = asObject(segment, `${input.kind} raw segment`);
    rawSegmentIds.add(requiredString(segmentObject.segmentId, `${input.kind} raw segmentId`));
  }
  for (const block of result.blocks) {
    const blockObject = asObject(block, `${input.kind} structured block`);
    const sourceSegmentId = requiredString(blockObject.sourceSegmentId, `${input.kind} block sourceSegmentId`);
    if (!rawSegmentIds.has(sourceSegmentId)) {
      throw new Error(`${input.kind} structured block referenced unknown raw segment.`);
    }
  }
  return {
    structuringEngine: expectedStructuringEngine,
    structuringModel: expectedStructuringModel,
    structuringDigest,
    structuredBlockCount: result.blocks.length,
  };
}

function assertAudioRawSegments(
  segments: readonly unknown[],
  expected: ExpectedProvenance,
  exactOutput: boolean,
): number {
  let previousOrder = -1;
  let previousStart = -1;
  const transcript: string[] = [];
  for (const segment of segments) {
    const object = asObject(segment, 'Audio segment');
    const locator = asObject(object.locator, 'Audio segment locator');
    const order = typeof object.order === 'number' ? object.order : Number.NaN;
    const startMs = typeof locator.startMs === 'number' ? locator.startMs : Number.NaN;
    const endMs = typeof locator.endMs === 'number' ? locator.endMs : Number.NaN;
    if (typeof object.text !== 'string' || object.text.trim() === ''
      || !Number.isSafeInteger(order) || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
      || order !== previousOrder + 1 || startMs < previousStart || endMs <= startMs) {
      throw new Error('Audio raw segments were not contiguous and monotonic.');
    }
    transcript.push(object.text);
    previousOrder = order;
    previousStart = startMs;
  }
  if (exactOutput && (segments.length < expected.whisperSegmentMinimum || segments.length > expected.whisperSegmentMaximum)) {
    throw new Error('Audio raw segment count drifted from the lock-selected fixture bounds.');
  }
  if (exactOutput && normalizedTranscriptDigest(transcript) !== expected.whisperNormalizedOutputSha256) {
    throw new Error('Audio raw normalized result did not match the lock-selected Whisper digest.');
  }
  return segments.length;
}

export async function assertCaptureRecord(
  input: MediaInput,
  expected: ExpectedProvenance,
  documentId: string,
  invoke: TauriInvoke,
  options: {
    readonly importedAt?: number;
    readonly initialCaptureId?: string;
    readonly oracle?: ProgressiveAudioOracleEvidence;
  } = {},
): Promise<MediaSummary> {
  const importedAt = options.importedAt ?? Date.now();
  const rawTimeout = input.kind === 'audio' ? REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS : REAL_MODEL_CAPTURE_TIMEOUT_MS;
  let lastCaptureId = options.initialCaptureId;

  if (input.kind === 'audio') {
    const oracle = options.oracle;
    if (!oracle) throw new Error('The progressive audio oracle is required for the production Tauri audio gate.');
    let observed: ProgressiveAudioObservedOutput | undefined;
    await waitUntil(
      async () => {
        const detail = asObject(await invoke('library_get', {
          request: { documentId },
        }), 'Library document detail');
        throwIfTerminalRecordFailure(detail, input.kind);
        lastCaptureId = validCaptureId(detail.captureId) ?? lastCaptureId;
        if (lastCaptureId) {
          const partialValue = await invoke('runtime_get_streaming_partial', {
            input: { id: lastCaptureId },
          }).catch(() => undefined);
          if (partialValue !== null && typeof partialValue === 'object' && !Array.isArray(partialValue)) {
            const partialRecord = partialValue as JsonObject;
            const coveredUntilMs = Number(partialRecord.coveredUntilMs);
            const revision = Number(partialRecord.revision);
            const partialText = partialSegmentText(partialRecord);
            if (audioCheckpointSatisfied(input.sampleSeconds, coveredUntilMs, revision, partialText)) {
              const candidate = parseProgressiveAudioObservedOutput(partialValue);
              if (candidate) {
                observed = candidate;
                return true;
              }
            }
          }
        }
        if (!detail.captureId && (detail.status === 'completed' || detail.status === 'awaiting_confirmation')) {
          throw new Error('The progressive audio oracle could not observe the Tauri partial.');
        }
        return false;
      },
      REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS,
      'Desktop v2 audio partial did not expose non-empty text by its progressive checkpoint.',
    );
    if (!observed) throw new Error('The progressive audio oracle could not observe the Tauri partial.');
    assertProgressiveAudioSampleMatchesOracle(oracle, observed);
  }

  await waitUntil(
    async () => {
      const detail = asObject(await invoke('library_get', {
        request: { documentId },
      }), 'Library document detail');
      throwIfTerminalRecordFailure(detail, input.kind);
      lastCaptureId = validCaptureId(detail.captureId) ?? lastCaptureId;
      if (detail.raw !== null && typeof detail.raw === 'object' && !Array.isArray(detail.raw)) {
        return true;
      }
      if (!detail.captureId && (detail.status === 'completed' || detail.status === 'awaiting_confirmation')) {
        throw new Error(`${input.kind} reached terminal status ${String(detail.status)} without persisting raw extraction.`);
      }
      return false;
    },
    rawTimeout,
    `${input.kind} raw extraction was not persisted within its bounded timeout.`,
  );
  const extractionDurationMs = Date.now() - importedAt;

  const terminalDetail = await waitUntil(
    async () => {
      const detail = asObject(await invoke('library_get', {
        request: { documentId },
      }), 'Library document detail');
      throwIfTerminalRecordFailure(detail, input.kind);
      lastCaptureId = validCaptureId(detail.captureId) ?? lastCaptureId;
      const terminal = !detail.captureId && (detail.status === 'completed' || detail.status === 'awaiting_confirmation');
      if (!terminal) return false;
      if (detail.result === null || typeof detail.result !== 'object' || Array.isArray(detail.result)) {
        throw new Error(`${input.kind} reached terminal status ${String(detail.status)} without a structured result.`);
      }
      return detail;
    },
    REAL_MODEL_RESULT_TIMEOUT_MS,
    `${input.kind} structured result did not persist within its bounded timeout.`,
  );

  const raw = asObject(terminalDetail.raw, `${input.kind} raw capture`);
  const result = asObject(terminalDetail.result, `${input.kind} structured capture`);
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw new Error(`${input.kind} raw segments were empty.`);
  }
  const provenance = assertExtractionProvenance(raw, result, input, expected);
  const structuring = assertStructuringResult(raw.segments, result, input);

  if (input.kind === 'pdf' || input.kind === 'image') {
    const sourceText = (typeof raw.sourceText === 'string' ? raw.sourceText : '').trim();
    if (!sourceText) throw new Error(`${input.kind} raw source text was empty.`);
    if (input.expectedOcrText && !sourceText.includes(input.expectedOcrText)) {
      throw new Error(`${input.kind} raw text did not contain the lock-selected OCR fixture text.`);
    }
    if (input.expectedOcrTextSha256 && normalizedOcrTextDigest(sourceText) !== input.expectedOcrTextSha256) {
      throw new Error(`${input.kind} raw source text did not match the private OCR output oracle.`);
    }
    const pageLocators = raw.segments.filter((segment) => {
      const seg = asObject(segment, `${input.kind} raw segment`);
      const locator = asObject(seg.locator, `${input.kind} segment locator`);
      return locator.kind === 'page';
    }).length;
    if (pageLocators < 1) throw new Error(`${input.kind} raw data did not expose page locators.`);
    await deleteLibraryDocument(documentId, invoke, { captureId: lastCaptureId, streaming: false });
    return {
      sourceKind: input.kind,
      sourceSha256: input.sha256,
      extractionEngine: provenance.engine,
      model: provenance.model,
      device: provenance.device,
      engineDigest: provenance.digest,
      structuringEngine: structuring.structuringEngine,
      structuringModel: structuring.structuringModel,
      structuringDigest: structuring.structuringDigest,
      structuredBlockCount: structuring.structuredBlockCount,
      segmentCount: pageLocators,
      pageLocators,
      durationMs: extractionDurationMs,
    };
  }

  const segmentCount = assertAudioRawSegments(
    raw.segments,
    expected,
    input.exactWhisperOutput !== false,
  );
  await deleteLibraryDocument(documentId, invoke, { captureId: lastCaptureId, streaming: true });
  return {
    sourceKind: input.kind,
    sourceSha256: input.sha256,
    extractionEngine: provenance.engine,
    model: provenance.model,
    device: provenance.device,
    engineDigest: provenance.digest,
    structuringEngine: structuring.structuringEngine,
    structuringModel: structuring.structuringModel,
    structuringDigest: structuring.structuringDigest,
    structuredBlockCount: structuring.structuredBlockCount,
    segmentCount,
    timeLocators: segmentCount,
    durationMs: extractionDurationMs,
  };
}

export function normalizedTranscriptDigest(transcript: readonly string[]): string {
  const normalized = transcript
    .map((value) => value.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join(' ');
  if (!normalized) throw new Error('Audio raw transcript was empty.');
  return sha256(Buffer.from(normalized, 'utf8'));
}

async function loadProgressiveAudioOracle(): Promise<ProgressiveAudioOracleEvidence | undefined> {
  const path = process.env.CAPTURE_REAL_MEDIA_MODEL_AUDIO_ORACLE?.trim();
  if (!path) return undefined;
  let value: unknown;
  try {
    value = JSON.parse((await readFile(path)).toString('utf8'));
  } catch {
    throw new Error('The progressive audio oracle is unavailable or malformed.');
  }
  assertProgressiveAudioOracleEvidence(value);
  return value;
}

function parseProgressiveAudioObservedOutput(value: unknown): ProgressiveAudioObservedOutput | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const source = candidate.source;
  const extraction = candidate.extractionEngine;
  const segments = candidate.segments;
  if (source === null || typeof source !== 'object' || Array.isArray(source)
    || extraction === null || typeof extraction !== 'object' || Array.isArray(extraction)
    || !Array.isArray(segments)) return undefined;
  const sourceRecord = source as Record<string, unknown>;
  const extractionRecord = extraction as Record<string, unknown>;
  if (typeof sourceRecord.sha256 !== 'string' || !Number.isSafeInteger(sourceRecord.bytes)
    || typeof extractionRecord.engine !== 'string' || typeof extractionRecord.model !== 'string'
    || typeof extractionRecord.digest !== 'string'
    || !/^(?:cuda|cpu)$/u.test(String(extractionRecord.device))) return undefined;
  const parsedSegments = segments.map((segment, index) => {
    if (segment === null || typeof segment !== 'object' || Array.isArray(segment)) return undefined;
    const item = segment as Record<string, unknown>;
    const locator = item.locator;
    if (locator === null || typeof locator !== 'object' || Array.isArray(locator)) return undefined;
    const location = locator as Record<string, unknown>;
    return {
      order: item.order,
      startMs: location.startMs,
      endMs: location.endMs,
      text: item.text,
      index,
    };
  });
  const completeSegments = parsedSegments.filter(
    (segment): segment is NonNullable<typeof segment> => segment !== undefined,
  );
  if (completeSegments.length !== parsedSegments.length) return undefined;
  return {
    sourceSha256: sourceRecord.sha256 as string,
    sourceBytes: sourceRecord.bytes as number,
    coveredUntilMs: Number(candidate.coveredUntilMs),
    partialRevision: Number(candidate.revision),
    segments: completeSegments.map((segment) => ({
      order: Number(segment.order),
      startMs: Number(segment.startMs),
      endMs: Number(segment.endMs),
      text: String(segment.text),
    })),
    extraction: {
      engine: extractionRecord.engine as string,
      model: extractionRecord.model as string,
      device: extractionRecord.device as 'cuda' | 'cpu',
      digest: extractionRecord.digest as string,
    },
  };
}

export function normalizedOcrTextDigest(sourceText: string): string {
  const normalized = sourceText.replace(/\s+/gu, ' ').trim();
  if (!normalized) throw new Error('OCR source text was empty.');
  return sha256(Buffer.from(normalized, 'utf8'));
}

export async function deleteLibraryDocument(
  documentId: string,
  invoke: TauriInvoke,
  options: { readonly captureId?: string; readonly streaming?: boolean } = {},
): Promise<void> {
  await invoke('library_delete', { request: { documentId } });
  const documents = await invoke('library_list', { request: { query: '', status: '' } });
  if (!Array.isArray(documents) || findLibraryDocument(documents, documentId) !== undefined) {
    throw new Error('Desktop library still listed the deleted smoke document.');
  }
  let getSucceeded = false;
  try {
    await invoke('library_get', { request: { documentId } });
    getSucceeded = true;
  } catch {
    getSucceeded = false;
  }
  if (getSucceeded) {
    throw new Error('Desktop library still returned the deleted smoke document.');
  }
  if (options.captureId) {
    const command = options.streaming ? 'runtime_get_streaming_capture' : 'runtime_get_capture';
    let captureStillPresent = false;
    try {
      const value = await invoke(command, { input: { id: options.captureId } });
      captureStillPresent = value !== null && value !== undefined;
    } catch {
      captureStillPresent = false;
    }
    if (captureStillPresent) {
      throw new Error('Capture Runtime retained the smoke capture after library deletion.');
    }
  }
}

export function assertRealMediaModelEvidence(value: unknown): asserts value is RealMediaModelEvidence {
  const report = asObject(value, 'Real model smoke report');
  assert.equal(report.evidenceKind, 'real-model-enabled-tauri-host-smoke');
  assert.equal(report.sourceImportMode, REAL_MODEL_SOURCE_IMPORT_MODE);
  assert.equal(report.nativePickerExercised, false);
  assert.equal(report.releaseGateSatisfied, false);
  assert.equal(report.localProductionPreflight, true);
  assert.equal(report.consumerE2e, false);
  assert.equal(report.runtimeVersion, REAL_MODEL_RELEASE_VERSION);
  assert.equal(report.catalogVersion, REAL_MODEL_CATALOG_VERSION);
  assert.equal(report.selectedModelOptionId, 'qwen3.5-0.8b-v1');
  assert.deepEqual(report.modelDependencyOrder, [...REAL_MODEL_REQUIREMENT_ORDER]);
  assert.equal(report.modelDependencyOrderScope, REAL_MODEL_DEPENDENCY_ORDER_SCOPE);
  assert.equal(report.rawPersisted, true);
  assert.equal(report.resultPersisted, true);
  assert.equal(report.consentedInstallation, true);
  assert.equal(report.capturesDeletedAfterVerification, true);
  assert.equal(report.ownedProcessCleanupVerified, true);
  assert.equal(report.cdpPortReleased, true);
  assert.equal(report.candidateMirrorUsed, true);
  assert.equal(report.candidateMirrorReleased, true);
  assert.equal(report.isolatedAppDataUsed, true);
  assert.match(String(report.sourceLockSha256), /^[a-f0-9]{64}$/u);
  assert.match(String(report.catalogSha256), /^[a-f0-9]{64}$/u);
  if (!Array.isArray(report.media) || report.media.length !== 3) throw new Error('Real model smoke report must summarize exactly three media inputs.');
  const mediaKinds = report.media.map((item) => asObject(item, 'Media summary').sourceKind);
  assert.deepEqual(mediaKinds, ['pdf', 'image', 'audio']);
  for (const item of report.media) {
    const media = asObject(item, 'Media summary');
    assert.match(String(media.sourceSha256), /^[a-f0-9]{64}$/u);
    assert.match(String(media.engineDigest), /^sha256:[a-f0-9]{64}$/u);
    assert.equal(media.structuringEngine, expectedStructuringEngine);
    assert.equal(media.structuringModel, expectedStructuringModel);
    assert.match(String(media.structuringDigest), /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(media.structuredBlockCount) && Number(media.structuredBlockCount) >= 1);
    assert.ok(Number.isSafeInteger(media.segmentCount) && Number(media.segmentCount) > 0);
    const durationLimit = media.sourceKind === 'audio'
      ? REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS
      : REAL_MODEL_CAPTURE_TIMEOUT_MS;
    assert.ok(Number.isSafeInteger(media.durationMs) && Number(media.durationMs) <= durationLimit);
    assert.ok(typeof media.extractionEngine === 'string' && media.extractionEngine.length > 0);
    assert.ok(typeof media.model === 'string' && media.model.length > 0);
    assert.ok(typeof media.device === 'string' && media.device.length > 0);
    if (media.sourceKind === 'pdf' || media.sourceKind === 'image') {
      assert.equal(media.extractionEngine, 'windowsml-ocr');
      assert.equal(media.model, 'pp-ocrv6-medium-windowsml');
      assert.equal(media.device, 'windowsml-dml');
      assert.ok(Number.isSafeInteger(media.pageLocators) && Number(media.pageLocators) > 0);
    } else {
      assert.equal(media.extractionEngine, 'speech-recognition');
      assert.ok(Number.isSafeInteger(media.timeLocators) && Number(media.timeLocators) > 0);
    }
  }
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u);
  assert.doesNotMatch(serialized, /(?:\\\\|\/Users\/|\/home\/)/u);
  assert.doesNotMatch(serialized, /(?:authorization|bearer|token|secret|api[_-]?key)/iu);
  assert.doesNotMatch(serialized, /(?:sourceText|expectedText|audioText|transcript)/iu);
}

async function waitForPortReleased(port: number): Promise<void> {
  await waitUntil(async () => {
    try {
      const probe = await new Promise<boolean>((resolvePromise) => {
        const server = net.createServer();
        server.once('error', () => resolvePromise(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)));
      });
      return probe || false;
    } catch {
      return false;
    }
  }, 30_000, 'Owned WebView2 CDP listener remained bound after cleanup.');
}

export function buildModelSmokeLaunchEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  directories: {
    readonly root: string;
    readonly appData: string;
    readonly localAppData: string;
    readonly temporary: string;
    readonly webViewData: string;
  },
  fixtures: {
    readonly pdf: string;
    readonly image: string;
    readonly audio: string;
  },
  whisper: {
    readonly preferGpu: boolean;
    readonly device: string;
  },
  audioOnly: boolean,
  cdpPort = dynamicWebViewCdpPort,
): Record<string, string | undefined> {
  const appEnvironment = buildInstalledAppEnvironment(sourceEnv, directories, cdpPort);
  appEnvironment.CAPTURE_SMOKE_APP_DATA_ROOT = directories.appData;
  appEnvironment.CAPTURE_SMOKE_FIXTURE_ROOT = directories.root;
  Object.assign(appEnvironment, modelSmokeFixtureEnvironment(fixtures));
  assertNoAmbientModelOverrides(appEnvironment);
  appEnvironment.CAPTURE_WHISPER_PREFER_GPU = String(whisper.preferGpu);
  appEnvironment.CAPTURE_WHISPER_ALLOW_CPU_FALLBACK = String(
    audioOnly || whisperCpuFallbackAllowedForSourceLock(whisper.device),
  );
  if (appEnvironment.CAPTURE_WHISPER_PREFER_GPU !== String(whisper.preferGpu)) {
    throw new Error('Lock-derived Whisper GPU preference drifted before app launch.');
  }
  return appEnvironment;
}

async function run(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Real model-enabled desktop smoke requires Windows x64.');
  const installationOnly = process.argv.includes('--install-whisper-only');
  const audioOnly = process.argv.includes('--audio-only');
  const keepRunDataOnFailure = process.argv.includes('--keep-run-data-on-failure');
  const reuseRunData = process.argv.includes('--reuse-run-data');
  assertNoAmbientModelOverrides(process.env as Record<string, string>);
  const expected = await loadReleaseModelContract();
  assertNvidiaDriverForCudaSpeechContent(process.env.SystemRoot);
  await firstValueFrom(assertStagedRuntime('release'));
  await rm(smokeRoot, { recursive: true, force: true });
  if (!reuseRunData) await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  let inputs: readonly [MediaInput, MediaInput, MediaInput] | undefined;
  let audio: MediaInput | undefined;
  try {
    if (audioOnly) {
      inputs = await prepareAudioOnlyInputs();
      audio = inputs[2];
    } else {
      inputs = await prepareInputs(expected);
      audio = inputs[2];
    }
  } catch (error) {
    throw errorWithoutSecrets(error);
  }
  const [pdf, image] = inputs ?? [];
  const executable = resolve(process.env.CAPTURE_REAL_MEDIA_MODEL_EXECUTABLE?.trim() || defaultDesktopExecutable);
  let metadata;
  try { metadata = await lstat(executable); } catch { throw new Error('CAPTURE_REAL_MEDIA_MODEL_EXECUTABLE must be a regular packaged Tauri executable.'); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('CAPTURE_REAL_MEDIA_MODEL_EXECUTABLE must be a regular packaged Tauri executable.');
  let cdpPort: number | undefined;
  await mkdir(appDataRoot, { recursive: true });
  assert(inputs && pdf && image && audio);
  const appEnvironment = buildModelSmokeLaunchEnvironment(
    process.env,
    {
      root: runRoot,
      appData: appDataRoot,
      localAppData: localAppDataRoot,
      temporary: temporaryRoot,
      webViewData: webViewDataRoot,
    },
    {
      pdf: pdf.path,
      image: image.path,
      audio: audio.path,
    },
    {
      preferGpu: expected.whisperPreferGpu,
      device: expected.whisperDevice,
    },
    audioOnly,
  );
  let app: ReturnType<typeof spawn> | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  const summaries: MediaSummary[] = [];
  const installationOrder: RequirementId[] = [];
  let cleanupVerified = false;
  let cdpPortReleased = false;
  let workerMirrorReleased = false;
  let workerMirror: CandidateWorkerMirror | undefined;
  let activeDocumentId: string | undefined;
  let activeModelInstallationId: string | undefined;
  let runFailed = false;
  try {
    workerMirror = await startCandidateWorkerMirror(expected);
    appEnvironment.CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN = '1';
    appEnvironment.CAPTURE_SMOKE_WORKER_MIRROR_URL = workerMirror.baseUrl;
    assertCudaPathRetainedForAppLaunch(process.env, appEnvironment);
    app = spawn(executable, [], { cwd: resolve(executable, '..'), env: appEnvironment, stdio: 'ignore', windowsHide: true });
    if (!app.pid) throw new Error('Real model smoke Tauri process did not expose a PID.');
    const connected = await firstValueFrom(
      connectToInstalledWebView(dynamicWebViewCdpPort, app, webViewDataRoot),
    );
    browser = connected.browser;
    cdpPort = connected.port;
    page = await firstValueFrom(installedPage(browser, app));
    const currentPage = page;
    const invoke: TauriInvoke = (command, args) => invokeTauriCommand(currentPage, command, args);
    await waitForDesktopRuntimeReady(invoke);
    await waitForRuntimeRequirementsLoaded(invoke);
    const useBackendReuseReadiness = shouldUseBackendReuseReadiness(reuseRunData, audioOnly);
    if (useBackendReuseReadiness) {
      await waitForRuntimeRequirementsReady([
        'windowsml-ocr',
        'ollama-runtime',
        'capture-ollama-model',
        'speech-recognition',
      ], invoke);
      await waitForRuntimeModelOptionActive(expected.selectedModelOptionId, invoke);
    }
    if (installationOnly) {
      await installConsentedRequirementsThroughTauri(['speech-recognition'], installationOrder, invoke);
    } else {
      if (!audioOnly) {
        assert(inputs && pdf && image);
        if (!useBackendReuseReadiness) {
          await installConsentedRequirementsThroughTauri(
            ['windowsml-ocr', 'ollama-runtime'],
            installationOrder,
            invoke,
          );
          await installModelThroughTauri(expected.selectedModelOptionId, invoke, (installationId) => {
            activeModelInstallationId = installationId;
          });
          activeModelInstallationId = undefined;
        }
        for (const input of [pdf, image] as const) {
          const startedAt = Date.now();
          const documentId = await importModelSmokeFixtureDocument(input.kind, invoke);
          activeDocumentId = documentId;
          await waitForImportedDocumentInLibrary(documentId, invoke);
          await currentPage.reload({ waitUntil: 'load' });
          await waitForDesktopRuntimeReady(invoke);
          await waitForRuntimeRequirementsLoaded(invoke);
          const initialCaptureId = await waitForCaptureAccepted(documentId, invoke);
          summaries.push(await assertCaptureRecord(input, expected, documentId, invoke, {
            importedAt: startedAt,
            initialCaptureId,
          }));
          activeDocumentId = undefined;
        }
      } else if (!useBackendReuseReadiness) {
        await installConsentedRequirementsThroughTauri(['ollama-runtime'], installationOrder, invoke);
        await installModelThroughTauri(expected.selectedModelOptionId, invoke, (installationId) => {
          activeModelInstallationId = installationId;
        });
        activeModelInstallationId = undefined;
      }

      if (!useBackendReuseReadiness) {
        await installConsentedRequirementsThroughTauri(['speech-recognition'], installationOrder, invoke);
      } else {
        installationOrder.push('speech-recognition');
      }
      if (audioOnly) {
        await waitForRuntimeRequirementsReady(['speech-recognition'], invoke);
      }
      if (!audioOnly && (installationOrder.indexOf('windowsml-ocr') < 0
        || installationOrder.indexOf('speech-recognition') < 0
        || installationOrder.indexOf('windowsml-ocr') > installationOrder.indexOf('speech-recognition'))) {
        throw new Error('Consented model installation did not complete OCR before Whisper.');
      }

      const audioStartedAt = Date.now();
      const audioDocumentId = await importModelSmokeFixtureDocument(audio.kind, invoke);
      activeDocumentId = audioDocumentId;
      await waitForImportedDocumentInLibrary(audioDocumentId, invoke);
      await currentPage.reload({ waitUntil: 'load' });
      await waitForDesktopRuntimeReady(invoke);
      await waitForRuntimeRequirementsLoaded(invoke);
      await firstValueFrom(navigatePackagedRoute(currentPage, '/asr'));
      const initialAudioCaptureId = await waitForCaptureAccepted(audioDocumentId, invoke);
      const oracle = await loadProgressiveAudioOracle();
      summaries.push(await assertCaptureRecord(audio, expected, audioDocumentId, invoke, {
        importedAt: audioStartedAt,
        initialCaptureId: initialAudioCaptureId,
        oracle,
      }));
      activeDocumentId = undefined;
    }
    cleanupVerified = true;
  } catch (error) {
    runFailed = true;
    const errorPage = page;
    const invokeForDiagnostics: TauriInvoke | undefined = errorPage
      ? (command, args) => invokeTauriCommand(errorPage, command, args)
      : undefined;
    const backendCaptureState = invokeForDiagnostics
      ? await collectSafeBackendCaptureState(invokeForDiagnostics, activeDocumentId).catch(() => undefined)
      : undefined;
    const backendState = invokeForDiagnostics
      ? await collectSafeBackendState(invokeForDiagnostics, activeModelInstallationId).catch(() => ({}))
      : {};
    throw new Error(safeSmokeFailureMessage(
      error,
      workerMirror?.requests() ?? 0,
      backendState,
      backendCaptureState,
    ));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (app?.pid) {
      const terminate = createTrackedProcessTreeTerminator({
        smokeRoot,
        workspaceRoot,
        baseChildEnvironment: (source: NodeJS.ProcessEnv) => ({ PATH: source.PATH || '' }),
        windowsSystemExecutable: (...segments: string[]) => join(process.env.SystemRoot || 'C:\\Windows', ...segments),
      });
      await firstValueFrom(terminate(app, 'Real model-enabled Tauri application')).catch(() => undefined);
    }
    if (cdpPort === undefined) {
      cdpPortReleased = true;
    } else {
      await waitForPortReleased(cdpPort)
        .then(() => { cdpPortReleased = true; })
        .catch(() => { cleanupVerified = false; });
    }
    if (workerMirror) {
      await workerMirror.close();
      await waitForPortReleased(workerMirror.port)
        .then(() => { workerMirrorReleased = true; })
        .catch(() => { cleanupVerified = false; });
    }
    if (!(runFailed && keepRunDataOnFailure)) {
      await rm(runRoot, { recursive: true, force: true }).catch(() => { cleanupVerified = false; });
    }
  }
  if (!cdpPortReleased) throw new Error('Owned WebView2 CDP listener remained bound after cleanup.');
  // A reused production run may already contain a checksum-verified worker
  // and model. In that case the runtime correctly skips the mirror download;
  // a fresh run still requires the candidate mirror request as evidence that
  // the consented installation path was exercised.
  const minimumWorkerMirrorRequests = reuseRunData
    ? 0
    : installationOnly || audioOnly
      ? 1
      : 2;
  if (!workerMirrorReleased || !workerMirror || workerMirror.requests() < minimumWorkerMirrorRequests) {
    throw new Error('Candidate worker mirror did not serve the required worker archive requests and release its listener.');
  }
  if (!cleanupVerified) throw new Error('Owned desktop/runtime process cleanup was not verified.');
  if (installationOnly) {
    process.stdout.write('Whisper installation-only Tauri probe completed with owned cleanup.\n');
    return;
  }
  if (audioOnly) {
    const audioSummary = summaries[0];
    if (!audioSummary || audioSummary.sourceKind !== 'audio') {
      throw new Error('Audio-only smoke did not produce an audio summary.');
    }
    process.stdout.write(`Real model-enabled Tauri Audio smoke completed: device=${audioSummary.device}; cleanup=verified.\n`);
    return;
  }
  const report: RealMediaModelEvidence = {
    evidenceKind: 'real-model-enabled-tauri-host-smoke',
    sourceImportMode: REAL_MODEL_SOURCE_IMPORT_MODE,
    nativePickerExercised: false,
    releaseGateSatisfied: false,
    localProductionPreflight: true,
    consumerE2e: false,
    runtimeVersion: REAL_MODEL_RELEASE_VERSION,
    catalogVersion: REAL_MODEL_CATALOG_VERSION,
    sourceLockSha256: expected.sourceLockSha256,
    catalogSha256: expected.catalogSha256,
    selectedModelOptionId: 'qwen3.5-0.8b-v1',
    modelDependencyOrder: [...installationOrder] as [RequirementId, RequirementId],
    modelDependencyOrderScope: REAL_MODEL_DEPENDENCY_ORDER_SCOPE,
    media: summaries as [MediaSummary, MediaSummary, MediaSummary],
    rawPersisted: true,
    resultPersisted: true,
    consentedInstallation: true,
    capturesDeletedAfterVerification: true,
    ownedProcessCleanupVerified: true,
    cdpPortReleased: true,
    candidateMirrorUsed: true,
    candidateMirrorReleased: true,
    isolatedAppDataUsed: true,
  };
  assertRealMediaModelEvidence(report);
  await mkdir(smokeRoot, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`Real model-enabled Tauri host smoke report: ${relative(workspaceRoot, evidencePath)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
