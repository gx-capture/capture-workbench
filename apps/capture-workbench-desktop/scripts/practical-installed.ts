import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, win32 } from 'node:path';

// Practical installed OCR verifies a normal production build of Capture
// Workbench side by side with any existing installation. Only the Tauri
// identity triple changes; features, frontend, resources and security
// configuration remain the release configuration.

export const ORIGINAL_IDENTITY = Object.freeze({
  identifier: 'io.github.gx-capture.capture-workbench',
  productName: 'Capture Workbench',
  mainBinaryName: 'capture-workbench-desktop',
});

export const RUNTIME_EXECUTABLE_NAME = 'capture-runtime-x86_64-pc-windows-msvc.exe';
export const RUNTIME_MANIFEST_NAME = 'capture-runtime-manifest.json';
export const RUNTIME_SCHEMA_NAME = 'capture-document-v2.schema.json';
export const RUNTIME_CATALOG_NAME = 'capture-engine-catalog.json';

export type PracticalMode = 'rehearsal' | 'published';

export interface PracticalVariant {
  readonly runId: string;
  readonly identifier: string;
  readonly productName: string;
  readonly mainBinaryName: string;
}

export interface VerifiedFile {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface WorkerArtifact extends VerifiedFile {
  readonly requirementId: string;
  readonly url: string;
}

export interface VerifiedRuntimeRelease {
  readonly directory: string;
  readonly runtimeVersion: string;
  readonly executable: VerifiedFile;
  readonly manifest: VerifiedFile;
  readonly schema: VerifiedFile;
  readonly catalog: VerifiedFile;
  readonly workers: readonly WorkerArtifact[];
}

export interface PracticalInstallerProvenance {
  readonly schemaVersion: '1';
  readonly evidenceKind: 'capture-practical-installer';
  readonly mode: PracticalMode;
  readonly variant: PracticalVariant;
  readonly sourceCommit: string;
  readonly sourceTreeClean: boolean;
  readonly releaseVersion: string;
  readonly runtime: {
    readonly runtimeVersion: string;
    readonly executable: VerifiedFile;
    readonly manifest: VerifiedFile;
    readonly schema: VerifiedFile;
    readonly catalog: VerifiedFile;
    readonly workers: readonly WorkerArtifact[];
  };
  readonly overlaySha256: string;
  readonly installer: VerifiedFile;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[a-z0-9]{8,16}$/u;
const RELEASE_URL_PREFIX = 'https://github.com/gx-capture/capture-workbench/releases/download/';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    throw new Error('Practical run ID must be 8 through 16 lowercase letters or digits.');
  }
}

