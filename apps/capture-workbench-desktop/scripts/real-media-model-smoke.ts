import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

import { type Browser, type Page } from '@playwright/test';
import { firstValueFrom } from 'rxjs';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import { buildInstalledAppEnvironment } from './contracts/installed.ts';
import {
  connectToInstalledWebView,
  installedPage,
  reserveLoopbackPort,
} from './installed-browser.ts';
import {
  createTrackedProcessTreeTerminator,
} from './installed-process-cleanup.ts';
import { appRoot } from './stage-runtime.ts';

export const REAL_MODEL_RELEASE_VERSION = '0.3.11';
export const REAL_MODEL_CATALOG_VERSION = '2';
export const REAL_MODEL_DEPENDENCY_ORDER_SCOPE = 'source-lock-model-requirements-only';
export const REAL_MODEL_SOURCE_IMPORT_MODE = 'deterministic-feature-gated-picker-bypass';
export const REAL_MODEL_REQUIREMENT_ORDER = [
  'windowsml-ocr',
  'whisper-primary',
] as const;
export const REAL_MODEL_RUNTIME_READY_TIMEOUT_MS = 3 * 60_000;
export const REAL_MODEL_INSTALL_TIMEOUT_MS = 90 * 60_000;
export const REAL_MODEL_CAPTURE_TIMEOUT_MS = 5 * 60_000;
export const REAL_MODEL_CAPTURE_START_TIMEOUT_MS = 30_000;
export const REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS = 10 * 60_000;
export const REAL_MODEL_AUDIO_SAMPLE_SECONDS = 10 * 60;

export function assertAudioDeviceMatchesSourceLock(
  actualDevice: string | null,
  expectedDevice: string,
): void {
  assert.equal(actualDevice, expectedDevice);
}

export function whisperCpuFallbackAllowedForSourceLock(expectedDevice: string): boolean {
  return expectedDevice !== 'cuda';
}
export const REAL_MODEL_RESULT_TIMEOUT_MS = 60 * 60_000;
export const NATIVE_SOURCE_DIALOG_CLASSES = ['#32770'] as const;
export const NATIVE_SOURCE_BROKER_DIALOG_CLASSES = ['CabinetWClass'] as const;

