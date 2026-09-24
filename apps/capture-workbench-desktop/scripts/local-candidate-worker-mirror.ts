import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  readFile,
  stat,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { basename, join } from 'node:path';

import {
  openFilesystemAuthority,
  type FilesystemAuthority,
} from './filesystem-authority.ts';

const LOCAL_CANDIDATE_RUNTIME_VERSION = '0.4.2';
const CANDIDATE_MANIFEST_PATH = 'candidate-manifest.json';
const CATALOG_PATH = 'runtime/capture-engine-catalog.json';
const WORKER_ENTRY_POINT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const CANDIDATE_ARTIFACT_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface StartLocalCandidateWorkerMirrorOptions {
  readonly candidateRoot: string;
  readonly candidateId: string;
  readonly requirementId: 'windowsml-ocr';
}

export interface LocalCandidateWorkerMirrorIdentity {
  readonly policy: 'local-package-tiered';
  readonly candidateKind: 'runtime';
  readonly candidateId: string;
  readonly runtimeVersion: string;
  readonly requirementId: 'windowsml-ocr';
  readonly archiveFileName: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly filesManifestFileName: string;
  readonly filesManifestBytes: number;
  readonly filesManifestSha256: string;
  readonly workerExecutableFileName: string;
  readonly workerExecutableBytes: number;
  readonly workerExecutableSha256: string;
}

export interface LocalCandidateWorkerMirror {
  readonly baseUrl: string;
  readonly requests: number;
  readonly identity: LocalCandidateWorkerMirrorIdentity;
  close(): Promise<void>;
}

export interface VerifiedLocalCandidateCatalog {
  readonly candidateId: string;
  readonly catalogSha256: string;
  readonly requirement: Readonly<Record<string, unknown>>;
}

interface CandidateArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface WorkerDescriptor {
  readonly arch: string;
  readonly artifactVersion: string;
  readonly bytes: number;
  readonly entryPoint: string;
  readonly extractedBytes: number;
  readonly fileName: string;
  readonly filesManifestSha256: string;
  readonly platform: string;
  readonly requirementId: string;
  readonly role: string;
  readonly sha256: string;
  readonly workerProtocolVersion: string;
}

interface VerifiedWorkerArchive {
  readonly archivePath: string;
  readonly descriptor: WorkerDescriptor;
  readonly filesManifestPath: string;
  readonly filesManifestEntry: CandidateArtifact;
  readonly workerExecutableBytes: number;
  readonly workerExecutableSha256: string;
}

/**
 * Resolves and serves exactly one OCR worker archive from one immutable local
 * runtime candidate.  Callers provide candidate identity, never an archive
 * path or digest; all catalog, manifest, file, and HTTP policy stays here.
 */
export async function startLocalCandidateWorkerMirror(
  options: StartLocalCandidateWorkerMirrorOptions,
): Promise<LocalCandidateWorkerMirror> {
  const candidate = await verifyCandidateWorker(options);
  let requestCount = 0;
  const sockets = new Set<net.Socket>();
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url === undefined) {
      response.writeHead(405).end();
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url, 'http://127.0.0.1');
    } catch {
      response.writeHead(404).end();
      return;
    }
    const expectedPath = `/${encodeURIComponent(candidate.descriptor.fileName)}`;
    if (
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.pathname !== expectedPath
    ) {
      response.writeHead(404).end();
      return;
    }

    requestCount += 1;
    response.writeHead(200, {
      'Content-Length': candidate.descriptor.bytes,
      'Content-Type': 'application/zip',
      Connection: 'close',
    });
    const stream = createReadStream(candidate.archivePath);
    stream.once('error', () => response.destroy());
    response.once('close', () => stream.destroy());
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
  const port = typeof address === 'object' && address !== null
    ? address.port
    : undefined;
  if (!port) {
    server.close();
    throw new Error('Local candidate worker mirror did not expose a loopback port.');
  }

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return requestCount;
    },
    identity: {
      policy: 'local-package-tiered',
      candidateKind: 'runtime',
      candidateId: options.candidateId,
      runtimeVersion: LOCAL_CANDIDATE_RUNTIME_VERSION,
      requirementId: options.requirementId,
      archiveFileName: candidate.descriptor.fileName,
      archiveBytes: candidate.descriptor.bytes,
      archiveSha256: candidate.descriptor.sha256,
      filesManifestFileName: basename(candidate.filesManifestPath),
      filesManifestBytes: candidate.filesManifestEntry.bytes,
      filesManifestSha256: candidate.descriptor.filesManifestSha256,
      workerExecutableFileName: candidate.descriptor.entryPoint,
      workerExecutableBytes: candidate.workerExecutableBytes,
      workerExecutableSha256: candidate.workerExecutableSha256,
    },
    close: () => {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolvePromise) => {
        for (const socket of sockets) socket.destroy();
        server.closeIdleConnections();
        server.closeAllConnections();
        server.close(() => resolvePromise());
      });
      return closePromise;
    },
  };
}