export function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a 64-character lowercase SHA-256 digest.`);
  }
}

export function practicalVariant(runId: string): PracticalVariant {
  assertRunId(runId);
  return Object.freeze({
    runId,
    identifier: `io.github.gx-capture.cw-practical-${runId}`,
    productName: `Capture Workbench Practical ${runId}`,
    mainBinaryName: `capture-workbench-practical-${runId}`,
  });
}

/** Tauri merges this after the release configuration; nothing else changes. */
export function practicalOverlay(variant: PracticalVariant): Record<string, string> {
  return {
    identifier: variant.identifier,
    productName: variant.productName,
    mainBinaryName: variant.mainBinaryName,
  };
}

export function practicalRegistryKeys(variant: PracticalVariant) {
  return {
    productRegistryKey: `HKCU\\Software\\github\\${variant.productName}`,
    uninstallRegistryKey: `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${variant.productName}`,
  };
}

export function practicalInstallerFileName(variant: PracticalVariant, version: string): string {
  return `${variant.productName}_${version}_x64-setup.exe`;
}

export function installedExecutableName(variant: PracticalVariant): string {
  return `${variant.mainBinaryName}.exe`;
}

async function regularFile(path: string, label: string): Promise<Buffer> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`${label} must be a regular file.`);
  return readFile(path);
}

function parseSidecar(text: string, fileName: string): string {
  const match = /^([0-9a-f]{64}) [ *](.+?)\r?\n?$/u.exec(text);
  if (!match || match[2] !== fileName) {
    throw new Error(`Checksum sidecar for ${fileName} is malformed or names another file.`);
  }
  return match[1];
}

async function verifiedWithSidecar(directory: string, fileName: string): Promise<VerifiedFile> {
  const bytes = await regularFile(join(directory, fileName), fileName);
  const sidecar = await regularFile(join(directory, `${fileName}.sha256`), `${fileName}.sha256`);
  const sha256 = sha256Hex(bytes);
  if (parseSidecar(sidecar.toString('utf8'), fileName) !== sha256) {
    throw new Error(`${fileName} differs from its release checksum.`);
  }
  return { fileName, bytes: bytes.length, sha256 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verifies a flat runtime release directory: the local `dist/release` output
 * for rehearsal, or the downloaded GitHub release assets once published. The
 * caller supplies the runtime executable digest from an independent source
 * (candidate manifest or release notes) so the directory cannot vouch for
 * itself.
 */
export async function verifyRuntimeReleaseDirectory(
  directory: string,
  expectedRuntimeSha256: string,
  expectedVersion: string,
): Promise<VerifiedRuntimeRelease> {
  assertSha256(expectedRuntimeSha256, 'Expected runtime SHA-256');
  const root = resolve(directory);
  if (!(await lstat(root).catch(() => undefined))?.isDirectory()) {
    throw new Error('Runtime release directory must be a regular directory.');
  }
  const executable = await verifiedWithSidecar(root, RUNTIME_EXECUTABLE_NAME);
  if (executable.sha256 !== expectedRuntimeSha256) {
    throw new Error('Runtime executable differs from the expected release digest.');
  }
  const catalog = await verifiedWithSidecar(root, RUNTIME_CATALOG_NAME);
  const manifestBytes = await regularFile(join(root, RUNTIME_MANIFEST_NAME), RUNTIME_MANIFEST_NAME);
  const schemaBytes = await regularFile(join(root, RUNTIME_SCHEMA_NAME), RUNTIME_SCHEMA_NAME);
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (
    !isRecord(manifest) ||
    manifest.fileName !== RUNTIME_EXECUTABLE_NAME ||
    manifest.sha256 !== executable.sha256 ||
    manifest.bytes !== executable.bytes ||
    manifest.schemaFileName !== RUNTIME_SCHEMA_NAME ||
    manifest.schemaSha256 !== sha256Hex(schemaBytes) ||
    manifest.runtimeVersion !== expectedVersion
  ) {
    throw new Error('Runtime manifest does not bind the release executable, schema and version.');
  }
  const catalogValue: unknown = JSON.parse(
    (await readFile(join(root, RUNTIME_CATALOG_NAME))).toString('utf8'),
  );
  if (!isRecord(catalogValue) || catalogValue.runtimeVersion !== expectedVersion || !Array.isArray(catalogValue.requirements)) {
    throw new Error('Runtime engine catalog is malformed or has another version.');
  }
  const workers: WorkerArtifact[] = [];
  for (const requirement of catalogValue.requirements) {
    if (!isRecord(requirement) || !Array.isArray(requirement.artifacts)) {
      throw new Error('Runtime engine catalog requirement is malformed.');
    }
    for (const artifact of requirement.artifacts) {
      if (
        !isRecord(artifact) ||
        artifact.role !== 'worker' ||
        typeof artifact.fileName !== 'string' ||
        basename(artifact.fileName) !== artifact.fileName ||
        typeof artifact.url !== 'string' ||
        artifact.url !== `${RELEASE_URL_PREFIX}v${expectedVersion}/${artifact.fileName}` ||
        !Number.isSafeInteger(artifact.bytes) ||
        typeof artifact.sha256 !== 'string' ||
        !SHA256.test(artifact.sha256) ||
        typeof requirement.requirementId !== 'string'
      ) {
        throw new Error('Runtime engine catalog worker artifact is malformed.');
      }
      workers.push({
        requirementId: requirement.requirementId,
        fileName: artifact.fileName,
        bytes: Number(artifact.bytes),
        sha256: artifact.sha256,
        url: artifact.url,
      });
    }
  }
  if (!workers.some((worker) => worker.requirementId === 'windowsml-ocr')) {
    throw new Error('Runtime engine catalog does not publish an OCR worker.');
  }
  return {
    directory: root,
    runtimeVersion: expectedVersion,
    executable,
    manifest: { fileName: RUNTIME_MANIFEST_NAME, bytes: manifestBytes.length, sha256: sha256Hex(manifestBytes) },
    schema: { fileName: RUNTIME_SCHEMA_NAME, bytes: schemaBytes.length, sha256: sha256Hex(schemaBytes) },
    catalog,
    workers,
  };
}

/** Reads a worker from the verified directory and checks it against the catalog. */
export async function readVerifiedWorker(release: VerifiedRuntimeRelease, worker: WorkerArtifact): Promise<Buffer> {
  const bytes = await regularFile(join(release.directory, worker.fileName), worker.fileName);
  if (bytes.length !== worker.bytes || sha256Hex(bytes) !== worker.sha256) {
    throw new Error(`${worker.fileName} differs from the release engine catalog.`);
  }
  return bytes;
}

function nsisDefines(script: string): Map<string, string> {
  const defines = new Map<string, string>();
  for (const match of script.matchAll(/^!define\s+([A-Z_]+)\s+"([^"]*)"\s*$/gmu)) {
    if (defines.has(match[1])) throw new Error(`Generated NSIS script redefines ${match[1]}.`);
    defines.set(match[1], match[2]);
  }
  return defines;
}

/**
 * Proves the generated installer cannot upgrade, uninstall, stop or overwrite
 * the ordinary installation: every identity define names the variant, and no
 * other line refers to the original product, identifier or executable.
 */
export function assertNsisTargetsOnlyVariant(script: string, variant: PracticalVariant): void {
  const defines = nsisDefines(script);
  const expected: Record<string, string> = {
    PRODUCTNAME: variant.productName,
    MAINBINARYNAME: variant.mainBinaryName,
    BUNDLEID: variant.identifier,
    MANUFACTURER: 'github',
  };
  for (const [name, value] of Object.entries(expected)) {
    if (defines.get(name) !== value) {
      throw new Error(`Generated NSIS ${name} does not name the practical variant.`);
    }
  }
  const lines = script.split(/\r?\n/u);
  for (const line of lines) {
    // The build input path names Cargo's binary target; the installed file
    // name is ${MAINBINARYNAME}.exe.
    if (/^!define\s+MAINBINARYSRCPATH\s/u.test(line)) continue;
    const lower = line.toLowerCase();
    if (
      lower.includes(ORIGINAL_IDENTITY.identifier) ||
      lower.includes(`${ORIGINAL_IDENTITY.mainBinaryName}.exe`) ||
      new RegExp(`${ORIGINAL_IDENTITY.productName}(?! Practical ${variant.runId}\\b)`, 'u').test(line)
    ) {
      throw new Error('Generated NSIS script still references the ordinary Capture Workbench installation.');
    }
  }
}

export function assertStrictChild(parent: string, candidate: string, label: string): string {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  const path = relative(resolvedParent, resolvedCandidate);
  if (!path || path.startsWith('..') || isAbsolute(path) || /[\0\r\n]/u.test(resolvedCandidate)) {
    throw new Error(`${label} must be a strict descendant of its owned root.`);
  }
  return resolvedCandidate;
}

/**
 * The variant's Roaming/Local roots are where the unmodified production
 * build stores library, runtime, worker and model state. They must be named
 * exactly after the variant identifier directly under the known folders.
 */
export function practicalKnownFolderRoots(
  knownFolders: { readonly roaming: string; readonly local: string },
  variant: PracticalVariant,
): readonly string[] {
  return [knownFolders.roaming, knownFolders.local].map((folder) => {
    if (!win32.isAbsolute(folder)) throw new Error('Windows known folder must be absolute.');
    const root = win32.join(folder, variant.identifier);
    if (win32.dirname(root).toLowerCase() !== win32.resolve(folder).toLowerCase()) {
      throw new Error('Variant known-folder root must be a direct child of the known folder.');
    }
    return root;
  });
}

export async function assertAbsent(paths: readonly string[], label: string): Promise<void> {
  for (const path of paths) {
    if (await lstat(path).catch(() => undefined)) {
      throw new Error(`${label} already exists; refusing to reuse state that this run does not own.`);
    }
  }
}

export function assertPracticalProvenance(value: unknown): asserts value is PracticalInstallerProvenance {
  if (!isRecord(value) || value.schemaVersion !== '1' || value.evidenceKind !== 'capture-practical-installer') {
    throw new Error('Practical installer provenance kind is invalid.');
  }
  if (value.mode !== 'rehearsal' && value.mode !== 'published') {
    throw new Error('Practical installer provenance mode is invalid.');
  }
  const variant = value.variant;
  if (!isRecord(variant)) throw new Error('Practical installer variant is missing.');
  const expected = practicalVariant(String(variant.runId));
  for (const key of ['identifier', 'productName', 'mainBinaryName'] as const) {
    if (variant[key] !== expected[key]) throw new Error('Practical installer variant identity is inconsistent.');
  }
  if (typeof value.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.sourceCommit)) {
    throw new Error('Practical installer source commit is invalid.');
  }
  if (typeof value.sourceTreeClean !== 'boolean') throw new Error('Practical installer source state is invalid.');
  if (value.mode === 'published' && value.sourceTreeClean !== true) {
    throw new Error('Published practical installers must be built from a clean source tree.');
  }
  const runtime = value.runtime;
  const installer = value.installer;
  if (!isRecord(runtime) || !isRecord(installer)) throw new Error('Practical installer provenance is incomplete.');
  for (const file of [runtime.executable, runtime.manifest, runtime.schema, runtime.catalog, installer]) {
    if (!isRecord(file) || typeof file.fileName !== 'string' || !Number.isSafeInteger(file.bytes)) {
      throw new Error('Practical installer provenance file identity is invalid.');
    }
    assertSha256(file.sha256, 'Practical installer provenance digest');
  }
  assertSha256(value.overlaySha256, 'Practical overlay digest');
  if (!Array.isArray(runtime.workers) || runtime.workers.length === 0) {
    throw new Error('Practical installer provenance omits worker identities.');
  }
}

export interface PracticalRunArguments {
  readonly provenance: string;
  readonly input: string;
  readonly inputSha256: string;
  readonly runtimeRelease?: string;
}

export function parseRunArguments(args: readonly string[]): PracticalRunArguments {
  const allowed = ['--provenance', '--input', '--input-sha256', '--runtime-release'];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.includes(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error(
        'Use --provenance <installer-provenance.json> --input <file> --input-sha256 <sha256> [--runtime-release <directory>].',
      );
    }
    values.set(name, value);
  }
  for (const name of allowed.slice(0, 3)) {
    if (!values.has(name)) throw new Error(`Missing required ${name}.`);
  }
  const inputSha256 = values.get('--input-sha256') ?? '';
  assertSha256(inputSha256, '--input-sha256');
  const runtimeRelease = values.get('--runtime-release');
  return {
    provenance: resolve(values.get('--provenance') ?? ''),
    input: resolve(values.get('--input') ?? ''),
    inputSha256,
    ...(runtimeRelease ? { runtimeRelease: resolve(runtimeRelease) } : {}),
  };
}

/**
 * Rehearsal serves the exact catalog worker from a verified local release
 * directory because the GitHub release does not exist yet. Published runs
 * must download it from the release itself, so the mirror is forbidden.
 */
export function assertRuntimeReleaseMatchesMode(mode: PracticalMode, runtimeRelease: string | undefined): void {
  if (mode === 'rehearsal' && !runtimeRelease) {
    throw new Error('Rehearsal runs require --runtime-release to mirror the unpublished OCR worker.');
  }
  if (mode === 'published' && runtimeRelease) {
    throw new Error('Published runs must download the OCR worker from the GitHub release; --runtime-release is forbidden.');
  }
}

export type PracticalSourceKind = 'image' | 'pdf';

export function practicalSourceKind(path: string): PracticalSourceKind {
  const lower = path.toLowerCase();
  if (/\.(?:jpe?g|png)$/u.test(lower)) return 'image';
  if (lower.endsWith('.pdf')) return 'pdf';
  throw new Error('Practical OCR input must be a JPEG, PNG or PDF file.');
}

export const PRACTICAL_CHILD_ENVIRONMENT_ALLOWLIST = [
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'USERPROFILE',
  'WINDIR',
] as const;

/**
 * Builds the complete application environment from an allowlist, so no
 * inherited CAPTURE_* model, worker or evidence override can reach the
 * production build. Only the rehearsal worker mirror is added explicitly.
 */
export function practicalChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  options: {
    readonly temporary: string;
    readonly webViewData: string;
    readonly cdpPort: number;
    readonly workerMirrorOrigin?: string;
  },
): Record<string, string> {
  if (!Number.isSafeInteger(options.cdpPort) || options.cdpPort < 1 || options.cdpPort > 65_535) {
    throw new Error('WebView2 CDP port must be from 1 through 65535.');
  }
  const environment: Record<string, string> = {};
  for (const allowed of PRACTICAL_CHILD_ENVIRONMENT_ALLOWLIST) {
    const entry = Object.entries(source).find(
      ([name, value]) => name.toUpperCase() === allowed && typeof value === 'string' && value.length > 0,
    );
    if (entry?.[1]) environment[allowed] = entry[1];
  }
  environment.TEMP = options.temporary;
  environment.TMP = options.temporary;
  environment.WEBVIEW2_USER_DATA_FOLDER = options.webViewData;
  environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${options.cdpPort} --remote-allow-origins=*`;
  if (options.workerMirrorOrigin !== undefined) {
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(options.workerMirrorOrigin)) {
      throw new Error('Worker mirror must be a numeric loopback HTTP origin.');
    }
    environment.CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN = '1';
    environment.CAPTURE_SMOKE_WORKER_MIRROR_URL = options.workerMirrorOrigin;
  }
  return environment;
}

