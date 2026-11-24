// A loopback mirror for the engine worker archives of a release that is not
// published yet: the local build (`capture-runtime:build-release-artifacts`,
// packages/capture-runtime/dist/release) or a runtime candidate's `runtime`
// directory. The packaged runtime opts in through
// CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN / _URL and then fetches
// `<origin>/<file name>` for each worker archive, or each part of one, that
// its catalog names; model files still come from the catalog's HTTPS URLs.
// The mirror serves only the worker files of the requirements a journey
// installs, each checked against the directory's catalog (size and SHA-256)
// before it accepts the first request.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';

export interface ReleaseWorkerFile {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReleaseWorkerMirrorOptions {
  readonly releaseDirectory: string;
  readonly requirementIds: readonly string[];
  /** When set, the directory's catalog must have exactly this SHA-256 (a candidate's verified catalog). */
  readonly catalogSha256?: string;
}

export interface ReleaseWorkerMirror {
  readonly baseUrl: string;
  readonly requests: number;
  readonly catalogSha256: string;
  readonly files: readonly ReleaseWorkerFile[];
  close(): Promise<void>;
}

const CATALOG_FILE_NAME = 'capture-engine-catalog.json';
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * The worker files a catalog names for the given requirements: every
 * delivery (a requirement's own artifacts, or each of its contents, such as
 * the `cuda` and `cpu` speech packs), and for a split archive each part.
 */
export function catalogWorkerFiles(
  catalog: unknown,
  requirementIds: readonly string[],
): readonly ReleaseWorkerFile[] {
  const requirements = record(catalog, 'Engine catalog').requirements;
  if (!Array.isArray(requirements)) throw new Error('Engine catalog requirements are invalid.');
  const files: ReleaseWorkerFile[] = [];
  for (const requirementId of requirementIds) {
    const matches = requirements
      .map((value) => record(value, 'Engine catalog requirement'))
      .filter((requirement) => requirement.requirementId === requirementId);
    if (matches.length !== 1) {
      throw new Error(`Engine catalog must contain exactly one ${requirementId} requirement.`);
    }
    const requirement = matches[0];
    const deliveries = Array.isArray(requirement.contents)
      ? requirement.contents.map((content) => record(content, 'Engine catalog content'))
      : [requirement];
    for (const delivery of deliveries) {
      const workers = (Array.isArray(delivery.artifacts) ? delivery.artifacts : [])
        .map((artifact) => record(artifact, 'Engine catalog artifact'))
        .filter((artifact) => artifact.role === 'worker');
      if (workers.length !== 1) {
        throw new Error(`Engine catalog ${requirementId} delivery must name exactly one worker.`);
      }
      const worker = workers[0];
      const parts = Array.isArray(worker.parts) && worker.parts.length > 0
        ? worker.parts.map((part) => record(part, 'Engine catalog worker part'))
        : [worker];
      for (const part of parts) files.push(workerFile(part));
    }
  }
  if (new Set(files.map((file) => file.fileName.toLowerCase())).size !== files.length) {
    throw new Error('Engine catalog names one worker file twice.');
  }
  return files;
}

/** Starts the mirror after every served file matched the catalog. */
export async function startReleaseWorkerMirror(
  options: ReleaseWorkerMirrorOptions,
): Promise<ReleaseWorkerMirror> {
  const directory = resolve(options.releaseDirectory);
  const catalogBytes = await readFile(join(directory, CATALOG_FILE_NAME)).catch(() => {
    throw new Error('The release directory holds no engine catalog.');
  });
  const catalogSha256 = sha256(catalogBytes);
  if (options.catalogSha256 !== undefined && catalogSha256 !== options.catalogSha256) {
    throw new Error('The release directory\'s engine catalog is not the verified one.');
  }
  let catalog: unknown;
  try {
    catalog = JSON.parse(catalogBytes.toString('utf8'));
  } catch {
    throw new Error('The release directory\'s engine catalog is not valid JSON.');
  }
  const files = catalogWorkerFiles(catalog, options.requirementIds);
  for (const file of files) {
    const path = join(directory, file.fileName);
    const metadata = await stat(path).catch(() => undefined);
    if (!metadata?.isFile() || metadata.size !== file.bytes || (await sha256File(path)) !== file.sha256) {
      throw new Error(`Worker file ${file.fileName} does not match the engine catalog.`);
    }
  }
  const served = new Map(files.map((file) => [`/${encodeURIComponent(file.fileName)}`, file]));

  let requestCount = 0;
  const sockets = new Set<net.Socket>();
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url === undefined) {
      response.writeHead(405).end();
      return;
    }
    let file: ReleaseWorkerFile | undefined;
    try {
      const parsed = new URL(request.url, 'http://127.0.0.1');
      file = parsed.search === '' && parsed.hash === '' ? served.get(parsed.pathname) : undefined;
    } catch {
      file = undefined;
    }
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    requestCount += 1;
    // Range requests get the whole file: the runtime's downloader then
    // streams it in one piece and verifies it against its own catalog.
    response.writeHead(200, {
      'Content-Length': file.bytes,
      'Content-Type': 'application/octet-stream',
      Connection: 'close',
    });
    const stream = createReadStream(join(directory, file.fileName));
    stream.once('error', () => response.destroy());
    response.once('close', () => stream.destroy());
    stream.pipe(response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  if (!port) {
    server.close();
    throw new Error('Release worker mirror did not expose a loopback port.');
  }

  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return requestCount;
    },
    catalogSha256,
    files,
    close: () => {
      closing ??= new Promise<void>((resolveClose) => {
        for (const socket of sockets) socket.destroy();
        server.closeIdleConnections();
        server.closeAllConnections();
        server.close(() => resolveClose());
      });
      return closing;
    },
  };
}

