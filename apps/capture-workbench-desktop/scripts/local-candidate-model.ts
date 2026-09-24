import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';

import {
  readVerifiedLocalCandidateCatalog,
  type StartLocalCandidateWorkerMirrorOptions,
} from './local-candidate-worker-mirror.ts';
import { openFilesystemAuthority, type FilesystemAuthority } from './filesystem-authority.ts';

const LOCAL_MODEL_RUNTIME_VERSION = '0.4.2';
const LOCAL_MODEL_ENTRY_POINT = 'model';
const LOCAL_MODEL_FILE_COUNT = 10;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_FILE_PATHS = new Set(['transport-manifest.json']);

export interface LocalCandidateModelFileDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LocalCandidateModelDescriptor {
  readonly artifactVersion: string;
  readonly entryCount: number;
  readonly entryPoint: string;
  readonly extractedBytes: number;
  readonly files: readonly LocalCandidateModelFileDescriptor[];
  readonly manifestSha256: string;
  readonly sourceLockSha256: string;
}

export interface VerifyLocalCandidateModelOptions {
  /** Candidate root is supplied explicitly by the acceptance caller. */
  readonly candidateRoot: string;
  /** Candidate identity is supplied explicitly by the acceptance caller. */
  readonly candidateId: string;
  /** Explicit model requirement selected by the caller. */
  readonly requirementId: StartLocalCandidateWorkerMirrorOptions['requirementId'];
  /** Explicit local opt-in is enforced by the acceptance caller before this seam. */
  readonly modelRoot: string;
}

export interface LocalCandidateModelIdentity {
  readonly policy: 'local-package-tiered';
  readonly candidateId: string;
  readonly catalogSha256: string;
  readonly modelManifestSha256: string;
  readonly sourceLockSha256: string;
  readonly modelFileCount: number;
  readonly modelExtractedBytes: number;
  readonly verifiedFileCount: number;
}

interface RootEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly isDirectory: boolean;
}

interface FileDigest {
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Verifies one explicit local model root against the catalog and candidate
 * manifest selected by the caller. Candidate identity and catalog inventory
 * validation are delegated to the existing worker-candidate seam. The model
 * root is read only; no control manifest is opened and no path or file content
 * is returned in the identity or errors.
 */
export async function verifyLocalCandidateModel(
  options: VerifyLocalCandidateModelOptions,
): Promise<LocalCandidateModelIdentity> {
  const verifiedCatalog = await readVerifiedLocalCandidateCatalog({
    candidateRoot: options.candidateRoot,
    candidateId: options.candidateId,
    requirementId: options.requirementId,
  });
  const descriptor = parseLocalCandidateModelDescriptor(
    verifiedCatalog.requirement.modelFiles,
  );
  const modelAuthority = await openFilesystemAuthority(
    options.modelRoot,
    undefined,
    'Local candidate model root',
  );
  const entries = await collectRootEntries(modelAuthority);
  const files = entries.filter((entry) => !entry.isDirectory);
  const directories = entries.filter((entry) => entry.isDirectory);
  const expectedPaths = new Set(descriptor.files.map((file) => file.path));
  const actualFiles = new Map(files.map((entry) => [entry.relativePath, entry]));
  const missing = descriptor.files.filter((file) => !actualFiles.has(file.path));
  if (missing.length > 0) {
    throw new Error('Local candidate model files are missing.');
  }

  const extraFiles = files.filter((entry) => !expectedPaths.has(entry.relativePath));
  if (extraFiles.some((entry) => !CONTROL_FILE_PATHS.has(entry.relativePath))) {
    throw new Error('Local candidate model root contains unexpected files.');
  }
  const expectedDirectories = expectedParentDirectories(expectedPaths);
  if (directories.some((entry) => !expectedDirectories.has(entry.relativePath))) {
    throw new Error('Local candidate model root contains unexpected directories.');
  }

  let actualBytes = 0;
  let verifiedFileCount = 0;
  for (const file of descriptor.files) {
    const entry = actualFiles.get(file.path);
    if (!entry || entry.isDirectory) {
      throw new Error('Local candidate model file is not regular.');
    }
    const digest = await digestFile(entry.path);
    if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) {
      throw new Error('Local candidate model file identity does not match the catalog.');
    }
    actualBytes += digest.bytes;
    verifiedFileCount += 1;
  }
  if (actualBytes !== descriptor.extractedBytes) {
    throw new Error('Local candidate model byte count does not match the catalog.');
  }

