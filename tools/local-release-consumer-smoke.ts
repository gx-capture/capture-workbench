import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(
  await readFile(join(repoRoot, 'packages/capture-angular/package.json'), 'utf8'),
) as { name: string; version: string };
const releaseRoot = join(repoRoot, 'packages/capture-runtime/dist/release');

export const CORE_RUNTIME_ASSET_NAMES = Object.freeze([
  'capture-runtime-x86_64-pc-windows-msvc.exe',
  'capture-runtime-x86_64-pc-windows-msvc.exe.sha256',
  'capture-runtime-manifest.json',
  'capture-document-v1.schema.json',
]);
// Keep the historical export for callers that only need the core manifest names.
export const RUNTIME_ASSET_NAMES = CORE_RUNTIME_ASSET_NAMES;

const ENGINE_CATALOG_NAME = 'capture-engine-catalog.json';
const ENGINE_CATALOG_CHECKSUM_NAME = `${ENGINE_CATALOG_NAME}.sha256`;
const WORKER_PROTOCOL_VERSION = '1';
const MODEL_REQUIREMENT_IDS = ['windowsml-ocr', 'whisper-primary'] as const;

export type RuntimeReleaseManifest = {
  readonly manifestVersion: string;
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaFileName: string;
  readonly schemaSha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are not canonical.`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, 'utf8');
}

function assertSafeAssetName(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`${label} must be a safe release file name.`);
  }
}

type CatalogWorkerDescriptor = {
  readonly requirementId: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly filesManifestSha256: string;
};

function catalogWorkers(raw: unknown, expectedVersion: string, catalogBytes: Buffer): CatalogWorkerDescriptor[] {
  if (!isRecord(raw)) throw new Error('Engine catalog must be an object.');
  exactKeys(raw, ['catalogVersion', 'requirements', 'runtimeVersion'], 'Engine catalog');
  if (raw.catalogVersion !== '2' || raw.runtimeVersion !== expectedVersion) {
    throw new Error('Engine catalog version or runtime version is invalid.');
  }
  if (!catalogBytes.equals(canonicalJson(raw))) {
    throw new Error('Engine catalog must use canonical UTF-8 JSON.');
  }
  if (!Array.isArray(raw.requirements)) {
    throw new Error('Engine catalog requirements are invalid.');
  }
  const requirements = raw.requirements;
  const ids = requirements.map((item) => (isRecord(item) ? item.requirementId : undefined));
  if (
    requirements.length !== MODEL_REQUIREMENT_IDS.length ||
    JSON.stringify([...ids].sort()) !== JSON.stringify([...MODEL_REQUIREMENT_IDS].sort())
  ) {
    throw new Error('Engine catalog requirements are invalid.');
  }
  const workers: CatalogWorkerDescriptor[] = [];
  const seenRequirements = new Set<string>();
  const seenArchives = new Set<string>();
  for (const item of requirements) {
    if (!isRecord(item)) throw new Error('Engine catalog requirement is invalid.');
    exactKeys(item, ['requirementId', 'artifacts', 'modelFiles', 'unavailableReason'], 'Engine catalog requirement');
    const requirementId = item.requirementId;
    if (
      typeof requirementId !== 'string' ||
      seenRequirements.has(requirementId) ||
      item.unavailableReason !== null ||
      !Array.isArray(item.artifacts) ||
      item.artifacts.length !== 1 ||
      !isRecord(item.modelFiles)
    ) {
      throw new Error(`Engine catalog requirement is invalid: ${String(requirementId)}.`);
    }
    seenRequirements.add(requirementId);
    const artifact = item.artifacts[0];
    if (!isRecord(artifact)) throw new Error('Engine catalog worker artifact is invalid.');
    exactKeys(
      artifact,
      [
        'role',
        'requirementId',
        'artifactVersion',
        'workerProtocolVersion',
        'platform',
        'arch',
        'fileName',
        'bytes',
        'sha256',
        'extractedBytes',
        'entryPoint',
        'filesManifestSha256',
        'url',
      ],
      'Engine catalog worker artifact',
    );
    const artifactBytes = artifact.bytes;
    const artifactExtractedBytes = artifact.extractedBytes;
    if (
      artifact.role !== 'worker' ||
      artifact.requirementId !== requirementId ||
      artifact.artifactVersion !== expectedVersion ||
      artifact.workerProtocolVersion !== WORKER_PROTOCOL_VERSION ||
      artifact.platform !== 'windows' ||
      artifact.arch !== 'x86_64' ||
      typeof artifact.entryPoint !== 'string' ||
      !artifact.entryPoint ||
      typeof artifactBytes !== 'number' ||
      !Number.isSafeInteger(artifactBytes) ||
      artifactBytes < 1 ||
      typeof artifactExtractedBytes !== 'number' ||
      !Number.isSafeInteger(artifactExtractedBytes) ||
      artifactExtractedBytes < 1 ||
      typeof artifact.url !== 'string' ||
      !artifact.url.startsWith('https://')
    ) {
      throw new Error('Engine catalog worker artifact is invalid.');
    }
    assertSafeAssetName(artifact.fileName, 'Engine catalog worker archive');
    if (!artifact.fileName.endsWith('.zip') || artifact.fileName.toLowerCase().includes('model')) {
      throw new Error('Engine catalog may contain only worker archives.');
    }
    assertSha256(artifact.sha256, 'Engine catalog worker archive digest');
    assertSha256(artifact.filesManifestSha256, 'Engine catalog worker manifest digest');
    if (seenArchives.has(artifact.fileName)) {
      throw new Error('Engine catalog worker archive names must be unique.');
    }
    seenArchives.add(artifact.fileName);

    const modelFiles = item.modelFiles;
    exactKeys(
      modelFiles,
      [
        'artifactVersion',
        'entryCount',
        'entryPoint',
        'extractedBytes',
        'files',
        'manifestSha256',
        'sourceLockSha256',
      ],
      'Engine catalog model delivery',
    );
    const modelEntryCount = modelFiles.entryCount;
    const modelExtractedBytes = modelFiles.extractedBytes;
    if (
      modelFiles.artifactVersion !== expectedVersion ||
      modelFiles.entryPoint !== 'model' ||
      typeof modelEntryCount !== 'number' ||
      !Number.isSafeInteger(modelEntryCount) ||
      modelEntryCount < 1 ||
      !Array.isArray(modelFiles.files) ||
      modelFiles.files.length !== modelEntryCount ||
      typeof modelExtractedBytes !== 'number' ||
      !Number.isSafeInteger(modelExtractedBytes) ||
      modelExtractedBytes < 1
    ) {
      throw new Error('Engine catalog model delivery is invalid.');
    }
    assertSha256(modelFiles.manifestSha256, 'Engine catalog model manifest digest');
    assertSha256(modelFiles.sourceLockSha256, 'Engine catalog model source-lock digest');
    workers.push({
      requirementId,
      fileName: artifact.fileName,
      bytes: artifactBytes,
      sha256: artifact.sha256,
      filesManifestSha256: artifact.filesManifestSha256,
    });
  }
  return workers;
}

export function validateRuntimeManifest(
  raw: unknown,
  expectedVersion: string,
): RuntimeReleaseManifest {
  if (!isRecord(raw)) throw new Error('Runtime release manifest must be an object.');
  const manifest = raw as Partial<RuntimeReleaseManifest>;
  if (manifest.manifestVersion !== '1') {
    throw new Error('Runtime release manifest version must be 1.');
  }
  if (manifest.runtimeVersion !== expectedVersion) {
    throw new Error(
      `Runtime release version ${String(manifest.runtimeVersion)} does not match ${expectedVersion}.`,
    );
  }
  if (
    manifest.apiVersion !== '1.0' ||
    manifest.captureDocumentSchemaVersion !== '1' ||
    manifest.platform !== 'windows' ||
    manifest.arch !== 'x86_64'
  ) {
    throw new Error('Runtime release manifest has an unsupported platform or contract version.');
  }
  if (manifest.fileName !== RUNTIME_ASSET_NAMES[0]) {
    throw new Error('Runtime release executable name is not canonical.');
  }
  if (manifest.schemaFileName !== RUNTIME_ASSET_NAMES[3]) {
    throw new Error('Runtime release schema name is not canonical.');
  }
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) {
    throw new Error('Runtime release executable byte count is invalid.');
  }
  assertSha256(manifest.sha256, 'Runtime executable digest');
  assertSha256(manifest.schemaSha256, 'Runtime schema digest');
  return manifest as RuntimeReleaseManifest;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactAssetNames(actual: readonly string[], expected: readonly string[]): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((name, index) => name !== expectedSorted[index])
  ) {
    throw new Error('Runtime release contains files outside the canonical asset set.');
  }
}

async function verifyChecksum(directory: string, name: string, expectedDigest?: string): Promise<string> {
  const bytes = await readFile(join(directory, name));
  const digest = sha256(bytes);
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    throw new Error(`Release asset digest does not match catalog: ${name}.`);
  }
  const checksumName = `${name}.sha256`;
  const checksum = (await readFile(join(directory, checksumName), 'utf8')).trim();
  if (checksum !== `${digest}  ${name}`) {
    throw new Error(`Release checksum does not match ${name}.`);
  }
  return digest;
}

type RuntimeReleaseInspection = {
  readonly manifest: RuntimeReleaseManifest;
  readonly assetNames: readonly string[];
};

async function inspectRuntimeRelease(
  directory: string,
  expectedVersion: string,
): Promise<RuntimeReleaseInspection> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Runtime release contains files outside the canonical asset set.');
  }

  const hasCatalog = names.includes(ENGINE_CATALOG_NAME);
  const hasCatalogChecksum = names.includes(ENGINE_CATALOG_CHECKSUM_NAME);
  if (hasCatalog !== hasCatalogChecksum) {
    throw new Error('Runtime release catalog and checksum must be published together.');
  }

  const assetNames: string[] = [...RUNTIME_ASSET_NAMES];
  const workers: CatalogWorkerDescriptor[] = [];
  if (hasCatalog) {
    const catalogBytes = await readFile(join(directory, ENGINE_CATALOG_NAME));
    let rawCatalog: unknown;
    try {
      rawCatalog = JSON.parse(catalogBytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('Engine catalog JSON is invalid.');
    }
    workers.push(...catalogWorkers(rawCatalog, expectedVersion, catalogBytes));
    assetNames.push(ENGINE_CATALOG_NAME, ENGINE_CATALOG_CHECKSUM_NAME);
    for (const worker of workers) {
      const filesManifestName = `${worker.fileName.slice(0, -'.zip'.length)}-files.json`;
      assertSafeAssetName(filesManifestName, 'Engine worker files manifest');
      assetNames.push(
        worker.fileName,
        `${worker.fileName}.sha256`,
        filesManifestName,
        `${filesManifestName}.sha256`,
      );
    }
  }
  assertExactAssetNames(names, assetNames);

  const manifest = validateRuntimeManifest(
    JSON.parse(await readFile(join(directory, 'capture-runtime-manifest.json'), 'utf8')),
    expectedVersion,
  );
  const executable = await readFile(join(directory, manifest.fileName));
  if (executable.byteLength !== manifest.bytes) {
    throw new Error('Runtime executable byte count does not match the manifest.');
  }
  if (sha256(executable) !== manifest.sha256) {
    throw new Error('Runtime executable digest does not match the manifest.');
  }

  const schema = await readFile(join(directory, manifest.schemaFileName));
  if (sha256(schema) !== manifest.schemaSha256) {
    throw new Error('Runtime schema digest does not match the manifest.');
  }

  const runtimeChecksum = (await readFile(
    join(directory, 'capture-runtime-x86_64-pc-windows-msvc.exe.sha256'),
    'utf8',
  )).trim();
  const checksumMatch = runtimeChecksum.match(/^([0-9a-f]{64})\s+(.+)$/u);
  if (!checksumMatch || checksumMatch[1] !== manifest.sha256 || checksumMatch[2] !== manifest.fileName) {
    throw new Error('Runtime checksum file does not match the manifest.');
  }

  if (hasCatalog) {
    await verifyChecksum(directory, ENGINE_CATALOG_NAME);
    for (const worker of workers) {
      const filesManifestName = `${worker.fileName.slice(0, -'.zip'.length)}-files.json`;
      await verifyChecksum(directory, worker.fileName, worker.sha256);
      await verifyChecksum(directory, filesManifestName, worker.filesManifestSha256);
    }
  }
  return { manifest, assetNames: Object.freeze(assetNames) };
}

export async function verifyRuntimeRelease(
  directory: string,
  expectedVersion: string,
): Promise<RuntimeReleaseManifest> {
  return (await inspectRuntimeRelease(directory, expectedVersion)).manifest;
}

async function copyRuntimeRelease(
  source: string,
  destination: string,
  assetNames: readonly string[],
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const name of assetNames) {
    await copyFile(join(source, name), join(destination, name));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (!port) throw new Error('Unable to allocate a loopback port.');
  return port;
}

async function startReleaseMirror(
  directory: string,
  version: string,
  assetNames: readonly string[],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url) {
      response.writeHead(405).end();
      return;
    }
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const prefix = `/v${version}/`;
    const name = pathname.startsWith(prefix)
      ? decodeURIComponent(pathname.slice(prefix.length))
      : undefined;
    if (!name || !assetNames.includes(name)) {
      response.writeHead(404).end();
      return;
    }
    const stream = createReadStream(join(directory, name));
    stream.once('error', () => response.destroy());
    response.writeHead(200, { Connection: 'close' });
    stream.pipe(response);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  if (!port) throw new Error('Local release mirror did not expose a loopback port.');
  return {
    baseUrl: `http://127.0.0.1:${port}/v${version}`,
    close: async () => {
      server.closeIdleConnections();
      server.closeAllConnections();
      await Promise.race([
        new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
        delay(3_000),
      ]);
      server.closeIdleConnections();
      server.closeAllConnections();
    },
  };
}