export interface ReviewRelease {
  readonly directory: string;
  readonly runtimeSha256: string;
}

/** The local release whose worker archives a baseline review serves. */
export function resolveReviewReleaseDirectory(workspaceRoot: string, environment: NodeJS.ProcessEnv): string {
  return resolve(
    environment.CAPTURE_REAL_DESKTOP_RELEASE_DIR?.trim()
      || join(workspaceRoot, 'packages', 'capture-runtime', 'dist', 'release'),
  );
}

/**
 * Checks that the packaged build starts the runtime of the local release a
 * baseline review serves: the runtime manifest beside the executable and the
 * release's own manifest name the same runtime bytes, so the worker archives
 * the review serves are the ones that runtime's catalog expects.
 */
export async function readReviewRelease(desktopExecutable: string, directory: string): Promise<ReviewRelease> {
  const packaged = await readRuntimeSha256(
    join(dirname(desktopExecutable), 'resources', 'capture-runtime-manifest.json'),
    'The packaged build\'s runtime manifest',
  );
  const release = await readRuntimeSha256(
    join(directory, 'capture-runtime-manifest.json'),
    'The local release\'s runtime manifest',
  );
  if (packaged !== release) {
    throw new Error(
      'The packaged build does not start the local release\'s runtime: stage that release with stage-runtime.ts --source release and build again.',
    );
  }
  return { directory, runtimeSha256: packaged };
}

async function readRuntimeSha256(path: string, label: string): Promise<string> {
  const bytes = await readFile(path).catch(() => {
    throw new Error(`${label} is missing.`);
  });
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  const digest = record(manifest, label).sha256;
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    throw new Error(`${label} names no runtime SHA-256.`);
  }
  return digest;
}

function workerFile(value: Record<string, unknown>): ReleaseWorkerFile {
  const { fileName, bytes, sha256: digest } = value;
  if (
    typeof fileName !== 'string' ||
    !FILE_NAME_PATTERN.test(fileName) ||
    fileName.includes('..') ||
    !Number.isSafeInteger(bytes) ||
    Number(bytes) <= 0 ||
    typeof digest !== 'string' ||
    !DIGEST_PATTERN.test(digest)
  ) {
    throw new Error('Engine catalog worker file is invalid.');
  }
  return { fileName, bytes: Number(bytes), sha256: digest };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', () => reject(new Error('A worker file could not be read.')));
    stream.once('end', () => resolveDigest(hash.digest('hex')));
  });
}