  return {
    policy: 'local-package-tiered',
    candidateId: options.candidateId,
    catalogSha256: verifiedCatalog.catalogSha256,
    modelManifestSha256: descriptor.manifestSha256,
    sourceLockSha256: descriptor.sourceLockSha256,
    modelFileCount: descriptor.entryCount,
    modelExtractedBytes: descriptor.extractedBytes,
    verifiedFileCount,
  };
}

/**
 * Parses the model delivery portion of a candidate catalog. The worker mirror
 * calls this while it has already authenticated the candidate manifest and
 * catalog artifact, so this parser never discovers a candidate on its own.
 */
export function parseLocalCandidateModelDescriptor(
  value: unknown,
): LocalCandidateModelDescriptor {
  if (!isRecord(value)) {
    throw new Error('Local candidate model descriptor is invalid.');
  }
  const filesValue = value.files;
  if (!Array.isArray(filesValue)) {
    throw new Error('Local candidate model descriptor files are invalid.');
  }
  const files = filesValue.map((file) => {
    if (!isRecord(file)) {
      throw new Error('Local candidate model descriptor file is invalid.');
    }
    return {
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    } as LocalCandidateModelFileDescriptor;
  });
  const descriptor = {
    artifactVersion: value.artifactVersion,
    entryCount: value.entryCount,
    entryPoint: value.entryPoint,
    extractedBytes: value.extractedBytes,
    files,
    manifestSha256: value.manifestSha256,
    sourceLockSha256: value.sourceLockSha256,
  } as LocalCandidateModelDescriptor;
  validateDescriptor(descriptor);
  const modelManifest = {
    artifactVersion: descriptor.artifactVersion,
    entryPoint: descriptor.entryPoint,
    files: filesValue,
    manifestVersion: '1',
  };
  if (sha256Bytes(canonicalJson(modelManifest)) !== descriptor.manifestSha256) {
    throw new Error('Local candidate model manifest SHA-256 is invalid.');
  }
  return descriptor;
}

function validateIdentity(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) {
    throw new Error(`Local candidate model ${label} is invalid.`);
  }
}

function validateDescriptor(
  descriptor: LocalCandidateModelDescriptor,
): LocalCandidateModelDescriptor {
  if (
    descriptor.artifactVersion !== LOCAL_MODEL_RUNTIME_VERSION ||
    descriptor.entryPoint !== LOCAL_MODEL_ENTRY_POINT ||
    descriptor.entryCount !== LOCAL_MODEL_FILE_COUNT ||
    descriptor.files.length !== LOCAL_MODEL_FILE_COUNT ||
    !Number.isSafeInteger(descriptor.extractedBytes) ||
    descriptor.extractedBytes <= 0
  ) {
    throw new Error('Local candidate model descriptor is invalid.');
  }
  validateIdentity(descriptor.manifestSha256, 'model manifest SHA-256');
  validateIdentity(descriptor.sourceLockSha256, 'source-lock SHA-256');
  const paths = new Set<string>();
  let descriptorBytes = 0;
  for (const file of descriptor.files) {
    if (
      !isSafeRelativePath(file.path) ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !DIGEST_PATTERN.test(file.sha256)
    ) {
      throw new Error('Local candidate model descriptor file is invalid.');
    }
    paths.add(file.path);
    descriptorBytes += file.bytes;
  }
  if (descriptorBytes !== descriptor.extractedBytes) {
    throw new Error('Local candidate model descriptor byte count is invalid.');
  }
  return descriptor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, 'utf8');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

async function collectRootEntries(
  authority: FilesystemAuthority,
): Promise<readonly RootEntry[]> {
  const result: RootEntry[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new Error('Local candidate model root could not be enumerated.');
    }
    for (const child of children) {
      const path = authority.child(
        join(directory, child.name),
        'Local candidate model entry',
      );
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      if (child.isSymbolicLink()) {
        throw new Error('Local candidate model root contains a link.');
      }
      if (child.isDirectory()) {
        const canonical = await authority.resolveDirectory(
          path,
          'Local candidate model directory',
        );
        result.push({ path: canonical, relativePath, isDirectory: true });
        await visit(path, relativePath);
      } else if (child.isFile()) {
        const canonical = await authority.resolveFile(
          path,
          'Local candidate model file',
        );
        result.push({ path: canonical, relativePath, isDirectory: false });
      } else {
        throw new Error('Local candidate model root contains a link or non-regular entry.');
      }
    }
  }
  await visit(authority.canonicalRoot, '');
  return result;
}

function expectedParentDirectories(
  paths: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      result.add(parts.slice(0, index).join('/'));
    }
  }
  return result;
}

function digestFile(path: string): Promise<FileDigest> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', () => reject(new Error('Local candidate model file could not be read.')));
    stream.once('end', () => resolvePromise({ bytes, sha256: hash.digest('hex') }));
  });
}