async function downloadAsset(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { Connection: 'close' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Runtime release download failed with HTTP ${response.status}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination),
  );
}

function listeningProcessIds(port: number): number[] {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  const ids = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING') continue;
    if (!fields[1]?.endsWith(`:${port}`)) continue;
    const pid = Number(fields[4]);
    if (Number.isInteger(pid) && pid > 0) ids.add(pid);
  }
  return [...ids];
}

function forceStopProcessIds(processIds: number[]): void {
  if (process.platform !== 'win32') return;
  for (const pid of processIds) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
    });
  }
}

async function stopProcess(
  child: ReturnType<typeof spawn>,
  port: number,
): Promise<void> {
  if (
    (child.exitCode !== null || child.signalCode !== null) &&
    listeningProcessIds(port).length === 0
  ) {
    return;
  }
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  child.once('exit', resolveExit);
  child.kill();
  await delay(250);
  const processIds = new Set(listeningProcessIds(port));
  if (child.pid) processIds.add(child.pid);
  if (processIds.size > 0) {
    forceStopProcessIds([...processIds]);
    await Promise.race([exited, delay(2_000)]);
  }
  if (listeningProcessIds(port).length > 0) {
    throw new Error(`Unable to stop downloaded runtime listener on port ${port}.`);
  }
  if (child.exitCode === null && child.signalCode === null && process.platform !== 'win32') {
    throw new Error(`Unable to stop downloaded runtime process ${child.pid ?? 'unknown'}.`);
  }
}