export interface ProcessImageRecord {
  readonly pid: number;
  readonly executablePath: string;
}

/** Keeps only processes whose image lies inside one of the run-owned roots. */
export function ownedProcessImages(
  records: readonly ProcessImageRecord[],
  roots: readonly string[],
): ProcessImageRecord[] {
  const prefixes = roots.map((root) => `${win32.resolve(root).toLowerCase().replace(/\\+$/u, '')}\\`);
  return records.filter((record) => {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !win32.isAbsolute(record.executablePath)) return false;
    const path = win32.resolve(record.executablePath).toLowerCase();
    return prefixes.some((prefix) => path.startsWith(prefix));
  });
}

export interface PracticalCleanupEvidence {
  readonly normalWindowClose: boolean;
  readonly forcedTerminationCount: number;
  readonly ownedProcessesStopped: boolean;
  readonly cdpPortReleased: boolean;
  readonly uninstallerCompleted: boolean;
  readonly installDirectoryRemoved: boolean;
  readonly uninstallKeyRemoved: boolean;
  readonly registryResidueRemoved: boolean;
  readonly variantDataRemoved: boolean;
  readonly runDirectoryRemoved: boolean;
  readonly ordinaryInstallationPreserved: boolean;
}

export interface PracticalOcrEvidence {
  readonly schemaVersion: '1';
  readonly evidenceKind: 'capture-practical-installed-ocr';
  readonly mode: PracticalMode;
  readonly releaseGateSatisfied: false;
  readonly usabilityReview: 'pending-private-human-review';
  readonly accuracy: 'CER not evaluated';
  readonly runId: string;
  readonly sourceCommit: string;
  readonly releaseVersion: string;
  readonly installerSha256: string;
  readonly runtimeExecutableSha256: string;
  readonly workerSource: 'loopback-mirror-of-verified-release-directory' | 'github-release';
  readonly workerArchiveSha256: string;
  readonly fixture: { readonly kind: PracticalSourceKind; readonly sha256: string; readonly bytes: number };
  readonly importedSourceSha256: string;
  readonly runtime: {
    readonly contractSetSha256: string;
    readonly workerExecutableSha256: string;
    readonly computeMode: 'gpu-dml' | 'cpu-fallback';
  };
  readonly ocr: {
    readonly engine: 'windowsml-ocr';
    readonly model: string;
    readonly device: 'windowsml-dml' | 'cpu';
    readonly segmentCount: number;
    readonly characterCount: number;
  };
  readonly observedProcessImages: {
    readonly runtimeExecutableSha256: readonly string[];
    readonly workerExecutableSha256: readonly string[];
  };
  readonly durationsMs: {
    readonly install: number;
    readonly runtimeReady: number;
    readonly ocr: number;
  };
  readonly cleanup: PracticalCleanupEvidence;
}

function containsAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') return /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\)/u.test(value);
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (isRecord(value)) return Object.values(value).some(containsAbsolutePath);
  return false;
}

export function assertPracticalEvidence(value: PracticalOcrEvidence): void {
  if (value.evidenceKind !== 'capture-practical-installed-ocr' || value.releaseGateSatisfied !== false) {
    throw new Error('Practical OCR evidence must remain a non-release, human-reviewed observation.');
  }
  if (containsAbsolutePath(value)) throw new Error('Practical OCR evidence must not contain local paths.');
  if (value.mode === 'published' && value.workerSource !== 'github-release') {
    throw new Error('Published practical OCR must download the worker from the GitHub release.');
  }
  if (value.mode === 'rehearsal' && value.workerSource === 'github-release') {
    throw new Error('Rehearsal practical OCR cannot claim a GitHub release worker download.');
  }
  if (value.importedSourceSha256 !== value.fixture.sha256) {
    throw new Error('Imported source bytes differ from the supplied fixture.');
  }
  if (value.ocr.segmentCount < 1 || value.ocr.characterCount < 1) {
    throw new Error('Practical OCR produced no visible text.');
  }
  if (!value.observedProcessImages.runtimeExecutableSha256.every((sha) => sha === value.runtimeExecutableSha256)) {
    throw new Error('A running runtime image differs from the installer provenance.');
  }
  if (!value.observedProcessImages.workerExecutableSha256.every((sha) => sha === value.runtime.workerExecutableSha256)) {
    throw new Error('A running OCR worker image differs from authenticated runtime readiness.');
  }
  const cleanup = value.cleanup;
  if (
    !cleanup.normalWindowClose ||
    cleanup.forcedTerminationCount !== 0 ||
    !cleanup.ownedProcessesStopped ||
    !cleanup.cdpPortReleased ||
    !cleanup.uninstallerCompleted ||
    !cleanup.installDirectoryRemoved ||
    !cleanup.uninstallKeyRemoved ||
    !cleanup.variantDataRemoved ||
    !cleanup.runDirectoryRemoved ||
    !cleanup.ordinaryInstallationPreserved
  ) {
    throw new Error('Practical OCR cleanup is incomplete or unproven.');
  }
}