const SAFE_UI_STATE_TEST_IDS = [
  'runtime-setup',
  'runtime-requirement',
  'runtime-install',
  'model-selection',
  'model-install',
  'model-install-progress',
  'source-import',
  'document-card',
  'document-detail',
  'document-raw',
  'document-result',
  'document-provenance',
  'document-extraction-provenance',
  'document-retry',
  'document-delete',
] as const;
const SAFE_UI_STATE_STATUSES = new Set([
  'active',
  'blocked',
  'completed',
  'downloading',
  'extracting',
  'failed',
  'idle',
  'installable',
  'installing',
  'queued',
  'ready',
  'unavailable',
]);
const SAFE_UI_STATE_REQUIREMENTS = new Set(['windowsml-ocr', 'whisper-primary', 'ollama-runtime']);
const SAFE_UI_STATE_SOURCE_KINDS = new Set(['pdf', 'image', 'audio']);
const SAFE_UI_STATE_ENGINES = new Set(['windowsml-ocr', 'whisper-primary']);
const SAFE_UI_STATE_DEVICES = new Set(['windowsml-dml', 'cpu']);
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
  'structuring_failed',
  'structuring_invalid_output',
]);
const SAFE_WORKER_STAGE_TOKEN = '(?:worker-entry(?:-[a-z0-9-]+)?|python-import-[a-z0-9-]+|ocr-[a-z0-9-]+|whisper-[a-z0-9-]+|worker-process-[a-z0-9-]+|worker-stage-sequence-truncated)';
const SAFE_WORKER_STAGE_SEQUENCE = `${SAFE_WORKER_STAGE_TOKEN}(?:>${SAFE_WORKER_STAGE_TOKEN})*`;
const SAFE_TERMINAL_DOCUMENT_FAILURE = new RegExp(
  `^Desktop capture terminated\\. status=(?:failed|canceled); stage=(?:queued|extracting|awaiting_structuring|structuring|persisting|completed|failed|cancelled|unknown); errorCode=(?:capture_cancelled|extraction_failed|requirement_unavailable|structuring_failed|structuring_invalid_output|unknown)(?:; mediaKind=(?:pdf|image|audio))?(?:; (?:workerStage=${SAFE_WORKER_STAGE_SEQUENCE}|failureReason=(?:no-non-empty-output|validation-failed|runtime-boundary|worker-boundary)))?\\.$`,
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
  `^Desktop runtime installation terminated\\. requirement=whisper-primary; status=(?:failed|cancelled|manual_action_required); stage=(?:queued|running|preparing|downloading|verifying|installing|probing|activating|failed|cancelled|manual_action_required|unknown); errorCode=[a-z][a-z0-9_-]{1,63}; progressBand=(?:early|download|late|unknown)(?:; workerStage=worker-process-[a-z0-9-]+(?:>worker-process-[a-z0-9-]+)*)?(?:; failureReason=(?:direct-model-retries-exhausted|direct-model-http-nonretryable|direct-model-content-length|direct-model-byte-count|direct-model-checksum|direct-model-redirect|runtime-install-unexpected))?\\.$`,
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
const generatedCatalogCandidates = [
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
  readonly whisperEngine: 'whisper-primary';
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
}

interface MediaSummary {
  readonly sourceKind: MediaKind;
  readonly sourceSha256: string;
  readonly extractionEngine: string;
  readonly model: string;
  readonly device: string;
  readonly engineDigest: string;
  readonly segmentCount: number;
  readonly pageLocators?: number;
  readonly timeLocators?: number;
  readonly durationMs: number;
}

export interface RealMediaModelEvidence {
  readonly evidenceKind: 'real-model-enabled-tauri-ui-smoke';
  readonly sourceImportMode: typeof REAL_MODEL_SOURCE_IMPORT_MODE;
  readonly nativePickerExercised: false;
  readonly releaseGateSatisfied: false;
  readonly localProductionPreflight: true;
  readonly consumerE2e: false;
  readonly runtimeVersion: typeof REAL_MODEL_RELEASE_VERSION;
  readonly catalogVersion: typeof REAL_MODEL_CATALOG_VERSION;
  readonly sourceLockSha256: string;
  readonly catalogSha256: string;
  readonly modelDependencyOrder: readonly RequirementId[];
  readonly modelDependencyOrderScope: typeof REAL_MODEL_DEPENDENCY_ORDER_SCOPE;
  readonly media: readonly [MediaSummary, MediaSummary, MediaSummary];
  readonly rawVisible: true;
  readonly resultVisible: true;
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

function validateSourceLockAndCatalog(
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
    throw new Error('Model source lock schema must be v2 for the 0.3.11 gate.');
  }
  if (lock.releaseVersion !== REAL_MODEL_RELEASE_VERSION) {
    throw new Error('Model source lock release version is not 0.3.11.');
  }
  const approval = asObject(lock.approval, 'Model source lock approval');
  if (approval.status !== 'approved' || !Array.isArray(approval.blockers) || approval.blockers.length !== 0) {
    throw new Error('Model source lock must be approved with no blockers.');
  }
  if (catalogObject.catalogVersion !== REAL_MODEL_CATALOG_VERSION) {
    throw new Error('Generated model catalog schema must be v2.');
  }
  if (catalogObject.runtimeVersion !== REAL_MODEL_RELEASE_VERSION) {
    throw new Error('Generated model catalog runtime version is not 0.3.11.');
  }
  const sourceLockHash = sha256(sourceLockBytes);
  const rawRequirements = lock.requirements;
  const rawCatalogRequirements = catalogObject.requirements;
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
    const artifacts = requirement.artifacts;
    const modelFiles = asObject(requirement.modelFiles, `${requirementId} model delivery`);
    if (!Array.isArray(artifacts) || artifacts.length !== 1 || requirement.unavailableReason !== null) {
      throw new Error(`${requirementId} catalog delivery is incomplete or unavailable.`);
    }
    const artifact = asObject(artifacts[0], `${requirementId} worker artifact`);
    if (artifact.role !== 'worker'
      || artifact.requirementId !== requirementId
      || artifact.artifactVersion !== REAL_MODEL_RELEASE_VERSION
      || artifact.platform !== 'windows'
      || artifact.arch !== 'x86_64'
      || typeof artifact.entryPoint !== 'string'
      || !artifact.entryPoint.endsWith('.exe')) {
      throw new Error(`${requirementId} worker artifact version drifted.`);
    }
    if (!Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 1
      || !Number.isSafeInteger(artifact.extractedBytes) || Number(artifact.extractedBytes) < 1
      || typeof artifact.fileName !== 'string' || typeof artifact.url !== 'string') {
      throw new Error(`${requirementId} worker artifact metadata is malformed.`);
    }
    if (modelFiles.artifactVersion !== REAL_MODEL_RELEASE_VERSION) {
      throw new Error(`${requirementId} model artifact version drifted.`);
    }
    if (modelFiles.entryPoint !== lockRequirement.entryPoint
      || !canonicalJson(modelFiles.files).equals(canonicalJson(lockRequirement.files))) {
      throw new Error(`${requirementId} generated model files drifted from the source lock.`);
    }
    if (modelFiles.sourceLockSha256 !== sourceLockHash) {
      throw new Error(`${requirementId} catalog model files are not bound to the source lock.`);
    }
    const modelManifest = {
      artifactVersion: modelFiles.artifactVersion,
      entryPoint: modelFiles.entryPoint,
      files: modelFiles.files,
      manifestVersion: '1',
    };
    if (modelFiles.manifestSha256 !== sha256(canonicalJson(modelManifest))) {
      throw new Error(`${requirementId} model manifest hash drifted.`);
    }
    if (!/^[a-f0-9]{64}$/u.test(String(artifact.sha256))
      || !/^[a-f0-9]{64}$/u.test(String(artifact.filesManifestSha256))
      || !/^[a-f0-9]{64}$/u.test(String(modelFiles.manifestSha256))) {
      throw new Error(`${requirementId} catalog artifact digests are invalid.`);
    }
    workerArchives.push({
      requirementId,
      fileName: requiredString(artifact.fileName, `${requirementId} worker file name`),
      bytes: Number(artifact.bytes),
      sha256: requiredString(artifact.sha256, `${requirementId} worker SHA-256`),
    });
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
    whisperFixture.expectedEngine !== 'whisper-primary' ||
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
    ocrText: ocrFixture.expectedText,
    ocrImageSha256: requiredString(ocrFixture.sha256, 'OCR image fixture SHA-256'),
    ocrImageBytes: Number(ocrFixture.bytes),
    ocrPdfSha256: requiredString(ocrFixture.pdfSha256, 'OCR PDF fixture SHA-256'),
    ocrPdfBytes: Number(ocrFixture.pdfBytes),
    ocrEngine: 'windowsml-ocr',
    ocrModel: ocrFixture.expectedModel,
    ocrDevice: 'windowsml-dml',
    whisperEngine: 'whisper-primary',
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

function safeInputName(kind: MediaKind): string {
  return kind === 'pdf' ? 'model-scanned.pdf' : kind === 'image' ? 'model-reference.png' : 'model-private-audio.mp3';
}

function mediaTypeFor(kind: MediaKind): string {
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
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 50 * 1024 * 1024) {
    throw new Error(`${envName} must point to a non-empty regular file within the 50 MiB limit.`);
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
  if (!audioInput) throw new Error('CAPTURE_REAL_MEDIA_MODEL_AUDIO is required for the private runner audio fixture.');
  const sampleSource = join(runRoot, 'model-private-audio-sample-source.mp3');
  await createAudioSample(audioInput, sampleSource);
  return {
    ...(await regularInput(
      sampleSource,
      'private audio sample',
      'audio',
      join(runRoot, safeInputName('audio')),
    )),
    exactWhisperOutput: false,
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
    with av.open(str(destination), "w", format="mp3") as output_container:
        output_stream = output_container.add_stream("libmp3lame", rate=input_stream.rate)
        output_stream.layout = input_stream.layout
        for frame in input_container.decode(input_stream.index):
            if frame.time is not None and frame.time >= ${String(REAL_MODEL_AUDIO_SAMPLE_SECONDS)}:
                break
            for packet in output_stream.encode(frame):
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

async function startCandidateWorkerMirror(expected: ExpectedProvenance): Promise<CandidateWorkerMirror> {
  const archives = new Map<string, { path: string; bytes: number; sha256: string }>();
  for (const archive of expected.workerArchives) {
    if (!archive.fileName || /[\\/]/u.test(archive.fileName) || archive.fileName === '.' || archive.fileName === '..') {
      throw new Error('Candidate worker archive file name is unsafe.');
    }
    if (archives.has(archive.fileName)) {
      throw new Error('Candidate worker archive file names are not unique.');
    }
    const archivePath = join(workerMirrorRoot, archive.fileName);
    let metadata;
    try {
      metadata = await lstat(archivePath);
    } catch {
      throw new Error('Candidate worker archive is missing from the release staging directory.');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== archive.bytes) {
      throw new Error('Candidate worker archive does not match the generated catalog bytes.');
    }
    const archiveBytes = await readFile(archivePath);
    if (sha256(archiveBytes) !== archive.sha256) {
      throw new Error('Candidate worker archive does not match the generated catalog digest.');
    }
    archives.set(archive.fileName, { path: archivePath, bytes: archive.bytes, sha256: archive.sha256 });
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
    /^(?:CAPTURE_(?:USER_MODEL_DIR|EXTRACTION_PROVIDER|STRUCTURING_PROVIDER|OLLAMA_[A-Z0-9_]+|WINDOWSML_[A-Z0-9_]+|WHISPER_[A-Z0-9_]+)|OLLAMA_(?:MODELS|HOST))$/u.test(name),
  );
  if (forbidden.length > 0) throw new Error('Real model smoke environment contains ambient model/provider overrides.');
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

export function nativeDialogUiAutomationScript(): string {
  const commonDialogClasses = NATIVE_SOURCE_DIALOG_CLASSES.map((value) => `'${value}'`).join(', ');
  const brokerDialogClasses = NATIVE_SOURCE_BROKER_DIALOG_CLASSES.map((value) => `'${value}'`).join(', ');
  return `
$ErrorActionPreference = 'Stop'
trap {
  $exceptionType = [System.Text.RegularExpressions.Regex]::Replace($_.Exception.GetType().Name, '[^A-Za-z0-9_.#,:=-]', '_')
  $errorId = [System.Text.RegularExpressions.Regex]::Replace([string]$_.FullyQualifiedErrorId, '[^A-Za-z0-9_.#,:=-]', '_')
  Write-Output ('UIA|stage=unhandled|code=exception|type=' + $exceptionType + '|error=' + $errorId + '|line=' + [string]$_.InvocationInfo.ScriptLineNumber)
  exit 9
}
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

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr handle, uint command);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

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

  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeoutText(IntPtr handle, uint message, IntPtr wParam, string lParam, uint flags, uint timeoutMs, out IntPtr result);

  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);

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

  public static bool ActivateExactWindow(IntPtr handle, uint processId, string expectedClass) {
    if (!HasExactIdentity(handle, processId, expectedClass, true)) return false;
    if (GetForegroundWindow() == handle) return true;
    if (IsIconic(handle)) ShowWindowAsync(handle, SW_RESTORE);

    uint verifiedProcessId;
    var targetThreadId = GetWindowThreadProcessId(handle, out verifiedProcessId);
    if (targetThreadId == 0 || verifiedProcessId != processId) return false;
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
    return HasExactIdentity(handle, processId, expectedClass, true) && GetForegroundWindow() == handle;
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

$root = [System.Windows.Automation.AutomationElement]::RootElement
$targetProcessId = [int]$env:CAPTURE_SMOKE_APP_PID
$commonDialogClasses = @(${commonDialogClasses})
$brokerDialogClasses = @(${brokerDialogClasses})

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

function Get-WindowProcessId([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return 0 }
  [uint32]$processId = 0
  [void][CaptureDialogOwner]::GetWindowThreadProcessId($handle, [ref]$processId)
  return [int]$processId
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
    ExplorerProcess = $false
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
      if ([System.Diagnostics.Process]::GetProcessById([int]$current.ProcessId).ProcessName -cne 'explorer') {
        $facts.ExplorerProcess = $false
      } else {
        $facts.ExplorerProcess = $true
      }
    } catch { }
    try {
      $windowPattern = $element.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $facts.Modal = [bool]$windowPattern.Current.IsModal
    } catch { }
    $facts.Eligible = $facts.ClassAllowed -and
      $facts.DifferentProcess -and
      $facts.ExplorerProcess -and
      $facts.Foreground -and
      $facts.Modal -and
      $facts.NewWindow -and
      $facts.SingleTarget -and
      $facts.TargetStillOwned -and
      $facts.TargetWasEnabled -and
      $facts.TargetDisabled
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
    switch ([string]$character) {
      '+' { [void]$builder.Append('{+}') }
      '^' { [void]$builder.Append('{^}') }
      '%' { [void]$builder.Append('{%}') }
      '~' { [void]$builder.Append('{~}') }
      '(' { [void]$builder.Append('{(}') }
      ')' { [void]$builder.Append('{)}') }
      '[' { [void]$builder.Append('{[}') }
      ']' { [void]$builder.Append('{]}') }
      '{' { [void]$builder.Append('{{}') }
      '}' { [void]$builder.Append('{}}') }
      default { [void]$builder.Append($character) }
    }
  }
  return $builder.ToString()
}

function Find-FilenameTarget($dialog) {
  $filenameHost = Find-ByAutomationId $dialog 'FileNameControlHost'
  if ($null -ne $filenameHost) {
    $action = Get-ValueAction $filenameHost
    if ($null -ne $action) { return @{ Element = $filenameHost; Action = $action } }
    $hostNodes = $filenameHost.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($node in $hostNodes) {
      $action = Get-ValueAction $node
      if ($null -ne $action) { return @{ Element = $node; Action = $action } }
    }
  }

  foreach ($automationId in @('1148', '1001')) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $automationId
    )
    $candidates = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($preferredClass in @('Edit', 'ComboBox', 'ComboBoxEx32')) {
      foreach ($candidate in $candidates) {
        try {
          if ($candidate.Current.ClassName -ne $preferredClass) { continue }
        } catch { continue }
        $action = Get-ValueAction $candidate
        if ($null -ne $action) { return @{ Element = $candidate; Action = $action } }
        try {
          if ($candidate.Current.ClassName -eq 'Edit' -and $candidate.Current.NativeWindowHandle -ne 0) {
            return @{ Element = $candidate; Action = @{ Kind = 'Win32Text'; Handle = [IntPtr]$candidate.Current.NativeWindowHandle } }
          }
        } catch { }
      }
    }
  }
  return $null
}

function Find-OpenTarget($dialog) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    '1'
  )
  $buttons = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )
  foreach ($button in $buttons) {
    try {
      $current = $button.Current
      if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Button -and $current.ClassName -notmatch 'Button') { continue }
    } catch { continue }
    $action = Get-InvokeAction $button
    if ($null -ne $action) { return @{ Element = $button; Action = $action } }
    try {
      if ($button.Current.NativeWindowHandle -ne 0) {
        return @{ Element = $button; Action = @{ Kind = 'Win32Click'; Handle = [IntPtr]$button.Current.NativeWindowHandle } }
      }
    } catch { }
  }
  return $null
}

function Write-ElementDiagnostics($prefix, $element, $relation) {
  try {
    $current = $element.Current
    $controlType = Get-SafeMetadata $current.ControlType.ProgrammaticName
    $automationId = Get-SafeMetadata $current.AutomationId
    $className = Get-SafeMetadata $current.ClassName
    $patterns = Get-SafeMetadata (Get-PatternNames $element)
    Write-Output ($prefix + '|pid=' + [string]$current.ProcessId + '|relation=' + (Get-SafeMetadata $relation) + '|aid=' + $automationId + '|type=' + $controlType + '|class=' + $className + '|patterns=' + $patterns)
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

$targetMainWindowHandles = @([CaptureDialogOwner]::FindExactTopLevelWindows(
  [uint32]$targetProcessId,
  'Tauri_Window'
))
if ($targetMainWindowHandles.Count -ne 1) {
  Write-Output ('UIA|stage=target-window|code=count-invalid|count=' + [string]$targetMainWindowHandles.Count)
  exit 6
}
$targetHandle = [IntPtr][long]$targetMainWindowHandles[0]
$activationDeadline = [DateTime]::UtcNow.AddSeconds(3)
$targetActivated = $false
while ([DateTime]::UtcNow -lt $activationDeadline) {
  try {
    $targetElement = [System.Windows.Automation.AutomationElement]::FromHandle($targetHandle)
    $targetElement.SetFocus()
  } catch { }
  if ([CaptureDialogOwner]::ActivateExactWindow($targetHandle, [uint32]$targetProcessId, 'Tauri_Window')) {
    $targetActivated = $true
    break
  }
  Start-Sleep -Milliseconds 100
}
if (-not $targetActivated) {
  Write-Output 'UIA|stage=target-activation|code=failed|count=1'
  exit 7
}

$baselineWindowHandles = New-Object 'System.Collections.Generic.HashSet[long]'
foreach ($handle in [CaptureDialogOwner]::SnapshotTopLevelWindowHandles()) {
  [void]$baselineWindowHandles.Add([long]$handle)
}
$targetMainWindowWasEnabled = [CaptureDialogOwner]::IsWindowEnabled($targetHandle)
Write-Output 'UIA|stage=ready|code=activated'

$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($dialog in $windows) {
    $relation = Get-ElementRelation $dialog
    $dialogKind = ''
    try {
      $current = $dialog.Current
      if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Window) { continue }
      if ($relation -ne 'other' -and $commonDialogClasses -contains [string]$current.ClassName) {
        $dialogKind = 'common'
      } elseif (Test-BrokeredDialog $dialog) {
        $dialogKind = 'brokered'
        $relation = 'brokered'
      }
    } catch { continue }
    if ([string]::IsNullOrEmpty($dialogKind)) { continue }

    $filename = Find-FilenameTarget $dialog
    if ($null -eq $filename) { continue }
    try {
      if ($filename.Action.Kind -eq 'Value') {
        $filename.Action.Pattern.SetValue($env:CAPTURE_SMOKE_DIALOG_FILE)
      } elseif ($filename.Action.Kind -eq 'Keyboard') {
        $filename.Element.SetFocus()
        Start-Sleep -Milliseconds 50
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeysLiteral $env:CAPTURE_SMOKE_DIALOG_FILE))
      } else {
        $messageResult = [IntPtr]::Zero
        $sent = [CaptureDialogOwner]::SendMessageTimeoutText($filename.Action.Handle, 0x000C, [IntPtr]::Zero, $env:CAPTURE_SMOKE_DIALOG_FILE, 0x0002, 2000, [ref]$messageResult)
        if ($sent -eq [IntPtr]::Zero) { throw 'Filename control did not accept WM_SETTEXT.' }
      }
    } catch {
      Write-Output 'UIA|stage=set-value|code=failed'
      Write-DialogDiagnostics $dialog $relation
      exit 2
    }

    $open = Find-OpenTarget $dialog
    if ($null -eq $open) {
      Write-Output 'UIA|stage=find-open|code=missing'
      Write-DialogDiagnostics $dialog $relation
      exit 3
    }

    try {
      if ($open.Action.Kind -eq 'Invoke') {
        $open.Action.Pattern.Invoke()
      } elseif ($open.Action.Kind -eq 'Keyboard') {
        $open.Element.SetFocus()
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      } else {
        $messageResult = [IntPtr]::Zero
        $sent = [CaptureDialogOwner]::SendMessageTimeout($open.Action.Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 2000, [ref]$messageResult)
        if ($sent -eq [IntPtr]::Zero) { throw 'Open control did not accept BM_CLICK.' }
      }
    } catch {
      Write-Output 'UIA|stage=invoke-open|code=failed'
      Write-DialogDiagnostics $dialog $relation
      exit 4
    }

    $dialogHandle = $dialog.Current.NativeWindowHandle
    $dialogDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $dialogDeadline) {
      if (-not (Test-DialogStillOpen $dialog ([IntPtr]$dialogHandle))) { exit 0 }
      Start-Sleep -Milliseconds 100
    }
    Write-Output 'UIA|stage=close-dialog|code=timeout'
    Write-DialogDiagnostics $dialog $relation
    exit 5
  }
  Start-Sleep -Milliseconds 100
}
Write-Output 'UIA|stage=find-dialog|code=timeout'
Write-TopLevelDiagnostics
exit 1
`;
}

export function safeUiAutomationDiagnostics(output: string): string {
  const diagnostics = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length <= 500 && /^(?:UIA|TOP)\|[A-Za-z0-9_.#,:;=|-]+$/u.test(line))
    .slice(0, 120)
    .join(' ');
  return diagnostics || 'none';
}

class NativePickerAutomationError extends Error {
  readonly diagnostics: string;

  constructor(diagnostics: string) {
    super('Native source picker automation failed.');
    this.name = 'NativePickerAutomationError';
    this.diagnostics = diagnostics;
  }
}

function allowedStringList(value: unknown, allowed: ReadonlySet<string>): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && allowed.has(item)))].slice(0, 8);
}

export function safeUiStateSnapshot(records: readonly unknown[]): string {
  const allowedTestIds = new Set<string>(SAFE_UI_STATE_TEST_IDS);
  const safeRecords = records.slice(0, SAFE_UI_STATE_TEST_IDS.length * 2).flatMap((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.testId !== 'string' || !allowedTestIds.has(candidate.testId)) return [];
    const count = Number.isSafeInteger(candidate.count) && Number(candidate.count) >= 0
      ? Math.min(Number(candidate.count), 32)
      : 0;
    const record: Record<string, unknown> = { testId: candidate.testId, count };
    const statuses = allowedStringList(candidate.statuses, SAFE_UI_STATE_STATUSES);
    const requirementIds = allowedStringList(candidate.requirementIds, SAFE_UI_STATE_REQUIREMENTS);
    const sourceKinds = allowedStringList(candidate.sourceKinds, SAFE_UI_STATE_SOURCE_KINDS);
    const engines = allowedStringList(candidate.engines, SAFE_UI_STATE_ENGINES);
    const devices = allowedStringList(candidate.devices, SAFE_UI_STATE_DEVICES);
    if (statuses.length) record.statuses = statuses;
    if (requirementIds.length) record.requirementIds = requirementIds;
    if (sourceKinds.length) record.sourceKinds = sourceKinds;
    if (engines.length) record.engines = engines;
    if (devices.length) record.devices = devices;
    return [record];
  });
  return JSON.stringify(safeRecords);
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
  uiStateRecords: readonly unknown[],
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
  return `Real model smoke failed. failure=${failureKind}; error-sha256=${errorDigest}${diagnostics}${terminal}. Candidate worker mirror requests: ${requestCount}. UI state: ${safeUiStateSnapshot(uiStateRecords)}${backend}`;
}

async function collectSafeBackendCaptureState(
  page: Page,
  documentId: string | undefined,
): Promise<string | undefined> {
  if (!documentId) return undefined;
  try {
    const library = await invokeTauriCommand(page, 'library_list', {
      request: { query: '', status: '' },
    });
    if (!Array.isArray(library)) return undefined;
    const document = library.find((item) => (
      item !== null
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as Record<string, unknown>).documentId === documentId
    ));
    if (document === undefined || document === null || typeof document !== 'object' || Array.isArray(document)) {
      return undefined;
    }
    const summary = document as Record<string, unknown>;
    const captureId = typeof summary.captureId === 'string' ? summary.captureId : undefined;
    if (!captureId) {
      const status = typeof summary.status === 'string' && SAFE_UI_STATE_STATUSES.has(summary.status)
        ? summary.status
        : 'unknown';
      const stage = typeof summary.stage === 'string' && SAFE_TERMINAL_DOCUMENT_STAGES.has(summary.stage)
        ? summary.stage
        : 'unknown';
      return JSON.stringify({ status, stage, progressBand: 'unknown', errorCode: 'not-started' });
    }
    const capture = await invokeTauriCommand(page, 'runtime_get_capture', { input: { id: captureId } });
    if (capture === null || typeof capture !== 'object' || Array.isArray(capture)) return undefined;
    const job = capture as Record<string, unknown>;
    const status = typeof job.status === 'string' && SAFE_UI_STATE_STATUSES.has(job.status)
      ? job.status
      : 'unknown';
    const stage = typeof job.stage === 'string' && SAFE_TERMINAL_DOCUMENT_STAGES.has(job.stage)
      ? job.stage
      : 'unknown';
    const progress = typeof job.progress === 'number' && Number.isFinite(job.progress)
      ? Math.max(0, Math.min(1, job.progress))
      : undefined;
    const progressBand = progress === undefined
      ? 'unknown'
      : progress < 0.35
        ? 'early'
        : progress < 0.85
          ? 'middle'
          : 'late';
    const error = job.error;
    const errorCode = error !== null && typeof error === 'object' && !Array.isArray(error)
      && typeof (error as Record<string, unknown>).code === 'string'
      && /^[a-z][a-z0-9_-]{1,63}$/u.test((error as Record<string, unknown>).code as string)
      ? (error as Record<string, unknown>).code as string
      : 'none';
    return JSON.stringify({ status, stage, progressBand, errorCode });
  } catch {
    return undefined;
  }
}

