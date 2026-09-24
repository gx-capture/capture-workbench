import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export const ACCEPTANCE_NSIS_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
export const ACCEPTANCE_NSIS_FEATURE = 'acceptance-app-data';
const ACCEPTANCE_NSIS_PROVENANCE_NAME = 'capture-workbench-acceptance-nsis.provenance.json';

export interface AcceptanceNsisBuildCommand {
  readonly cargoTargetDir: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface AcceptanceNsisBuildOptions {
  readonly formalBundleRoot: string;
  readonly targetParent: string;
  readonly sourceHead: string;
  readonly stagedRuntimeSha256: string;
  readonly runtimeManifestSha256: string;
  readonly runTauriBuild: (command: AcceptanceNsisBuildCommand) => Promise<void>;
}

export interface AcceptanceNsisResult {
  readonly targetDir: string;
  readonly outputDirectory: string;
  readonly provenancePath: string;
  readonly installerFileName: string;
  readonly installerBytes: number;
  readonly installerSha256: string;
}

interface TreeSnapshotEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly bytes?: number;
  readonly sha256?: string;
}

interface TreeSnapshot {
  readonly exists: boolean;
  readonly entries: readonly TreeSnapshotEntry[];
}

export async function buildAcceptanceNsis(
  options: AcceptanceNsisBuildOptions,
): Promise<AcceptanceNsisResult> {
  const formalBundleRoot = resolve(options.formalBundleRoot);
  const targetParent = resolve(options.targetParent);
  if (isWithin(formalBundleRoot, targetParent)) {
    throw new Error('Acceptance NSIS target parent must not be inside the formal release bundle.');
  }
  await mkdir(targetParent, { recursive: true });
  const parentMetadata = await lstat(targetParent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error('Acceptance NSIS target parent must be a regular directory.');
  }
  const releaseSnapshot = await snapshotTree(formalBundleRoot);
  const targetDir = await mkdtemp(join(targetParent, 'capture-workbench-acceptance-nsis-'));
  let result: AcceptanceNsisResult | undefined;
  let buildFailure: unknown;
  try {
    await options.runTauriBuild({ cargoTargetDir: targetDir });
    result = await finalizeAcceptanceNsis({
      targetDir,
      sourceHead: options.sourceHead,
      stagedRuntimeSha256: options.stagedRuntimeSha256,
      runtimeManifestSha256: options.runtimeManifestSha256,
    });
  } catch (error) {
    buildFailure = error;
  }

  let releaseAfter: TreeSnapshot;
  try {
    releaseAfter = await snapshotTree(formalBundleRoot);
  } catch (error) {
    await removeOwnedTarget(targetDir);
    throw error;
  }
  if (JSON.stringify(releaseSnapshot) !== JSON.stringify(releaseAfter)) {
    await removeOwnedTarget(targetDir);
    throw new Error('Formal release NSIS bundle changed during acceptance packaging.');
  }
  if (buildFailure !== undefined) {
    await removeOwnedTarget(targetDir);
    throw buildFailure;
  }
  if (result === undefined) {
    await removeOwnedTarget(targetDir);
    throw new Error('Acceptance NSIS packaging produced no result.');
  }
  return result;
}