async function runRuntimeReadiness(
  directory: string,
  manifest: RuntimeReleaseManifest,
  temporaryRoot: string,
): Promise<void> {
  const port = await findFreePort();
  const token = `capture-runtime-local-smoke-${randomUUID()}`;
  const dataDirectory = join(temporaryRoot, 'runtime-data');
  await mkdir(dataDirectory, { recursive: true });
  const child = spawn(
    join(directory, manifest.fileName),
    ['serve', '--port', String(port)],
    {
      cwd: directory,
      env: {
        ...process.env,
        CAPTURE_API_TOKEN: token,
        CAPTURE_STRUCTURING_PROVIDER: 'fake',
        CAPTURE_EXTRACTION_PROVIDER: 'fake',
        CAPTURE_APP_DATA_DIR: dataDirectory,
        CAPTURE_HOST: '127.0.0.1',
        CAPTURE_PORT: String(port),
        CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        CAPTURE_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        CAPTURE_ENABLE_API_DOCS: 'false',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let errorOutput = '';
  child.stderr?.on('data', (chunk) => {
    errorOutput += String(chunk);
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Downloaded runtime exited before readiness: ${errorOutput}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/health/ready`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          const health = (await response.json()) as { service?: unknown };
          if (health.service !== 'capture-runtime') {
            throw new Error('Downloaded runtime returned an unexpected service identity.');
          }
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('unexpected service')) {
          throw error;
        }
      }
      await delay(250);
    }
    throw new Error(`Downloaded runtime did not become ready: ${errorOutput}`);
  } finally {
    await stopProcess(child, port);
  }
}

function assertTemporaryRoot(root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTemp = resolve(tmpdir());
  const relativeRoot = relative(resolvedTemp, resolvedRoot);
  if (
    !relativeRoot ||
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${sep}`) ||
    resolve(resolvedTemp, relativeRoot) !== resolvedRoot
  ) {
    throw new Error(`Refusing to remove unexpected temporary path: ${resolvedRoot}`);
  }
}

export async function runLocalReleaseConsumerSmoke(): Promise<void> {
  const expectedVersion = packageManifest.version;
  const release = await inspectRuntimeRelease(releaseRoot, expectedVersion);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'capture-runtime-release-consumer-'));
  let mirror: { baseUrl: string; close: () => Promise<void> } | undefined;
  try {
    const mirrorDirectory = join(temporaryRoot, 'mirror');
    const installDirectory = join(temporaryRoot, 'install');
    await copyRuntimeRelease(releaseRoot, mirrorDirectory, release.assetNames);
    mirror = await startReleaseMirror(mirrorDirectory, expectedVersion, release.assetNames);
    await mkdir(installDirectory, { recursive: true });
    for (const name of release.assetNames) {
      await downloadAsset(`${mirror.baseUrl}/${name}`, join(installDirectory, name));
    }
    const manifest = (await inspectRuntimeRelease(installDirectory, expectedVersion)).manifest;
    await runRuntimeReadiness(installDirectory, manifest, temporaryRoot);
    process.stdout.write(
      `Local release consumer smoke passed for ${packageManifest.name}@${expectedVersion} and capture-runtime@${manifest.runtimeVersion}.\n`,
    );
  } finally {
    if (mirror) await mirror.close();
    assertTemporaryRoot(temporaryRoot);
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runLocalReleaseConsumerSmoke().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