async function verifyCandidateWorker(
  options: StartLocalCandidateWorkerMirrorOptions,
): Promise<VerifiedWorkerArchive> {
  const verifiedCatalog = await verifyCandidateCatalog(options);
  const { artifacts, candidateAuthority, candidateRoot, requirement } = verifiedCatalog;
  const requirementArtifacts = requirement.artifacts;
  if (!Array.isArray(requirementArtifacts)) {
    throw new Error('Runtime candidate OCR worker descriptors are invalid.');
  }
  const descriptors = requirementArtifacts
    .map((value) => parseJsonRecord(value, 'Runtime candidate OCR worker descriptor'))
    .filter((value) => value.role === 'worker');
  if (descriptors.length !== 1 || requirementArtifacts.length !== 1) {
    throw new Error('Runtime candidate must contain exactly one OCR worker descriptor.');
  }
  const descriptor = parseWorkerDescriptor(descriptors[0], options.requirementId);
  const archiveEntry = findUniqueArtifact(
    artifacts,
    `runtime/${descriptor.fileName}`,
    'Runtime candidate OCR worker archive',
  );
  const archivePath = join(candidateRoot, 'runtime', descriptor.fileName);
  const archiveDigest = await digestCandidateArtifact(
    candidateAuthority,
    archivePath,
    archiveEntry,
    'Runtime candidate OCR worker archive',
  );
  if (
    archiveDigest.bytes !== descriptor.bytes ||
    archiveDigest.sha256 !== descriptor.sha256
  ) {
    throw new Error('Runtime candidate OCR worker archive does not match its catalog descriptor.');
  }

  const filesManifestFileName = `${descriptor.fileName.slice(0, -'.zip'.length)}-files.json`;
  const filesManifestEntry = findUniqueArtifact(
    artifacts,
    `runtime/${filesManifestFileName}`,
    'Runtime candidate OCR worker files manifest',
  );
  const filesManifestPath = join(candidateRoot, 'runtime', filesManifestFileName);
  const filesManifestBytes = await readCandidateArtifact(
    candidateAuthority,
    filesManifestPath,
    filesManifestEntry,
    'Runtime candidate OCR worker files manifest',
  );
  const filesManifestSha256 = sha256Bytes(filesManifestBytes);
  if (filesManifestSha256 !== descriptor.filesManifestSha256) {
    throw new Error('Runtime candidate OCR worker files manifest does not match its catalog descriptor.');
  }
  const filesManifest = parseJsonRecord(
    filesManifestBytes,
    'Runtime candidate OCR worker files manifest',
  );
  assertExactKeys(
    filesManifest,
    ['files', 'manifestVersion'],
    'Runtime candidate OCR worker files manifest',
  );
  if (filesManifest.manifestVersion !== '1' || !Array.isArray(filesManifest.files)) {
    throw new Error('Runtime candidate OCR worker files manifest is invalid.');
  }
  const fileEntries = filesManifest.files.map((value) =>
    parseFilesManifestEntry(value),
  );
  if (new Set(fileEntries.map((entry) => entry.path)).size !== fileEntries.length) {
    throw new Error('Runtime candidate OCR worker files manifest contains duplicate entries.');
  }
  const workerEntries = fileEntries.filter(
    (entry) => entry.path === descriptor.entryPoint,
  );
  if (workerEntries.length !== 1) {
    throw new Error('Runtime candidate OCR worker files manifest must contain exactly one executable entry.');
  }

  return {
    archivePath,
    descriptor,
    filesManifestPath,
    filesManifestEntry,
    workerExecutableBytes: workerEntries[0].bytes,
    workerExecutableSha256: workerEntries[0].sha256,
  };
}