async function collectSafeUiState(page: Page): Promise<readonly unknown[]> {
  return page.evaluate((testIds) => testIds.map((testId) => {
    const nodes = Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)).slice(0, 32);
    const attributeValues = (attribute: string) => nodes
      .map((node) => node.getAttribute(attribute))
      .filter((value): value is string => value !== null);
    return {
      testId,
      count: nodes.length,
      statuses: attributeValues('data-status'),
      requirementIds: attributeValues('data-requirement-id'),
      sourceKinds: attributeValues('data-source-kind'),
      engines: attributeValues('data-engine'),
      devices: attributeValues('data-device'),
    };
  }), SAFE_UI_STATE_TEST_IDS);
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
  const child = spawn(windowsPowerShellExecutable(systemRoot), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', nativeDialogUiAutomationScript()], {
    env: {
      SystemRoot: systemRoot,
      Path: process.env.Path || process.env.PATH || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      CAPTURE_SMOKE_APP_PID: String(appPid),
      CAPTURE_SMOKE_DIALOG_FILE: filePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const readyMarker = 'UIA|stage=ready|code=activated';
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
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString().slice(0, 65_536 - stdout.length);
      if (stdout.includes(readyMarker)) settleReady();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString().slice(0, 65_536 - stderr.length);
    });
    child.once('error', () => {
      failReady();
      resolvePromise({ code: null, stdout, stderr });
    });
    child.once('close', (code) => {
      failReady();
      resolvePromise({ code, stdout, stderr });
    });
  });
  const readyTimeout = setTimeout(failReady, 15_000);
  try {
    await ready;
  } catch (error) {
    child.kill();
    await result;
    throw error;
  } finally {
    clearTimeout(readyTimeout);
  }
  try {
    await onReady?.();
  } catch (error) {
    child.kill();
    await result;
    throw error;
  }
  const completed = await result;
  if (completed.code !== 0) {
    const diagnostics = safeUiAutomationDiagnostics(completed.stdout);
    throw new NativePickerAutomationError(diagnostics);
  }
}

