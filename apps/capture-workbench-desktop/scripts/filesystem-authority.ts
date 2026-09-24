import {
  lstat,
  realpath,
} from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export interface FilesystemAuthorityFileStat {
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * The only filesystem effects needed by the authority module. Production uses
 * the Node adapter; tests can inject a real filesystem adapter with a narrow
 * observation seam when a particular reparse observation must be exercised.
 */
export interface FilesystemAuthorityFileAdapter {
  lstat(path: string): Promise<FilesystemAuthorityFileStat>;
  realpath(path: string): Promise<string>;
}

export interface FilesystemAuthority {
  /** The caller spelling, retained only to derive children safely. */
  readonly lexicalRoot: string;
  /** The physical root that owns all accepted descendants. */
  readonly canonicalRoot: string;
  /** Derives a canonical child while enforcing lexical containment. */
  child(path: string, label: string): string;
  /** Resolves an existing regular directory under this authority. */
  resolveDirectory(path: string, label: string): Promise<string>;
  /** Resolves an existing regular file under this authority. */
  resolveFile(path: string, label: string): Promise<string>;
}

export const nodeFilesystemAuthorityAdapter: FilesystemAuthorityFileAdapter = {
  lstat,
  realpath,
};

/**
 * Opens one filesystem authority. A reparse at the supplied leaf is rejected,
 * while a junction in an ancestor above that leaf is represented by the
 * canonical root and therefore remains usable. Every later child resolution
 * must preserve its relative suffix from lexical root to canonical root.
 */
export async function openFilesystemAuthority(
  inputPath: string,
  files: FilesystemAuthorityFileAdapter = nodeFilesystemAuthorityAdapter,
  label = 'Filesystem authority root',
): Promise<FilesystemAuthority> {
  const lexicalRoot = resolve(inputPath);
  const metadata = await readStat(files, lexicalRoot, label);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not resolve through a link.`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a regular directory.`);
  }

  const canonicalRoot = await resolveRealpath(files, lexicalRoot, label);
  const canonicalMetadata = await readStat(files, canonicalRoot, label);
  if (canonicalMetadata.isSymbolicLink()) {
    throw new Error(`${label} must not resolve through a link.`);
  }
  if (!canonicalMetadata.isDirectory()) {
    throw new Error(`${label} must be a regular directory.`);
  }

  const authority: FilesystemAuthority = {
    lexicalRoot,
    canonicalRoot,
    child: (path, childLabel) => {
      const paths = mapAuthorityPath(lexicalRoot, canonicalRoot, path, childLabel);
      return paths.canonicalPath;
    },
    resolveDirectory: (path, childLabel) => resolveExisting(
      lexicalRoot,
      canonicalRoot,
      path,
      childLabel,
      files,
      'directory',
    ),
    resolveFile: (path, childLabel) => resolveExisting(
      lexicalRoot,
      canonicalRoot,
      path,
      childLabel,
      files,
      'file',
    ),
  };

  // This repeats the root's canonical relation through the same public method
  // used by all children, keeping the leaf reparse and suffix checks unified.
  await authority.resolveDirectory(lexicalRoot, label);
  return authority;
}

/**
 * Asserts canonical containment between already-open authorities. The caller
 * still owns lexical path construction; this function proves that the
 * physical child authority remains inside the physical parent authority.
 */
export function assertCanonicalAuthorityContainment(
  parent: FilesystemAuthority,
  child: FilesystemAuthority,
  label: string,
): string {
  if (!isDescendantOrSelf(parent.canonicalRoot, child.canonicalRoot)) {
    throw new Error(`${label} escaped its filesystem authority.`);
  }
  return child.canonicalRoot;
}

async function resolveExisting(
  lexicalRoot: string,
  canonicalRoot: string,
  inputPath: string,
  label: string,
  files: FilesystemAuthorityFileAdapter,
  expectedKind: 'directory' | 'file',
): Promise<string> {
  const { lexicalPath } = mapAuthorityPath(
    lexicalRoot,
    canonicalRoot,
    inputPath,
    label,
  );
  const metadata = await readStat(files, lexicalPath, label);
  if (
    metadata.isSymbolicLink() ||
    (expectedKind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())
  ) {
    throw new Error(`${label} must be a regular ${expectedKind}.`);
  }
  const canonicalPath = await resolveRealpath(files, lexicalPath, label);
  if (!preservesAuthoritySuffix(lexicalRoot, canonicalRoot, lexicalPath, canonicalPath)) {
    throw new Error(`${label} must not resolve through a link.`);
  }
  return canonicalPath;
}

function mapAuthorityPath(
  lexicalRoot: string,
  canonicalRoot: string,
  inputPath: string,
  label: string,
): { readonly lexicalPath: string; readonly canonicalPath: string } {
  const input = resolve(inputPath);
  if (isDescendantOrSelf(lexicalRoot, input)) {
    const suffix = relative(lexicalRoot, input);
    return {
      lexicalPath: input,
      canonicalPath: resolve(canonicalRoot, suffix),
    };
  }
  if (isDescendantOrSelf(canonicalRoot, input)) {
    const suffix = relative(canonicalRoot, input);
    return {
      lexicalPath: resolve(lexicalRoot, suffix),
      canonicalPath: input,
    };
  }
  throw new Error(`${label} escaped its filesystem authority.`);
}

function preservesAuthoritySuffix(
  lexicalRoot: string,
  canonicalRoot: string,
  lexicalPath: string,
  canonicalPath: string,
): boolean {
  if (!isDescendantOrSelf(canonicalRoot, canonicalPath)) return false;
  const lexicalSuffix = relative(lexicalRoot, lexicalPath);
  const canonicalSuffix = relative(canonicalRoot, canonicalPath);
  return normalizeRelative(lexicalSuffix) === normalizeRelative(canonicalSuffix);
}

function isDescendantOrSelf(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !/^[A-Za-z]:/u.test(relativePath)
  );
}

function normalizeRelative(path: string): string {
  return path.replaceAll('/', '\\').toLowerCase();
}

async function readStat(
  files: FilesystemAuthorityFileAdapter,
  path: string,
  label: string,
): Promise<FilesystemAuthorityFileStat> {
  try {
    return await files.lstat(path);
  } catch (error) {
    throw authorityError(`${label} could not be resolved.`, error);
  }
}

async function resolveRealpath(
  files: FilesystemAuthorityFileAdapter,
  path: string,
  label: string,
): Promise<string> {
  try {
    return resolve(await files.realpath(path));
  } catch (error) {
    throw authorityError(`${label} could not be resolved.`, error);
  }
}

function authorityError(message: string, cause: unknown): Error {
  const error = new Error(message);
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string'
  ) {
    Object.assign(error, { code: cause.code });
  }
  return error;
}