/**
 * Verifies one caller-selected candidate root through its manifest and catalog
 * inventory, without discovering candidate artifacts or opening any transport
 * control manifest.  The returned data is safe identity plus the in-memory
 * catalog needed by the model-source verifier; no path is returned.
 */
export async function readVerifiedLocalCandidateCatalog(
  options: StartLocalCandidateWorkerMirrorOptions,
): Promise<VerifiedLocalCandidateCatalog> {
  const verified = await verifyCandidateCatalog(options);
  return {
    candidateId: options.candidateId,
    catalogSha256: verified.catalogSha256,
    requirement: verified.requirement,
  };
}

interface VerifiedCandidateCatalog extends VerifiedLocalCandidateCatalog {
  readonly candidateRoot: string;
  readonly candidateAuthority: FilesystemAuthority;
  readonly catalog: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly CandidateArtifact[];
}

async function verifyCandidateCatalog(
  options: StartLocalCandidateWorkerMirrorOptions,
): Promise<VerifiedCandidateCatalog> {
  if (options.requirementId !== 'windowsml-ocr') {
    throw new Error('Local candidate worker mirror only supports windowsml-ocr.');
  }
  if (!DIGEST_PATTERN.test(options.candidateId)) {
    throw new Error('Local candidate worker mirror candidate ID is invalid.');
  }
  const candidateAuthority = await openFilesystemAuthority(
    options.candidateRoot,
    undefined,
    'Runtime candidate root',
  );
  const candidateRoot = candidateAuthority.canonicalRoot;
  const candidateManifestPath = join(candidateRoot, CANDIDATE_MANIFEST_PATH);
  const candidateManifestBytes = await readCandidateFile(
    candidateAuthority,
    candidateManifestPath,
    'Runtime candidate manifest',
  );
  const candidateManifest = parseJsonRecord(
    candidateManifestBytes,
    'Runtime candidate manifest',
  );
  assertExactKeys(
    candidateManifest,
    [
      'artifacts',
      'candidateId',
      'candidateKind',
      'contractSetSha256',
      'packageCandidateId',
      'producerRunId',
      'releaseMode',
      'releaseVersion',
      'schemaVersion',
      'sourceCommit',
      'toolchains',
    ],
    'Runtime candidate manifest',
  );
  if (
    candidateManifest.schemaVersion !== '1' ||
    candidateManifest.candidateKind !== 'runtime' ||
    candidateManifest.releaseVersion !== LOCAL_CANDIDATE_RUNTIME_VERSION ||
    candidateManifest.candidateId !== options.candidateId
  ) {
    throw new Error('Runtime candidate manifest identity is invalid.');
  }
  const candidateManifestBase = { ...candidateManifest };
  delete candidateManifestBase.candidateId;
  if (sha256Bytes(Buffer.from(JSON.stringify(candidateManifestBase))) !== options.candidateId) {
    throw new Error('Runtime candidate ID is not bound to its manifest.');
  }

  const artifacts = parseCandidateArtifacts(candidateManifest.artifacts);
  const catalogEntry = findUniqueArtifact(artifacts, CATALOG_PATH, 'Runtime candidate catalog');
  const catalogPath = join(candidateRoot, 'runtime', 'capture-engine-catalog.json');
  const catalogBytes = await readCandidateArtifact(
    candidateAuthority,
    catalogPath,
    catalogEntry,
    'Runtime candidate catalog',
  );
  const catalog = parseJsonRecord(catalogBytes, 'Runtime candidate catalog');
  if (
    catalog.catalogVersion !== '2' ||
    catalog.runtimeVersion !== LOCAL_CANDIDATE_RUNTIME_VERSION
  ) {
    throw new Error('Runtime candidate catalog version is invalid.');
  }
  if (!Array.isArray(catalog.requirements)) {
    throw new Error('Runtime candidate catalog requirements are invalid.');
  }
  const requirements = catalog.requirements.map((value) =>
    parseJsonRecord(value, 'Runtime candidate catalog requirement'),
  );
  const matchingRequirements = requirements.filter(
    (requirement) => requirement.requirementId === options.requirementId,
  );
  if (matchingRequirements.length !== 1) {
    throw new Error('Runtime candidate catalog must contain exactly one windowsml-ocr requirement.');
  }
  return {
    candidateRoot,
    candidateAuthority,
    candidateId: options.candidateId,
    catalogSha256: sha256Bytes(catalogBytes),
    catalog,
    requirement: matchingRequirements[0],
    artifacts,
  };
}