export async function finalizeAcceptanceNsis(options: {
  readonly targetDir: string;
  readonly sourceHead: string;
  readonly stagedRuntimeSha256: string;
  readonly runtimeManifestSha256: string;
}): Promise<AcceptanceNsisResult> {
  requireDigest(options.sourceHead, 40, 'source HEAD');
  requireDigest(options.stagedRuntimeSha256, 64, 'staged runtime');
  requireDigest(options.runtimeManifestSha256, 64, 'runtime manifest');
  const bundleRoot = join(
    resolve(options.targetDir),
    ACCEPTANCE_NSIS_TARGET_TRIPLE,
    'release',
    'bundle',
  );
  const releaseBundle = join(bundleRoot, 'nsis');
  const acceptanceBundle = join(bundleRoot, 'nsis-acceptance');
  const releaseMetadata = await lstat(releaseBundle).catch(() => undefined);
  if (!releaseMetadata?.isDirectory() || releaseMetadata.isSymbolicLink()) {
    throw new Error('Acceptance NSIS finalizer requires a regular Tauri NSIS bundle directory.');
  }
  const acceptanceMetadata = await lstat(acceptanceBundle).catch(() => undefined);
  if (acceptanceMetadata !== undefined) {
    throw new Error('Acceptance NSIS output directory already exists; refusing to overwrite it.');
  }
  const bundleEntries = await readdir(releaseBundle, { withFileTypes: true });
  const installers = bundleEntries.filter(
    (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.exe'),
  );
  if (installers.length !== 1) {
    throw new Error('Acceptance NSIS bundle must contain exactly one installer executable.');
  }
  const installerFileName = installers[0].name;
  const installerPath = join(releaseBundle, installerFileName);
  const installerMetadata = await stat(installerPath);
  if (!installerMetadata.isFile() || installerMetadata.size < 1) {
    throw new Error('Acceptance NSIS installer must be a non-empty regular file.');
  }
  const installerSha256 = await sha256File(installerPath);
  const provenance = {
    schemaVersion: 1,
    sourceHead: options.sourceHead,
    buildFlavor: 'acceptance',
    tauriBundleTarget: 'nsis',
    targetTriple: ACCEPTANCE_NSIS_TARGET_TRIPLE,
    cargoFeature: ACCEPTANCE_NSIS_FEATURE,
    stagedRuntimeSha256: options.stagedRuntimeSha256,
    runtimeManifestSha256: options.runtimeManifestSha256,
    installer: {
      fileName: installerFileName,
      bytes: installerMetadata.size,
      sha256: installerSha256,
    },
    outputDirectory: 'nsis-acceptance',
    releaseOutputDirectory: 'nsis',
  } as const;
  const markerPath = join(releaseBundle, ACCEPTANCE_NSIS_PROVENANCE_NAME);
  const temporaryPath = join(releaseBundle, `.acceptance-nsis-provenance-${randomUUID()}.tmp`);
  let markerLinked = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(provenance, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    if (await lstat(markerPath).catch(() => undefined)) {
      throw new Error('Acceptance NSIS provenance file already exists; refusing to overwrite it.');
    }
    await link(temporaryPath, markerPath);
    markerLinked = true;
    await unlink(temporaryPath);
    await rename(releaseBundle, acceptanceBundle);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (markerLinked) await unlink(markerPath).catch(() => undefined);
    throw error;
  }
  return {
    targetDir: resolve(options.targetDir),
    outputDirectory: acceptanceBundle,
    provenancePath: join(acceptanceBundle, ACCEPTANCE_NSIS_PROVENANCE_NAME),
    installerFileName,
    installerBytes: installerMetadata.size,
    installerSha256,
  };
}

async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const metadata = await lstat(root).catch(() => undefined);
  if (metadata === undefined) return { exists: false, entries: [] };
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Formal release NSIS bundle must be absent or a regular directory.');
  }
  const entries: TreeSnapshotEntry[] = [];
  await visit(root, root, entries);
  return { exists: true, entries };
}

async function visit(root: string, current: string, entries: TreeSnapshotEntry[]): Promise<void> {
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const absolutePath = join(current, child.name);
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    if (child.isSymbolicLink()) {
      throw new Error('Formal release NSIS bundle must not contain symbolic links.');
    }
    if (child.isDirectory()) {
      entries.push({ path: relativePath, kind: 'directory' });
      await visit(root, absolutePath, entries);
      continue;
    }
    if (!child.isFile()) {
      throw new Error('Formal release NSIS bundle contains an unsupported entry.');
    }
    const bytes = await readFile(absolutePath);
    entries.push({
      path: relativePath,
      kind: 'file',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

function requireDigest(value: string, length: number, field: string): void {
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)) {
    throw new Error(`Acceptance NSIS ${field} identity is invalid.`);
  }
}

function isWithin(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..');
}

async function removeOwnedTarget(targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  if (await lstat(targetDir).then(() => true).catch(() => false)) {
    throw new Error('Acceptance NSIS isolated target cleanup did not complete.');
  }
}
