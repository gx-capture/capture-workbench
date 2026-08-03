import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

export const REAL_MODEL_RELEASE_VERSION = '0.3.9';
export const REAL_MODEL_CATALOG_VERSION = '2';
export const REAL_MODEL_DEPENDENCY_ORDER_SCOPE = 'source-lock-model-requirements-only';
export const REAL_MODEL_REQUIREMENT_ORDER = [
  'windowsml-ocr',
  'whisper-primary',
] as const;
export const REAL_MODEL_RUNTIME_READY_TIMEOUT_MS = 3 * 60_000;
export const REAL_MODEL_INSTALL_TIMEOUT_MS = 90 * 60_000;
export const REAL_MODEL_CAPTURE_TIMEOUT_MS = 30_000;
export const REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS = 60 * 60_000;
export const REAL_MODEL_RESULT_TIMEOUT_MS = 60 * 60_000;

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
const projectPdfPath = join(
  workspaceRoot,
  'packages',
  'capture-runtime',
  'model-sources',
  'commit-a',
  'fixtures',
  'ocr-scanned.pdf',
);
const projectImagePath = join(
  workspaceRoot,
  'packages',
  'capture-runtime',
  'model-sources',
  'commit-a',
  'fixtures',
  'ocr-reference.png',
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
type MediaKind = 'pdf' | 'image' | 'audio';

interface MediaInput {
  readonly kind: MediaKind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

interface ExpectedProvenance {
  readonly sourceLockSha256: string;
  readonly catalogSha256: string;
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
  readonly releaseGateSatisfied: true;
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
    throw new Error('Model source lock schema must be v2 for the 0.3.9 gate.');
  }
  if (lock.releaseVersion !== REAL_MODEL_RELEASE_VERSION) {
    throw new Error('Model source lock release version is not 0.3.9.');
  }
  const approval = asObject(lock.approval, 'Model source lock approval');
  if (approval.status !== 'approved' || !Array.isArray(approval.blockers) || approval.blockers.length !== 0) {
    throw new Error('Model source lock must be approved with no blockers.');
  }
  if (catalogObject.catalogVersion !== REAL_MODEL_CATALOG_VERSION) {
    throw new Error('Generated model catalog schema must be v2.');
  }
  if (catalogObject.runtimeVersion !== REAL_MODEL_RELEASE_VERSION) {
    throw new Error('Generated model catalog runtime version is not 0.3.9.');
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
  };
}

async function prepareInputs(expected: ExpectedProvenance): Promise<readonly [MediaInput, MediaInput, MediaInput]> {
  await mkdir(runRoot, { recursive: true });
  const audioInput = process.env.CAPTURE_REAL_MEDIA_MODEL_AUDIO?.trim();
  if (!audioInput) throw new Error('CAPTURE_REAL_MEDIA_MODEL_AUDIO is required for the private runner audio fixture.');
  return [
    await regularInput(projectPdfPath, 'project OCR PDF fixture', 'pdf', join(runRoot, safeInputName('pdf')), expected.ocrPdfSha256, expected.ocrPdfBytes),
    await regularInput(projectImagePath, 'project OCR image fixture', 'image', join(runRoot, safeInputName('image')), expected.ocrImageSha256, expected.ocrImageBytes),
    await regularInput(audioInput, 'CAPTURE_REAL_MEDIA_MODEL_AUDIO', 'audio', join(runRoot, safeInputName('audio')), expected.whisperFixtureSha256, expected.whisperFixtureBytes),
  ];
}

interface CandidateWorkerMirror {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

async function startCandidateWorkerMirror(expected: ExpectedProvenance): Promise<CandidateWorkerMirror> {
  const archives = new Map<string, { path: string; bytes: number }>();
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
    archives.set(archive.fileName, { path: archivePath, bytes: archive.bytes });
  }
  let requestCount = 0;
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

async function nativeOpenDialog(filePath: string): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CaptureDialog {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr handle, string text);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  $dialog = [CaptureDialog]::FindWindow('#32770', $null)
  if ($dialog -ne [IntPtr]::Zero) {
    $edit = [CaptureDialog]::FindWindowEx($dialog, [IntPtr]::Zero, 'Edit', $null)
    if ($edit -ne [IntPtr]::Zero -and [CaptureDialog]::SetWindowText($edit, $env:CAPTURE_SMOKE_DIALOG_FILE)) {
      $button = [CaptureDialog]::FindWindowEx($dialog, [IntPtr]::Zero, 'Button', '&Open')
      if ($button -eq [IntPtr]::Zero) { $button = [CaptureDialog]::FindWindowEx($dialog, [IntPtr]::Zero, 'Button', 'Open') }
      if ($button -ne [IntPtr]::Zero) {
        [CaptureDialog]::SendMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 100
}
exit 1
`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: {
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: process.env.PATH || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      CAPTURE_SMOKE_DIALOG_FILE: filePath,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const result = await new Promise<{ code: number | null }>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise({ code }));
  });
  if (result.code !== 0) throw new Error('Native source picker did not accept the prepared fixture.');
}

async function importThroughUi(page: Page, input: MediaInput): Promise<number> {
  const startedAt = Date.now();
  const dialog = nativeOpenDialog(input.path);
  await page.getByTestId('source-import').click();
  await dialog;
  return startedAt;
}

async function requirementStatus(page: Page, requirementId: RequirementId): Promise<string> {
  const row = page.locator(`[data-testid="runtime-requirement"][data-requirement-id="${requirementId}"]`);
  return (await row.getAttribute('data-status')) || (await row.locator('[data-testid="runtime-requirement-status"]').getAttribute('data-status')) || (await row.textContent()) || '';
}

async function installConsentedRequirements(
  page: Page,
  requiredIds: readonly RequirementId[],
  completionOrder: RequirementId[],
): Promise<void> {
  if (requiredIds.length === 0) return;
  const setup = page.getByTestId('runtime-setup');
  await setup.waitFor({ state: 'visible', timeout: REAL_MODEL_RUNTIME_READY_TIMEOUT_MS });
  const install = page.getByTestId('runtime-install');
  const alreadyReady = await Promise.all(requiredIds.map(async (requirementId) =>
    /ready/iu.test(await requirementStatus(page, requirementId))));
  if (!alreadyReady.every(Boolean)) {
    await waitUntil(
      async () => (await install.isVisible().catch(() => false)) || false,
      REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
      'Desktop runtime setup did not expose the consented install action.',
    );
    await install.click();
  }
  const consentedAt = Date.now();
  const completedAt = new Map<RequirementId, number>();
  await waitUntil(
    async () => {
      for (const requirementId of requiredIds) {
        const status = await requirementStatus(page, requirementId);
        if (/ready/iu.test(status) && !completedAt.has(requirementId)) completedAt.set(requirementId, Date.now());
      }
      if (
        completedAt.size !== requiredIds.length
        && Date.now() - consentedAt >= 2_000
        && await install.isVisible().catch(() => false)
        && await install.isEnabled().catch(() => false)
      ) {
        throw new Error('Consented model installation returned to the installable state.');
      }
      return completedAt.size === requiredIds.length || false;
    },
    REAL_MODEL_INSTALL_TIMEOUT_MS,
    `Consented model installation did not complete: ${requiredIds.join(', ')}.`,
  );
  for (const requirementId of requiredIds) {
    if (!completionOrder.includes(requirementId)) completionOrder.push(requirementId);
  }
}

async function waitForCaptureReady(page: Page): Promise<void> {
  const importButton = page.getByTestId('source-import');
  await waitUntil(
    async () => (await importButton.isEnabled().catch(() => false)) || false,
    REAL_MODEL_RUNTIME_READY_TIMEOUT_MS,
    'Desktop capture UI did not become ready after consented installation.',
  );
}

async function waitForDocument(page: Page, fileName: string): Promise<{ id: string; card: ReturnType<Page['locator']> }> {
  const card = page.getByTestId('document-card').filter({ hasText: fileName });
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  const ids = await card.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-document-id')).filter((id): id is string => !!id));
  if (ids.length !== 1 || !/^[a-f0-9]{32}$/u.test(ids[0])) throw new Error('Desktop smoke document card did not expose one UUID.');
  return { id: ids[0], card };
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
  importedAt = Date.now(),
): Promise<MediaSummary> {
  const document = await waitForDocument(page, input.fileName);
  await document.card.click();
  const detail = page.locator(`[data-testid="document-detail"][data-document-id="${document.id}"]`);
  await detail.waitFor({ state: 'visible', timeout: 30_000 });
  const rawSection = detail.getByTestId('document-raw');
  const resultSection = detail.getByTestId('document-result');
  const provenanceSection = detail.getByTestId('document-provenance');
  const rawTimeout = input.kind === 'audio' ? REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS : REAL_MODEL_CAPTURE_TIMEOUT_MS;
  if (input.kind === 'audio') {
    await waitUntil(
      async () => (await document.card.getAttribute('data-status')) === 'completed' || false,
      REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS,
      `Desktop ${input.fileName} capture did not complete.`,
    );
  }
  await waitUntil(
    async () => {
      if (await rawSection.count() !== 1) return false;
      return ((await rawSection.textContent())?.trim() || '') || false;
    },
    rawTimeout,
    `${input.kind} UI raw extraction did not become visible within its bounded timeout.`,
  );
  const extractionDurationMs = Date.now() - importedAt;
  const resultTimeout = REAL_MODEL_RESULT_TIMEOUT_MS;
  await resultSection.waitFor({ state: 'visible', timeout: resultTimeout });
  await provenanceSection.waitFor({ state: 'visible', timeout: resultTimeout });
  const rawText = (await rawSection.textContent())?.trim() || '';
  const resultText = (await resultSection.textContent())?.trim() || '';
  const provenance = (await provenanceSection.textContent())?.trim() || '';
  if (!rawText || !resultText) throw new Error(`${input.kind} UI raw/result data was empty.`);
  const extractionProvenance = detail.getByTestId('document-extraction-provenance');
  await extractionProvenance.waitFor({ state: 'visible', timeout: resultTimeout });
  const expectedEngine = input.kind === 'audio' ? expected.whisperEngine : expected.ocrEngine;
  const expectedModel = input.kind === 'audio' ? expected.whisperModel : expected.ocrModel;
  const expectedDevice = input.kind === 'audio' ? expected.whisperDevice : expected.ocrDevice;
  assert.equal(await extractionProvenance.getAttribute('data-engine'), expectedEngine);
  assert.equal(await extractionProvenance.getAttribute('data-model'), expectedModel);
  assert.equal(await extractionProvenance.getAttribute('data-device'), expectedDevice);
  const extractionDigest = await extractionProvenance.getAttribute('data-digest');
  if (!extractionDigest || !/^sha256:[a-f0-9]{64}$/u.test(extractionDigest)) {
    throw new Error(`${input.kind} UI extraction provenance omitted a bounded engine digest.`);
  }
  if (input.kind !== 'audio' && !rawText.includes(expected.ocrText)) {
    throw new Error(`${input.kind} UI raw text did not contain the lock-selected OCR fixture text.`);
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
  assert.match(provenance, new RegExp(expected.whisperDevice.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  const segmentCount = await assertAudioRawSegments(rawText, rawSection, expected);
  await deleteDocumentThroughUi(page, document.id);
  return {
    sourceKind: input.kind,
    sourceSha256: input.sha256,
    extractionEngine: expected.whisperEngine,
    model: expected.whisperModel,
    device: expected.whisperDevice,
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
    if (segments.length < expected.whisperSegmentMinimum || segments.length > expected.whisperSegmentMaximum) {
      throw new Error('Audio UI raw segment count drifted from the lock-selected fixture bounds.');
    }
    if (normalizedTranscriptDigest(transcript) !== expected.whisperNormalizedOutputSha256) {
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
  if (locators.length < expected.whisperSegmentMinimum || locators.length > expected.whisperSegmentMaximum) {
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
  if (normalizedTranscriptDigest(locators.map((locator) => locator.text)) !== expected.whisperNormalizedOutputSha256) {
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
  assert.equal(report.releaseGateSatisfied, true);
  assert.equal(report.consumerE2e, false);
  assert.equal(report.runtimeVersion, REAL_MODEL_RELEASE_VERSION);
  assert.equal(report.catalogVersion, REAL_MODEL_CATALOG_VERSION);
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

function processTreePids(pid: number): number[] {
  const script = `$root = ${pid}; $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); if (-not ($all | Where-Object { [int]$_.ProcessId -eq $root })) { Write-Output '[]'; exit 0 }; $seen = New-Object System.Collections.Generic.HashSet[int]; $queue = New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue($root); while ($queue.Count -gt 0) { $current = $queue.Dequeue(); if ($seen.Add([int]$current)) { foreach ($item in $all) { if ([int]$item.ParentProcessId -eq [int]$current) { $queue.Enqueue([int]$item.ProcessId) } } } }; ConvertTo-Json -Compress -InputObject @($seen)`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Owned desktop process tree could not be observed.');
  const parsed = JSON.parse(String(result.stdout || '[]')) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const pids = values.filter((value): value is number => Number.isSafeInteger(value) && value > 0);
  return [...new Set(pids)];
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
  assertNoAmbientModelOverrides(process.env as Record<string, string>);
  const expected = await loadReleaseModelContract();
  await firstValueFrom(assertStagedRuntime('release'));
  await rm(smokeRoot, { recursive: true, force: true });
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  let inputs: readonly [MediaInput, MediaInput, MediaInput];
  try {
    inputs = await prepareInputs(expected);
  } catch (error) {
    throw errorWithoutSecrets(error);
  }
  const [pdf, image, audio] = inputs;
  const executable = resolve(process.env.CAPTURE_REAL_MEDIA_MODEL_EXECUTABLE?.trim() || defaultDesktopExecutable);
  let metadata;
  try { metadata = await lstat(executable); } catch { throw new Error('CAPTURE_REAL_MEDIA_MODEL_EXECUTABLE must be a regular packaged Tauri executable.'); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('CAPTURE_REAL_MEDIA_MODEL_EXECUTABLE must be a regular packaged Tauri executable.');
  const cdpPort = await firstValueFrom(reserveLoopbackPort());
  const workerMirror = await startCandidateWorkerMirror(expected);
  await mkdir(appDataRoot, { recursive: true });
  const appEnvironment = buildInstalledAppEnvironment(process.env, {
    root: runRoot,
    appData: appDataRoot,
    localAppData: localAppDataRoot,
    temporary: temporaryRoot,
    webViewData: webViewDataRoot,
  }, cdpPort);
  appEnvironment.CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN = '1';
  appEnvironment.CAPTURE_SMOKE_WORKER_MIRROR_URL = workerMirror.baseUrl;
  appEnvironment.CAPTURE_SMOKE_APP_DATA_ROOT = appDataRoot;
  assertNoAmbientModelOverrides(appEnvironment);
  let app: ReturnType<typeof spawn> | undefined;
  let browser: Browser | undefined;
  const summaries: MediaSummary[] = [];
  const installationOrder: RequirementId[] = [];
  let observedBeforeCleanup: number[] = [];
  let cleanupVerified = false;
  let cdpPortReleased = false;
  let workerMirrorReleased = false;
  try {
    app = spawn(executable, [], { cwd: resolve(executable, '..'), env: appEnvironment, stdio: 'ignore', windowsHide: true });
    browser = await firstValueFrom(connectToInstalledWebView(cdpPort, app));
    const page = await firstValueFrom(installedPage(browser, app));
    await waitUntil(async () => {
      const setup = page.getByTestId('runtime-setup');
      return (await setup.count()) === 1 || false;
    }, REAL_MODEL_RUNTIME_READY_TIMEOUT_MS, 'Desktop runtime setup UI did not load.');
    await installConsentedRequirements(page, ['windowsml-ocr'], installationOrder);
    await waitForCaptureReady(page);
    for (const input of [pdf, image] as const) {
      const importedAt = await importThroughUi(page, input);
      summaries.push(await assertVisibleCapture(page, input, expected, importedAt));
    }
    await importThroughUi(page, audio);
    // Audio is the opt-in dependency in the desktop shell. Importing it makes
    // Whisper installable; the install action remains the only consent path.
    await installConsentedRequirements(page, ['whisper-primary'], installationOrder);
    await waitForCaptureReady(page);
    if (installationOrder.indexOf('windowsml-ocr') < 0
      || installationOrder.indexOf('whisper-primary') < 0
      || installationOrder.indexOf('windowsml-ocr') > installationOrder.indexOf('whisper-primary')) {
      throw new Error('Consented model installation did not complete OCR before Whisper.');
    }
    const audioCard = await waitForDocument(page, audio.fileName);
    await audioCard.card.click();
    const retry = page.locator(`[data-testid="document-retry"][data-document-id="${audioCard.id}"]`);
    if (await retry.count() !== 1) throw new Error('Audio document did not expose the exact UI retry action after Whisper consent.');
    await retry.click();
    summaries.push(await assertVisibleCapture(page, audio, expected));
    if (!app.pid) throw new Error('Real model smoke Tauri process did not expose a PID.');
    observedBeforeCleanup = processTreePids(app.pid);
    if (!observedBeforeCleanup.includes(app.pid) || observedBeforeCleanup.length < 2) {
      throw new Error('Real model smoke did not observe both Tauri and runtime process identities.');
    }
    cleanupVerified = true;
  } catch (error) {
    const safe = errorWithoutSecrets(error);
    throw new Error(`${safe.message} Candidate worker mirror requests: ${workerMirror.requests()}.`);
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
    if (app?.pid) {
      try {
        const remaining = processTreePids(app.pid);
        if (remaining.some((pid) => observedBeforeCleanup.includes(pid))) cleanupVerified = false;
      } catch { cleanupVerified = false; }
    }
    await workerMirror.close();
    await waitForPortReleased(workerMirror.port)
      .then(() => { workerMirrorReleased = true; })
      .catch(() => { cleanupVerified = false; });
  }
  if (!cdpPortReleased) throw new Error('Owned WebView2 CDP listener remained bound after cleanup.');
  if (!workerMirrorReleased || workerMirror.requests() < 2) throw new Error('Candidate worker mirror did not serve both worker archives and release its listener.');
  if (!cleanupVerified) throw new Error('Owned desktop/runtime process cleanup was not verified.');
  await rm(runRoot, { recursive: true, force: true });
  const report: RealMediaModelEvidence = {
    evidenceKind: 'real-model-enabled-tauri-ui-smoke',
    releaseGateSatisfied: true,
    consumerE2e: false,
    runtimeVersion: REAL_MODEL_RELEASE_VERSION,
    catalogVersion: REAL_MODEL_CATALOG_VERSION,
    sourceLockSha256: expected.sourceLockSha256,
    catalogSha256: expected.catalogSha256,
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