async function readCandidateFile(
  authority: FilesystemAuthority,
  path: string,
  label: string,
): Promise<Buffer> {
  const actual = await requireCandidateFile(authority, path, label);
  return readFile(actual).catch(() => {
    throw new Error(`${label} could not be read.`);
  });
}

async function readCandidateArtifact(
  authority: FilesystemAuthority,
  path: string,
  artifact: CandidateArtifact,
  label: string,
): Promise<Buffer> {
  const bytes = await readCandidateFile(authority, path, label);
  if (bytes.length !== artifact.bytes || sha256Bytes(bytes) !== artifact.sha256) {
    throw new Error(`${label} bytes do not match the candidate manifest.`);
  }
  return bytes;
}

interface CandidateFileDigest {
  readonly bytes: number;
  readonly sha256: string;
}

async function digestCandidateArtifact(
  authority: FilesystemAuthority,
  path: string,
  artifact: CandidateArtifact,
  label: string,
): Promise<CandidateFileDigest> {
  const actual = await requireCandidateFile(authority, path, label);
  const metadata = await stat(actual).catch(() => undefined);
  if (!metadata?.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  const digest = await digestFile(actual);
  if (
    digest.bytes !== metadata.size ||
    digest.bytes !== artifact.bytes ||
    digest.sha256 !== artifact.sha256
  ) {
    throw new Error(`${label} bytes do not match the candidate manifest.`);
  }
  return digest;
}

function digestFile(path: string): Promise<CandidateFileDigest> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', () => reject(new Error('Runtime candidate artifact could not be read.')));
    stream.once('end', () => resolvePromise({ bytes, sha256: hash.digest('hex') }));
  });
}

async function requireCandidateFile(
  authority: FilesystemAuthority,
  path: string,
  label: string,
): Promise<string> {
  return authority.resolveFile(path, label);
}

function parseCandidateArtifacts(value: unknown): CandidateArtifact[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Runtime candidate artifacts are invalid.');
  }
  const paths = new Set<string>();
  return value.map((item) => {
    const record = parseJsonRecord(item, 'Runtime candidate artifact');
    assertExactKeys(record, ['bytes', 'path', 'sha256'], 'Runtime candidate artifact');
    const path = record.path;
    const bytes = record.bytes;
    const sha256 = record.sha256;
    if (
      typeof path !== 'string' ||
      !isSafeRelativePath(path) ||
      paths.has(path) ||
      !Number.isSafeInteger(bytes) ||
      Number(bytes) <= 0 ||
      typeof sha256 !== 'string' ||
      !DIGEST_PATTERN.test(sha256)
    ) {
      throw new Error('Runtime candidate artifact is invalid or duplicated.');
    }
    paths.add(path);
    return { path, bytes: Number(bytes), sha256 };
  });
}