interface InjectedFixtureDocument {
  readonly documentId: string;
  readonly startedAt: number;
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

async function injectModelSmokeFixture(
  page: Page,
  fixtureKey: MediaKind,
  options: { readonly waitForCaptureReady?: boolean } = {},
): Promise<InjectedFixtureDocument> {
  const startedAt = Date.now();
  const result = await invokeTauriCommand(page, 'model_smoke_import_fixture', {
    request: { fixtureKey },
  });
  const documentId = modelSmokeInjectedDocumentId(result);
  await waitForImportedDocumentInLibrary(page, documentId);
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (options.waitForCaptureReady !== false) await waitForCaptureReady(page);
  try {
    await waitForDocumentById(page, documentId);
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (options.waitForCaptureReady !== false) await waitForCaptureReady(page);
    await waitForDocumentById(page, documentId);
  }
  return { documentId, startedAt };
}

async function installConsentedRequirementThroughTauri(
  page: Page,
  requirementId: RequirementId,
  options: { readonly waitForVisibleRequirement?: boolean } = {},
): Promise<void> {
  const start = asObject(await invokeTauriCommand(page, 'runtime_start_installation', {
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
    const installation = asObject(await invokeTauriCommand(page, 'runtime_get_installation', {
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
  }, REAL_MODEL_INSTALL_TIMEOUT_MS, 'Consented runtime installation timed out.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (options.waitForVisibleRequirement !== false) {
    await waitForCaptureReady(page);
    await waitForRuntimeRequirementsReady(page, [requirementId]);
  }
}

export function safeTerminalInstallationFailure(
  requirementId: string,
  status: string | null,
  stage: string | null,
  errorCode: string | null,
  progress: number | null,
  errorMessage: string | null = null,
): string | undefined {
  if (requirementId !== 'whisper-primary' || status === null || !SAFE_INSTALLATION_STATUSES.has(status)) {
    return undefined;
  }
  const safeStage = stage !== null && SAFE_INSTALLATION_STAGES.has(stage) ? stage : 'unknown';
  const safeErrorCode = errorCode !== null && /^[a-z][a-z0-9_-]{1,63}$/u.test(errorCode)
    ? errorCode
    : 'unknown';
  const progressBand = progress === null || !Number.isFinite(progress) || progress < 0
    ? 'unknown'
    : progress < 0.35
      ? 'early'
      : progress < 0.85
        ? 'download'
        : 'late';
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
  return `Desktop runtime installation terminated. requirement=whisper-primary; status=${status}; stage=${safeStage}; errorCode=${safeErrorCode}; progressBand=${progressBand}${workerStage ? `; workerStage=${workerStage}` : ''}; failureReason=${failureReason}.`;
}

async function requirementStatus(page: Page, requirementId: SetupRequirementId): Promise<string> {
  const row = page.locator(`[data-testid="runtime-requirement"][data-requirement-id="${requirementId}"]`);
  if (await row.count() !== 1) return '';
  return (await row.getAttribute('data-status').catch(() => null))
    || (await row.locator('[data-testid="runtime-requirement-status"]').getAttribute('data-status').catch(() => null))
    || (await row.textContent().catch(() => null))
    || '';
}

export function requirementCompletedAfterConsent(
  status: string,
  wasVisibleBeforeConsent: boolean,
): boolean {
  return /ready/iu.test(status) || (wasVisibleBeforeConsent && status === '');
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
  const safeErrorCode = errorCode !== null && /^[a-z][a-z0-9_-]{1,63}$/u.test(errorCode)
    ? errorCode
    : 'unknown';
  const progressBand = progress === null || !Number.isFinite(progress) || progress < 0
    ? 'unknown'
    : progress < 0.35
      ? 'early'
      : progress < 0.85
        ? 'download'
        : 'late';
  return `Desktop model installation terminated. status=${status}; errorCode=${safeErrorCode}; progressBand=${progressBand}.`;
}

async function waitForRuntimeRequirementsReady(
  page: Page,
  requiredIds: readonly SetupRequirementId[],
): Promise<void> {
  await waitUntil(
    async () => runtimeRequirementsReady(
      await invokeTauriCommand(page, 'runtime_requirements', {}),
      requiredIds,
    ),
    REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
    `Runtime requirements did not become ready: ${requiredIds.join(', ')}.`,
  );
}

async function installConsentedRequirements(
  page: Page,
  requiredIds: readonly SetupRequirementId[],
  completionOrder: RequirementId[],
): Promise<void> {
  if (requiredIds.length === 0) return;
  const setup = page.getByTestId('runtime-setup');
  await setup.waitFor({ state: 'visible', timeout: REAL_MODEL_RUNTIME_READY_TIMEOUT_MS });
  const install = page.getByTestId('runtime-install');
  const wasVisibleBeforeConsent = new Map<SetupRequirementId, boolean>();
  for (const requirementId of requiredIds) {
    wasVisibleBeforeConsent.set(
      requirementId,
      (await page.locator(`[data-testid="runtime-requirement"][data-requirement-id="${requirementId}"]`).count()) === 1,
    );
  }
  const alreadyReady = await Promise.all(requiredIds.map(async (requirementId) => {
    const status = await requirementStatus(page, requirementId);
    return /ready/iu.test(status)
      || (!wasVisibleBeforeConsent.get(requirementId) && status === '');
  }));
  if (!alreadyReady.every(Boolean)) {
    await waitUntil(
      async () => (await install.isVisible().catch(() => false)) || false,
      REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
      'Desktop runtime setup did not expose the consented install action.',
    );
    await install.click();
  }
  const consentedAt = Date.now();
  const completedAt = new Map<SetupRequirementId, number>();
  requiredIds.forEach((requirementId, index) => {
    if (alreadyReady[index]) completedAt.set(requirementId, consentedAt);
  });
  await waitUntil(
    async () => {
      const backendReady = runtimeRequirementsReady(
        await invokeTauriCommand(page, 'runtime_requirements', {}),
        requiredIds,
      );
      if (backendReady) {
        const completedAtTimestamp = Date.now();
        requiredIds.forEach((requirementId) => {
          if (!completedAt.has(requirementId)) completedAt.set(requirementId, completedAtTimestamp);
        });
        return true;
      }
      for (const requirementId of requiredIds) {
        const status = await requirementStatus(page, requirementId);
        if (requirementCompletedAfterConsent(status, wasVisibleBeforeConsent.get(requirementId) === true)
          && !completedAt.has(requirementId)) {
          completedAt.set(requirementId, Date.now());
        }
      }
      return completedAt.size === requiredIds.length || false;
    },
    REAL_MODEL_INSTALL_TIMEOUT_MS,
    `Consented model installation did not complete: ${requiredIds.join(', ')}.`,
  );
  for (const requirementId of requiredIds) {
    if (requirementId !== 'ollama-runtime' && !completionOrder.includes(requirementId)) {
      completionOrder.push(requirementId);
    }
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRuntimeRequirementsReady(page, requiredIds);
}

async function waitForCaptureReady(page: Page): Promise<void> {
  const importButton = page.getByTestId('source-import');
  await waitUntil(
    async () => (await importButton.isEnabled().catch(() => false)) || false,
    REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
    'Desktop capture UI did not become ready after consented installation.',
  );
}

async function waitForDocumentById(
  page: Page,
  documentId: string,
): Promise<{ id: string; card: ReturnType<Page['locator']> }> {
  if (!/^[a-f0-9]{32}$/u.test(documentId)) {
    throw new Error('Desktop smoke document ID is invalid.');
  }
  const card = page.locator(`[data-testid="document-card"][data-document-id="${documentId}"]`);
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  if (await card.count() !== 1) {
    throw new Error('Desktop smoke document ID did not resolve to one card.');
  }
  return { id: documentId, card };
}

async function waitForImportedDocumentInLibrary(page: Page, documentId: string): Promise<void> {
  await waitUntil(
    async () => {
      const value = await invokeTauriCommand(page, 'library_list', {
        request: { query: '', status: '' },
      }).catch(() => undefined);
      if (!Array.isArray(value)) return false;
      return value.some((item) => (
        item !== null
        && typeof item === 'object'
        && !Array.isArray(item)
        && (item as Record<string, unknown>).documentId === documentId
      )) || false;
    },
    30_000,
    'Imported smoke document did not persist in the desktop library.',
  );
}

async function startInjectedCapture(page: Page, documentId: string): Promise<void> {
  const document = await waitForDocumentById(page, documentId);
  await document.card.click();
  const detail = page.locator(`[data-testid="document-detail"][data-document-id="${documentId}"]`);
  await detail.waitFor({ state: 'visible', timeout: 30_000 });
  const retry = detail.locator(`[data-testid="document-retry"][data-document-id="${documentId}"]`);
  await retry.waitFor({ state: 'visible', timeout: 30_000 });
  if (await retry.count() !== 1) {
    throw new Error('Injected document did not expose the exact UI processing action.');
  }
  await waitForCaptureReady(page);
  await retry.click();
  await waitUntil(
    async () => {
      const documents = await invokeTauriCommand(page, 'library_list', {
        request: { query: '', status: '' },
      }).catch(() => undefined);
      if (!Array.isArray(documents)) return false;
      const current = documents.find((item) => (
        item !== null
        && typeof item === 'object'
        && !Array.isArray(item)
        && (item as Record<string, unknown>).documentId === documentId
      ));
      if (current === undefined || current === null || typeof current !== 'object' || Array.isArray(current)) {
        return false;
      }
      const record = current as Record<string, unknown>;
      return record.status === 'processing'
        || (typeof record.captureId === 'string' && record.captureId.length > 0);
    },
    REAL_MODEL_CAPTURE_START_TIMEOUT_MS,
    'Desktop capture start was not accepted.',
  );
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

async function throwIfTerminalDocumentFailure(
  document: { readonly card: ReturnType<Page['locator']> },
  detail: ReturnType<Page['locator']>,
  mediaKind: MediaKind | null = null,
): Promise<void> {
  const status = await document.card.getAttribute('data-status');
  if (status === null || !SAFE_TERMINAL_DOCUMENT_STATUSES.has(status)) return;
  const stage = await detail.locator('[data-stage]').first().getAttribute('data-stage').catch(() => null);
  const errorCode = (await detail.locator('[role="alert"] strong').first().textContent().catch(() => null))?.trim() ?? null;
  const errorMessage = (await detail.locator('[role="alert"] p').first().textContent().catch(() => null))?.trim() ?? null;
  const failure = safeTerminalDocumentFailure(status, stage, errorCode, errorMessage, mediaKind);
  if (failure !== undefined) throw new Error(failure);
}

function parseJsonFromVisibleRaw(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

async function assertVisibleCapture(
  page: Page,
  input: MediaInput,
  expected: ExpectedProvenance,
  documentId: string,
  importedAt = Date.now(),
): Promise<MediaSummary> {
  const document = await waitForDocumentById(page, documentId);
  await document.card.click();
  const detail = page.locator(`[data-testid="document-detail"][data-document-id="${document.id}"]`);
  await detail.waitFor({ state: 'visible', timeout: 30_000 });
  const rawSection = detail.getByTestId('document-raw');
  const resultSection = detail.getByTestId('document-result');
  const provenanceSection = detail.getByTestId('document-provenance');
  const rawTimeout = input.kind === 'audio' ? REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS : REAL_MODEL_CAPTURE_TIMEOUT_MS;
  if (input.kind === 'audio') {
    await waitUntil(
      async () => {
        await throwIfTerminalDocumentFailure(document, detail, input.kind);
        return (await document.card.getAttribute('data-status')) === 'completed' || false;
      },
      REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS,
      `Desktop ${input.fileName} capture did not complete.`,
    );
  }
  await waitUntil(
    async () => {
      await throwIfTerminalDocumentFailure(document, detail, input.kind);
      if (await rawSection.count() !== 1) return false;
      return ((await rawSection.textContent())?.trim() || '') || false;
    },
    rawTimeout,
    `${input.kind} UI raw extraction did not become visible within its bounded timeout.`,
  );
  const extractionDurationMs = Date.now() - importedAt;
  const resultTimeout = REAL_MODEL_RESULT_TIMEOUT_MS;
  await waitUntil(
    async () => {
      await throwIfTerminalDocumentFailure(document, detail, input.kind);
      return (await resultSection.isVisible().catch(() => false))
        && (await provenanceSection.isVisible().catch(() => false));
    },
    resultTimeout,
    `${input.kind} UI result and provenance did not become visible within its bounded timeout.`,
  );
  const rawText = (await rawSection.textContent())?.trim() || '';
  const resultText = (await resultSection.textContent())?.trim() || '';
  const provenance = (await provenanceSection.textContent())?.trim() || '';
  if (!rawText || !resultText) throw new Error(`${input.kind} UI raw/result data was empty.`);
  const extractionProvenance = detail.getByTestId('document-extraction-provenance');
  await extractionProvenance.waitFor({ state: 'visible', timeout: resultTimeout });
  const expectedEngine = input.kind === 'audio' ? expected.whisperEngine : expected.ocrEngine;
  const expectedModel = input.kind === 'audio' ? expected.whisperModel : expected.ocrModel;
  const expectedDevice = input.kind === 'audio' ? expected.whisperDevice : expected.ocrDevice;
  const actualDevice = await extractionProvenance.getAttribute('data-device');
  assert.equal(await extractionProvenance.getAttribute('data-engine'), expectedEngine);
  assert.equal(await extractionProvenance.getAttribute('data-model'), expectedModel);
  if (input.kind === 'audio' && expected.whisperPreferGpu && input.exactWhisperOutput !== false) {
    assertAudioDeviceMatchesSourceLock(actualDevice, expectedDevice);
  } else if (input.kind === 'audio') {
    assert.ok(actualDevice === 'cuda' || actualDevice === 'cpu');
  } else {
    assert.equal(actualDevice, expectedDevice);
  }
  const extractionDigest = await extractionProvenance.getAttribute('data-digest');
  if (!extractionDigest || !/^sha256:[a-f0-9]{64}$/u.test(extractionDigest)) {
    throw new Error(`${input.kind} UI extraction provenance omitted a bounded engine digest.`);
  }
  if (input.kind !== 'audio') {
    const sourceText = ((await rawSection.locator('pre').textContent()) || '').trim();
    if (!sourceText) throw new Error(`${input.kind} UI raw source text was empty.`);
    if (input.expectedOcrText && !sourceText.includes(input.expectedOcrText)) {
      throw new Error(`${input.kind} UI raw text did not contain the lock-selected OCR fixture text.`);
    }
    if (input.expectedOcrTextSha256 && normalizedOcrTextDigest(sourceText) !== input.expectedOcrTextSha256) {
      throw new Error(`${input.kind} UI raw source text did not match the private OCR output oracle.`);
    }
  }
  if (input.kind === 'pdf' || input.kind === 'image') {
    assert.match(provenance, new RegExp(expected.ocrEngine.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(provenance, new RegExp(expected.ocrModel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(provenance, new RegExp(expected.ocrDevice.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    const pageLocators = await detail.locator('[data-locator-kind="page"]').count();
    if (pageLocators < 1) throw new Error(`${input.kind} UI raw data did not expose page locators.`);
    await deleteDocumentThroughUi(page, document.id);
    return {
      sourceKind: input.kind,
      sourceSha256: input.sha256,
      extractionEngine: expected.ocrEngine,
      model: expected.ocrModel,
      device: expected.ocrDevice,
      engineDigest: extractionDigest,
      segmentCount: pageLocators,
      pageLocators,
      durationMs: extractionDurationMs,
    };
  }
  assert.match(provenance, /whisper-primary/iu);
  assert.match(provenance, new RegExp(expected.whisperModel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  if (expected.whisperPreferGpu) {
    assert.match(provenance, /(?:cuda|cpu)/iu);
  } else {
    assert.match(provenance, new RegExp(expected.whisperDevice.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  const segmentCount = await assertAudioRawSegments(
    rawText,
    rawSection,
    expected,
    input.exactWhisperOutput !== false,
  );
  await deleteDocumentThroughUi(page, document.id);
  return {
    sourceKind: input.kind,
    sourceSha256: input.sha256,
    extractionEngine: expected.whisperEngine,
    model: expected.whisperModel,
    device: actualDevice || expected.whisperDevice,
    engineDigest: extractionDigest,
    segmentCount,
    timeLocators: segmentCount,
    durationMs: extractionDurationMs,
  };
}

async function assertAudioRawSegments(
  rawText: string,
  rawSection: ReturnType<Page['locator']>,
  expected: ExpectedProvenance,
  exactOutput: boolean,
): Promise<number> {
  const parsed = parseJsonFromVisibleRaw(rawText);
  const segments = parsed?.segments;
  if (Array.isArray(segments)) {
    let previousOrder = -1;
    let previousEnd = -1;
    const transcript: string[] = [];
    for (const segment of segments) {
      const object = asObject(segment, 'Audio segment');
      const locator = asObject(object.locator, 'Audio segment locator');
      const order = object.order;
      const startMs = locator.startMs;
      const endMs = locator.endMs;
      if (typeof object.text !== 'string' || object.text.trim() === ''
        || !Number.isSafeInteger(order) || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
        || order !== previousOrder + 1 || startMs < previousEnd || endMs <= startMs) {
        throw new Error('Audio UI raw segments were not contiguous and monotonic.');
      }
      transcript.push(object.text);
      previousOrder = order;
      previousEnd = endMs;
    }
    if (exactOutput && (segments.length < expected.whisperSegmentMinimum || segments.length > expected.whisperSegmentMaximum)) {
      throw new Error('Audio UI raw segment count drifted from the lock-selected fixture bounds.');
    }
    if (exactOutput && normalizedTranscriptDigest(transcript) !== expected.whisperNormalizedOutputSha256) {
      throw new Error('Audio UI raw normalized result did not match the lock-selected Whisper digest.');
    }
    return segments.length;
  }
  const rows = rawSection.locator('[data-locator-kind="time"]');
  const locators = await rows.evaluateAll((nodes) => nodes.map((node) => ({
    order: Number(node.getAttribute('data-order')),
    startMs: Number(node.getAttribute('data-start-ms')),
    endMs: Number(node.getAttribute('data-end-ms')),
    text: node.textContent || '',
  })));
  if (exactOutput && (locators.length < expected.whisperSegmentMinimum || locators.length > expected.whisperSegmentMaximum)) {
    throw new Error('Audio UI raw segment count drifted from the lock-selected fixture bounds.');
  }
  let previousEnd = -1;
  locators.forEach((locator, index) => {
    if (!locator.text.trim() || !Number.isSafeInteger(locator.order) || locator.order !== index
      || !Number.isSafeInteger(locator.startMs) || !Number.isSafeInteger(locator.endMs)
      || locator.startMs < previousEnd || locator.endMs <= locator.startMs) {
      throw new Error('Audio UI raw locators were not contiguous and monotonic.');
    }
    previousEnd = locator.endMs;
  });
  if (exactOutput && normalizedTranscriptDigest(locators.map((locator) => locator.text)) !== expected.whisperNormalizedOutputSha256) {
    throw new Error('Audio UI raw normalized result did not match the lock-selected Whisper digest.');
  }
  return locators.length;
}

function normalizedTranscriptDigest(transcript: readonly string[]): string {
  const normalized = transcript
    .map((value) => value.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join(' ');
  if (!normalized) throw new Error('Audio UI raw transcript was empty.');
  return sha256(Buffer.from(normalized, 'utf8'));
}

async function installSelectedModel(page: Page): Promise<void> {
  const optionId = 'qwen3.5-0.8b-v1';
  await page.getByTestId('model-selection').waitFor({
    state: 'visible',
    timeout: REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
  });
  const option = page.locator(
    `[data-testid="model-option"][data-model-option-id="${optionId}"]`,
  );
  await option.check();
  if (!await option.isChecked()) {
    throw new Error('The selected structuring model was not retained by the setup UI.');
  }
  const install = page.getByTestId('model-install');
  await waitUntil(
    async () => install.isEnabled().catch(() => false),
    30_000,
    'The selected structuring model did not enable its install action.',
  );
  await install.click();

  const progress = page.getByTestId('model-install-progress');
  try {
    await progress.waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    throw new Error('Desktop model installation did not start.');
  }
  const installationId = await progress.getAttribute('data-installation-id');
  const startedOptionId = await progress.getAttribute('data-option-id');
  if (installationId === null || !/^[A-Za-z0-9_-]{1,128}$/u.test(installationId)) {
    throw new Error('The model install action did not expose a valid installation identity.');
  }
  if (startedOptionId !== optionId) {
    throw new Error('The model install action started a different allowlisted option.');
  }

  await waitUntil(
    async () => {
      const installation = asObject(await invokeTauriCommand(page, 'runtime_get_model_installation', {
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
  await waitUntil(
    async () => runtimeModelOptionActive(
      await invokeTauriCommand(page, 'runtime_model_options', {}),
      optionId,
    ),
    REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
    'The completed qwen3.5 0.8B installation did not become active.',
  );
  await waitForRuntimeRequirementsReady(page, ['capture-ollama-model']);
  await page.reload({ waitUntil: 'domcontentloaded' });
}

export function normalizedOcrTextDigest(sourceText: string): string {
  const normalized = sourceText.replace(/\s+/gu, ' ').trim();
  if (!normalized) throw new Error('OCR source text was empty.');
  return sha256(Buffer.from(normalized, 'utf8'));
}

async function deleteDocumentThroughUi(page: Page, documentId: string): Promise<void> {
  const detail = page.locator(`[data-testid="document-detail"][data-document-id="${documentId}"]`);
  const deleteButton = page.locator(`[data-testid="document-delete"][data-document-id="${documentId}"]`);
  if ((await deleteButton.count()) !== 1) throw new Error('Desktop UI delete control was not scoped to the exact smoke UUID.');
  page.once('dialog', (dialog) => dialog.accept());
  await deleteButton.click();
  await waitUntil(
    async () => (await page.locator(`[data-testid="document-card"][data-document-id="${documentId}"]`).count()) === 0 || false,
    30_000,
    'Desktop UI did not delete the exact smoke UUID.',
  );
  if (await detail.count()) throw new Error('Desktop UI retained the deleted smoke document detail.');
}

export function assertRealMediaModelEvidence(value: unknown): asserts value is RealMediaModelEvidence {
  const report = asObject(value, 'Real model smoke report');
  assert.equal(report.evidenceKind, 'real-model-enabled-tauri-ui-smoke');
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
  assert.equal(report.rawVisible, true);
  assert.equal(report.resultVisible, true);
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
      assert.equal(media.extractionEngine, 'whisper-primary');
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

async function run(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Real model-enabled desktop smoke requires Windows x64.');
  const installationOnly = process.argv.includes('--install-whisper-only');
  const audioOnly = process.argv.includes('--audio-only');
  assertNoAmbientModelOverrides(process.env as Record<string, string>);
  const expected = await loadReleaseModelContract();
  await firstValueFrom(assertStagedRuntime('release'));
  await rm(smokeRoot, { recursive: true, force: true });
  await rm(runRoot, { recursive: true, force: true });
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
  const cdpPort = await firstValueFrom(reserveLoopbackPort());
  await mkdir(appDataRoot, { recursive: true });
  const appEnvironment = buildInstalledAppEnvironment(process.env, {
    root: runRoot,
    appData: appDataRoot,
    localAppData: localAppDataRoot,
    temporary: temporaryRoot,
    webViewData: webViewDataRoot,
  }, cdpPort);
  appEnvironment.CAPTURE_SMOKE_APP_DATA_ROOT = appDataRoot;
  appEnvironment.CAPTURE_SMOKE_FIXTURE_ROOT = runRoot;
  assert(inputs && pdf && image && audio);
  Object.assign(appEnvironment, modelSmokeFixtureEnvironment({
    pdf: pdf.path,
    image: image.path,
    audio: audio.path,
  }));
  assertNoAmbientModelOverrides(appEnvironment);
  appEnvironment.CAPTURE_WHISPER_PREFER_GPU = String(expected.whisperPreferGpu);
  appEnvironment.CAPTURE_WHISPER_ALLOW_CPU_FALLBACK = String(
    audioOnly || whisperCpuFallbackAllowedForSourceLock(expected.whisperDevice),
  );
  if (appEnvironment.CAPTURE_WHISPER_PREFER_GPU !== String(expected.whisperPreferGpu)) {
    throw new Error('Lock-derived Whisper GPU preference drifted before app launch.');
  }
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
  try {
    workerMirror = await startCandidateWorkerMirror(expected);
    appEnvironment.CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN = '1';
    appEnvironment.CAPTURE_SMOKE_WORKER_MIRROR_URL = workerMirror.baseUrl;
    assertCudaPathRetainedForAppLaunch(process.env, appEnvironment);
    app = spawn(executable, [], { cwd: resolve(executable, '..'), env: appEnvironment, stdio: 'ignore', windowsHide: true });
    if (!app.pid) throw new Error('Real model smoke Tauri process did not expose a PID.');
    browser = await firstValueFrom(connectToInstalledWebView(cdpPort, app));
    page = await firstValueFrom(installedPage(browser, app));
    await waitUntil(async () => {
      const setup = page.getByTestId('runtime-setup');
      return (await setup.count()) === 1 || false;
    }, REAL_MODEL_RUNTIME_READY_TIMEOUT_MS, 'Desktop runtime setup UI did not load.');
    if (installationOnly) {
      await installConsentedRequirementThroughTauri(page, 'whisper-primary', {
        waitForVisibleRequirement: false,
      });
      installationOrder.push('whisper-primary');
    } else {
      if (!audioOnly) {
        assert(inputs && pdf && image);
        await installConsentedRequirements(page, ['windowsml-ocr', 'ollama-runtime'], installationOrder);
        await installSelectedModel(page);
        await waitForCaptureReady(page);
        for (const input of [pdf, image] as const) {
          const injected = await injectModelSmokeFixture(page, input.kind);
          await startInjectedCapture(page, injected.documentId);
          summaries.push(await assertVisibleCapture(
            page,
            input,
            expected,
            injected.documentId,
            injected.startedAt,
          ));
        }
      } else {
        // Audio-only skips OCR capture, but the packaged Workbench keeps the
        // source-import surface locked until its OCR runtime prerequisite is
        // installed. Install that prerequisite without exercising its engine.
        await installConsentedRequirements(page, ['windowsml-ocr', 'ollama-runtime'], installationOrder);
        await installSelectedModel(page);
      }
      const injectedAudio = await injectModelSmokeFixture(
        page,
        audio.kind,
        { waitForCaptureReady: !audioOnly },
      );
      activeDocumentId = injectedAudio.documentId;
      // The keyed import bypasses only the native picker, so it cannot exercise
      // the renderer callback that reveals the optional Whisper setup row. Keep
      // consent on the existing authenticated Tauri/runtime installation path.
      await installConsentedRequirementThroughTauri(page, 'whisper-primary', {
        waitForVisibleRequirement: !audioOnly,
      });
      if (audioOnly) {
        // Audio-only bypasses the optional setup row, but the first runtime
        // requirements read also warms the installed engine verification
        // cache before capture starts. Without this bounded readiness wait,
        // the first capture performs the multi-gigabyte cold verification
        // while remaining indistinguishable from a stuck extraction.
        await waitForRuntimeRequirementsReady(page, ['whisper-primary']);
      }
      installationOrder.push('whisper-primary');
      if (!audioOnly && (installationOrder.indexOf('windowsml-ocr') < 0
        || installationOrder.indexOf('whisper-primary') < 0
        || installationOrder.indexOf('windowsml-ocr') > installationOrder.indexOf('whisper-primary'))) {
        throw new Error('Consented model installation did not complete OCR before Whisper.');
      }
      await startInjectedCapture(page, injectedAudio.documentId);
      summaries.push(await assertVisibleCapture(
        page,
        audio,
        expected,
        injectedAudio.documentId,
        injectedAudio.startedAt,
      ));
    }
    cleanupVerified = true;
  } catch (error) {
    const backendCaptureState = page
      ? await collectSafeBackendCaptureState(page, activeDocumentId).catch(() => undefined)
      : undefined;
    const uiStateRecords = page
      ? await collectSafeUiState(page).catch(() => [])
      : [];
    throw new Error(safeSmokeFailureMessage(error, workerMirror?.requests() ?? 0, uiStateRecords, backendCaptureState));
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
    await waitForPortReleased(cdpPort)
      .then(() => { cdpPortReleased = true; })
      .catch(() => { cleanupVerified = false; });
    if (workerMirror) {
      await workerMirror.close();
      await waitForPortReleased(workerMirror.port)
        .then(() => { workerMirrorReleased = true; })
        .catch(() => { cleanupVerified = false; });
    }
    await rm(runRoot, { recursive: true, force: true }).catch(() => { cleanupVerified = false; });
  }
  if (!cdpPortReleased) throw new Error('Owned WebView2 CDP listener remained bound after cleanup.');
  const minimumWorkerMirrorRequests = installationOnly || audioOnly ? 1 : 2;
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
    evidenceKind: 'real-model-enabled-tauri-ui-smoke',
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
    rawVisible: true,
    resultVisible: true,
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
  process.stdout.write(`Real model-enabled Tauri UI smoke report: ${relative(workspaceRoot, evidencePath)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