function findUniqueArtifact(
  artifacts: readonly CandidateArtifact[],
  path: string,
  label: string,
): CandidateArtifact {
  const matches = artifacts.filter((artifact) => artifact.path === path);
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one candidate artifact.`);
  }
  return matches[0];
}

function parseWorkerDescriptor(
  value: Record<string, unknown>,
  requirementId: string,
): WorkerDescriptor {
  const descriptor = {
    arch: value.arch,
    artifactVersion: value.artifactVersion,
    bytes: value.bytes,
    entryPoint: value.entryPoint,
    extractedBytes: value.extractedBytes,
    fileName: value.fileName,
    filesManifestSha256: value.filesManifestSha256,
    platform: value.platform,
    requirementId: value.requirementId,
    role: value.role,
    sha256: value.sha256,
    workerProtocolVersion: value.workerProtocolVersion,
  };
  assertExactKeys(
    value,
    [
      'arch',
      'artifactVersion',
      'bytes',
      'entryPoint',
      'extractedBytes',
      'fileName',
      'filesManifestSha256',
      'platform',
      'requirementId',
      'role',
      'sha256',
      'url',
      'workerProtocolVersion',
    ],
    'Runtime candidate OCR worker descriptor',
  );
  const safeBasename = (value: unknown): value is string =>
    typeof value === 'string' &&
    WORKER_ENTRY_POINT_PATTERN.test(value) &&
    value !== '.' &&
    value !== '..';
  if (
    descriptor.arch !== 'x86_64' ||
    descriptor.artifactVersion !== LOCAL_CANDIDATE_RUNTIME_VERSION ||
    !Number.isSafeInteger(descriptor.bytes) ||
    Number(descriptor.bytes) <= 0 ||
    typeof descriptor.entryPoint !== 'string' ||
    !safeBasename(descriptor.entryPoint) ||
    !Number.isSafeInteger(descriptor.extractedBytes) ||
    Number(descriptor.extractedBytes) <= 0 ||
    typeof descriptor.fileName !== 'string' ||
    !safeBasename(descriptor.fileName) ||
    !descriptor.fileName.endsWith('.zip') ||
    typeof descriptor.filesManifestSha256 !== 'string' ||
    !DIGEST_PATTERN.test(descriptor.filesManifestSha256) ||
    descriptor.platform !== 'windows' ||
    descriptor.requirementId !== requirementId ||
    descriptor.role !== 'worker' ||
    typeof value.url !== 'string' ||
    typeof descriptor.sha256 !== 'string' ||
    !DIGEST_PATTERN.test(descriptor.sha256) ||
    descriptor.workerProtocolVersion !== '1'
  ) {
    throw new Error('Runtime candidate OCR worker descriptor is invalid.');
  }
  return descriptor as WorkerDescriptor;
}

function parseFilesManifestEntry(value: unknown): {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
} {
  // Member path safety is owned by the runtime installer before extraction;
  // this mirror treats non-selected paths as digest-bound evidence strings.
  const record = parseJsonRecord(value, 'Runtime candidate OCR worker files manifest entry');
  assertExactKeys(
    record,
    ['bytes', 'path', 'sha256'],
    'Runtime candidate OCR worker files manifest entry',
  );
  const path = record.path;
  const bytes = record.bytes;
  const sha256 = record.sha256;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !Number.isSafeInteger(bytes) ||
    Number(bytes) < 0 ||
    typeof sha256 !== 'string' ||
    !DIGEST_PATTERN.test(sha256)
  ) {
    throw new Error('Runtime candidate OCR worker files manifest entry is invalid.');
  }
  return { path, bytes: Number(bytes), sha256 };
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

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new Error(`${label} fields are not canonical.`);
  }
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isSafeRelativePath(value: string): boolean {
  return CANDIDATE_ARTIFACT_PATH_PATTERN.test(value)
    && !value.split('/').some((segment) => segment === '.' || segment === '..');
}
