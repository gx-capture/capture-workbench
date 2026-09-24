import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PROJECT = 'capture-runtime-client';
const PACKAGE = 'capture_runtime_client';

type JsonRecord = Record<string, unknown>;

export type PythonCandidateIndexManifest = {
  readonly schemaVersion: '1';
  readonly candidateKind: 'python-candidate-index';
  readonly packageName: typeof PROJECT;
  readonly packageCandidateKind: string;
  readonly packageCandidateSchemaVersion: string;
  readonly packageCandidateManifestSha256: string;
  readonly packageCandidateId: string;
  readonly runtimeCandidateKind: string;
  readonly runtimeCandidateSchemaVersion: string;
  readonly runtimeCandidateManifestSha256: string;
  readonly runtimeCandidateId: string;
  readonly releaseVersion: string;
  readonly sourceCommit: string;
  readonly contractSetSha256: string;
  readonly distributions: readonly {
    readonly filename: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly indexFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly candidateId: string;
};

export type PythonCandidateIndexInput = {
  readonly packageCandidate: string;
  readonly runtimeCandidate: string;
  readonly output: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly contractSetSha256: string;
};

export type VerifyPythonCandidateIndexInput = {
  readonly index: string;
  readonly packageCandidate: string;
  readonly runtimeCandidate: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly packageCandidateId: string;
  readonly runtimeCandidateId: string;
  readonly contractSetSha256: string;
};

export type PythonCandidateIndexVerification = {
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly packageCandidateId: string;
  readonly runtimeCandidateId: string;
  readonly version: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSha(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && SHA256.test(value), `${label} is invalid.`);
}

function assertRelativePath(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && value.length > 0, `${label} is invalid.`);
  const normalized = value.replaceAll('\\', '/');
  assert(
    normalized === value &&
      !isAbsolute(value) &&
      !value.includes('..') &&
      !value.includes(':') &&
      !value.includes('\0'),
    `${label} must be a relative path.`,
  );
}

function canonicalRelativePath(value: string, label: string): string {
  assertRelativePath(value, label);
  const canonical = value.split('/').filter((part) => part !== '' && part !== '.').join('/');
  assert(canonical.length > 0 && canonical === value, `${label} contains alias segments.`);
  return canonical;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields are not canonical.`);
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function readJsonFile(path: string): Promise<JsonRecord> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  assert(isRecord(value), `JSON object expected: ${path}.`);
  return value;
}

function digestJson(value: JsonRecord): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readCandidateManifests(root: string): Promise<{
  readonly manifest: JsonRecord;
  readonly bytes: Buffer;
  readonly sha256: string;
}> {
  const path = join(resolve(root), 'candidate-manifest.json');
  const bytes = await readFile(path);
  const manifest = JSON.parse(bytes.toString('utf8')) as unknown;
  assert(isRecord(manifest), `Candidate manifest must be an object: ${path}.`);
  assertSha(manifest.candidateId, 'Candidate ID');
  const base = { ...manifest };
  delete base.candidateId;
  assert.equal(digestJson(base), manifest.candidateId, 'Candidate manifest ID is not bound to its contents.');
  return { manifest, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function assertCandidateIdentity(
  manifest: JsonRecord,
  expected: {
    readonly kind: string;
    readonly sourceCommit: string;
    readonly version: string;
    readonly contractSetSha256: string;
    readonly candidateId?: string;
    readonly packageCandidateId?: string;
  },
): void {
  assert.equal(manifest.candidateKind, expected.kind, 'Candidate kind differs.');
  assert.equal(manifest.schemaVersion, '1', 'Candidate schema version differs.');
  assert.equal(manifest.sourceCommit, expected.sourceCommit, 'Candidate source commit differs.');
  assert.equal(manifest.releaseVersion, expected.version, 'Candidate version differs.');
  assert.equal(manifest.contractSetSha256, expected.contractSetSha256, 'Candidate contract hash differs.');
  if (expected.candidateId !== undefined) assert.equal(manifest.candidateId, expected.candidateId, 'Candidate ID differs.');
  if (expected.packageCandidateId !== undefined) {
    assert.equal(manifest.packageCandidateId, expected.packageCandidateId, 'Runtime package candidate ID differs.');
  }
}

async function sourceDistributions(
  packageCandidate: string,
  version: string,
): Promise<readonly { readonly filename: string; readonly bytes: number; readonly sha256: string }[]> {
  const root = resolve(packageCandidate);
  const { manifest } = await readCandidateManifests(root);
  assertCandidateIdentity(manifest, {
    kind: 'npm-package-set',
    sourceCommit: String(manifest.sourceCommit),
    version,
    contractSetSha256: String(manifest.contractSetSha256),
    candidateId: String(manifest.candidateId),
  });
  const packageManifestPath = join(root, 'package-manifest.json');
  assert.equal(
    await sha256(packageManifestPath),
    manifest.packageManifestSha256,
    'Package manifest digest differs from the candidate manifest.',
  );
  const pythonDirectory = join(root, 'python');
  const names = (await readdir(pythonDirectory)).sort();
  assert.equal(names.length, 2, 'Package candidate must contain exactly two Python distributions.');
  const pattern = new RegExp(
    `^${PACKAGE}-${version.replaceAll('.', '\\.')}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`,
    'u',
  );
  assert(names.every((name) => pattern.test(name)), 'Python candidate filenames do not match the requested version.');
  assert.equal(names.filter((name) => extname(name) === '.whl').length, 1, 'Python candidate must contain one wheel.');
  assert.equal(names.filter((name) => name.endsWith('.tar.gz')).length, 1, 'Python candidate must contain one source archive.');
  const artifacts = new Map<string, JsonRecord>();
  assert(Array.isArray(manifest.artifacts), 'Package candidate artifact inventory is invalid.');
  for (const item of manifest.artifacts) {
    assert(isRecord(item), 'Package candidate artifact is invalid.');
    assert(typeof item.path === 'string', 'Package candidate artifact path is invalid.');
    const normalizedPath = canonicalRelativePath(item.path, 'Package candidate artifact path').toLowerCase();
    assert(!artifacts.has(normalizedPath), `Package candidate artifact inventory contains a duplicate path: ${item.path}.`);
    artifacts.set(normalizedPath, item);
  }
  return Promise.all(names.map(async (filename) => {
    const path = join(pythonDirectory, filename);
    const metadata = await lstat(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `Python candidate is not an immutable regular file: ${filename}.`);
    const digest = await sha256(path);
    const record = artifacts.get(`python/${filename}`.toLowerCase());
    assert(record, `Python distribution is missing from candidate inventory: ${filename}.`);
    assert.equal(record.bytes, metadata.size, `Python distribution size differs: ${filename}.`);
    assert.equal(record.sha256, digest, `Python distribution digest differs: ${filename}.`);
    return { filename, bytes: metadata.size, sha256: digest };
  }));
}

async function validateInputs(input: {
  readonly packageCandidate: string;
  readonly runtimeCandidate: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly contractSetSha256: string;
  readonly packageCandidateId?: string;
  readonly runtimeCandidateId?: string;
}): Promise<{
  readonly packageManifest: JsonRecord;
  readonly packageManifestSha256: string;
  readonly runtimeManifest: JsonRecord;
  readonly runtimeManifestSha256: string;
  readonly distributions: readonly { readonly filename: string; readonly bytes: number; readonly sha256: string }[];
}> {
  assert(COMMIT.test(input.sourceCommit), 'Source commit is invalid.');
  assert(SEMVER.test(input.version), 'Version is invalid.');
  assertSha(input.contractSetSha256, 'Contract-set hash');
  const packageCandidate = await readCandidateManifests(input.packageCandidate);
  const runtimeCandidate = await readCandidateManifests(input.runtimeCandidate);
  assertCandidateIdentity(packageCandidate.manifest, {
    kind: 'npm-package-set',
    sourceCommit: input.sourceCommit,
    version: input.version,
    contractSetSha256: input.contractSetSha256,
    candidateId: input.packageCandidateId ?? String(packageCandidate.manifest.candidateId),
  });
  assertCandidateIdentity(runtimeCandidate.manifest, {
    kind: 'runtime',
    sourceCommit: input.sourceCommit,
    version: input.version,
    contractSetSha256: input.contractSetSha256,
    candidateId: input.runtimeCandidateId ?? String(runtimeCandidate.manifest.candidateId),
    packageCandidateId: String(packageCandidate.manifest.candidateId),
  });
  const distributions = await sourceDistributions(input.packageCandidate, input.version);
  return {
    packageManifest: packageCandidate.manifest,
    packageManifestSha256: packageCandidate.sha256,
    runtimeManifest: runtimeCandidate.manifest,
    runtimeManifestSha256: runtimeCandidate.sha256,
    distributions,
  };
}

function htmlDocument(anchors: readonly { readonly href: string; readonly label: string }[]): string {
  return `<!doctype html>\n<html><body>\n${anchors
    .map(({ href, label }) => `<a href="${href}">${label}</a>`)
    .join('\n')}\n</body></html>\n`;
}

async function fileRecord(root: string, path: string): Promise<{ readonly path: string; readonly bytes: number; readonly sha256: string }> {
  const absolute = join(root, path);
  const metadata = await stat(absolute);
  assert(metadata.isFile(), `Expected a regular file: ${path}.`);
  return { path, bytes: metadata.size, sha256: await sha256(absolute) };
}

export async function assemblePythonCandidateIndex(input: PythonCandidateIndexInput): Promise<PythonCandidateIndexVerification> {
  const packageRoot = resolve(input.packageCandidate);
  const runtimeRoot = resolve(input.runtimeCandidate);
  const output = resolve(input.output);
  const validated = await validateInputs(input);
  await mkdir(output, { recursive: false });
  await mkdir(join(output, 'simple', PROJECT), { recursive: true });
  const projectDirectory = join(output, 'simple', PROJECT);
  for (const distribution of validated.distributions) {
    await cp(join(packageRoot, 'python', distribution.filename), join(projectDirectory, distribution.filename));
  }
  const projectIndex = htmlDocument(validated.distributions.map((distribution) => ({
    href: `${distribution.filename}#sha256=${distribution.sha256}`,
    label: distribution.filename,
  })));
  await writeFile(join(projectDirectory, 'index.html'), projectIndex, 'utf8');
  await writeFile(join(output, 'simple', 'index.html'), htmlDocument([{ href: `${PROJECT}/`, label: PROJECT }]), 'utf8');
  const indexFiles = await Promise.all([
    fileRecord(output, 'simple/index.html'),
    fileRecord(output, `simple/${PROJECT}/index.html`),
  ]);
  const baseManifest = {
    schemaVersion: '1',
    candidateKind: 'python-candidate-index',
    packageName: PROJECT,
    packageCandidateKind: String(validated.packageManifest.candidateKind),
    packageCandidateSchemaVersion: String(validated.packageManifest.schemaVersion),
    packageCandidateManifestSha256: validated.packageManifestSha256,
    packageCandidateId: String(validated.packageManifest.candidateId),
    runtimeCandidateKind: String(validated.runtimeManifest.candidateKind),
    runtimeCandidateSchemaVersion: String(validated.runtimeManifest.schemaVersion),
    runtimeCandidateManifestSha256: validated.runtimeManifestSha256,
    runtimeCandidateId: String(validated.runtimeManifest.candidateId),
    releaseVersion: input.version,
    sourceCommit: input.sourceCommit,
    contractSetSha256: input.contractSetSha256,
    distributions: validated.distributions,
    indexFiles,
  } as const;
  const candidateId = digestJson(baseManifest);
  const manifest = { ...baseManifest, candidateId };
  const manifestPath = join(output, 'candidate-index-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const candidateManifestSha256 = await sha256(manifestPath);
  await writeFile(
    `${manifestPath}.sha256`,
    `${candidateManifestSha256}  candidate-index-manifest.json\n`,
    'utf8',
  );
  // Keep an explicit read-only reference in the implementation so callers cannot
  // accidentally infer that the runtime candidate itself is copied into the index.
  assert(runtimeRoot.length > 0, 'Runtime candidate path is empty.');
  return {
    candidateId,
    candidateManifestSha256,
    packageCandidateId: String(validated.packageManifest.candidateId),
    runtimeCandidateId: String(validated.runtimeManifest.candidateId),
    version: input.version,
  };
}

async function allFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  await visit(root);
  return output.sort();
}

function anchors(content: string): readonly { readonly href: string; readonly label: string }[] {
  assert(!/(?:file:|https?:|[A-Za-z]:|\\|\.\.)/iu.test(content), 'Index contains an absolute or local path.');
  const result = [...content.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/gu)].map(([, href, label]) => ({
    href: href ?? '',
    label: label ?? '',
  }));
  assert(result.length > 0, 'Index contains no package links.');
  assert.equal(new Set(result.map((item) => item.href)).size, result.length, 'Index contains duplicate links.');
  return result;
}

function verifyProjectIndex(content: string, distributions: readonly { readonly filename: string; readonly bytes: number; readonly sha256: string }[]): void {
  const links = anchors(content);
  assert.equal(links.length, distributions.length, 'Project index distribution count differs.');
  const expected = distributions.map((distribution) => ({
    href: `${distribution.filename}#sha256=${distribution.sha256}`,
    label: distribution.filename,
  }));
  assert.deepEqual(links, expected, 'Project index links are not canonical.');
  for (const link of links) {
    assert(!link.href.includes('?'), 'Project index link contains a mutable query.');
    assert(!link.href.startsWith('/'), 'Project index link is not relative.');
    assert.match(link.href, /^capture_runtime_client-[^#]+\.(?:whl|tar\.gz)#sha256=[0-9a-f]{64}$/u);
  }
}

async function assertRegularFiles(root: string, expected: readonly string[]): Promise<void> {
  const actual = await allFiles(root);
  assert.deepEqual(actual, [...expected].sort(), 'Python candidate index inventory differs.');
  for (const path of actual) {
    const metadata = await lstat(join(root, path));
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `Python candidate index file is not immutable: ${path}.`);
  }
}

export async function verifyPythonCandidateIndex(input: VerifyPythonCandidateIndexInput): Promise<PythonCandidateIndexVerification> {
  const index = resolve(input.index);
  const validated = await validateInputs({
    packageCandidate: input.packageCandidate,
    runtimeCandidate: input.runtimeCandidate,
    sourceCommit: input.sourceCommit,
    version: input.version,
    contractSetSha256: input.contractSetSha256,
    packageCandidateId: input.packageCandidateId,
    runtimeCandidateId: input.runtimeCandidateId,
  });
  const distributionNames = validated.distributions.map((distribution) => distribution.filename);
  await assertRegularFiles(index, [
    'candidate-index-manifest.json',
    'candidate-index-manifest.json.sha256',
    'simple/index.html',
    `simple/${PROJECT}/index.html`,
    ...distributionNames.map((name) => `simple/${PROJECT}/${name}`),
  ]);
  const manifestPath = join(index, 'candidate-index-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  assert(isRecord(manifest), 'Python candidate index manifest must be an object.');
  exactKeys(manifest, [
    'candidateId',
    'candidateKind',
    'contractSetSha256',
    'distributions',
    'indexFiles',
    'packageCandidateId',
    'packageCandidateKind',
    'packageCandidateManifestSha256',
    'packageCandidateSchemaVersion',
    'packageName',
    'releaseVersion',
    'runtimeCandidateId',
    'runtimeCandidateKind',
    'runtimeCandidateManifestSha256',
    'runtimeCandidateSchemaVersion',
    'schemaVersion',
    'sourceCommit',
  ], 'Python candidate index manifest');
  assert.equal(manifest.candidateKind, 'python-candidate-index');
  assert.equal(manifest.schemaVersion, '1');
  assert.equal(manifest.packageName, PROJECT);
  assert.equal(manifest.packageCandidateKind, 'npm-package-set');
  assert.equal(manifest.packageCandidateSchemaVersion, '1');
  assert.equal(manifest.runtimeCandidateKind, 'runtime');
  assert.equal(manifest.runtimeCandidateSchemaVersion, '1');
  assert(typeof manifest.packageCandidateKind === 'string' && /^[a-z0-9][a-z0-9.-]*$/u.test(manifest.packageCandidateKind));
  assert(typeof manifest.runtimeCandidateKind === 'string' && /^[a-z0-9][a-z0-9.-]*$/u.test(manifest.runtimeCandidateKind));
  assert(typeof manifest.packageCandidateSchemaVersion === 'string' && /^[0-9]+$/u.test(manifest.packageCandidateSchemaVersion));
  assert(typeof manifest.runtimeCandidateSchemaVersion === 'string' && /^[0-9]+$/u.test(manifest.runtimeCandidateSchemaVersion));
  assert.equal(manifest.releaseVersion, input.version);
  assert.equal(manifest.sourceCommit, input.sourceCommit);
  assert.equal(manifest.packageCandidateId, input.packageCandidateId);
  assert.equal(manifest.runtimeCandidateId, input.runtimeCandidateId);
  assert.equal(manifest.contractSetSha256, input.contractSetSha256);
  assert.equal(manifest.packageCandidateManifestSha256, validated.packageManifestSha256);
  assert.equal(manifest.runtimeCandidateManifestSha256, validated.runtimeManifestSha256);
  assertSha(manifest.candidateId, 'Python candidate index ID');
  const base = { ...manifest };
  delete base.candidateId;
  assert.equal(digestJson(base), manifest.candidateId, 'Python candidate index ID is not bound to its contents.');
  assert.equal(
    (await readFile(`${manifestPath}.sha256`, 'utf8')).trim(),
    `${createHash('sha256').update(manifestBytes).digest('hex')}  candidate-index-manifest.json`,
    'Python candidate index manifest checksum differs.',
  );
  assert(Array.isArray(manifest.distributions), 'Python candidate index distributions are invalid.');
  assert.deepEqual(manifest.distributions, validated.distributions, 'Python distribution identity differs from the package candidate.');
  assert(Array.isArray(manifest.indexFiles), 'Python candidate index file inventory is invalid.');
  for (const item of manifest.indexFiles) {
    assert(isRecord(item), 'Python candidate index file record is invalid.');
    assertRelativePath(item.path, 'Python candidate index file path');
    assert.equal(item.path.startsWith('simple/'), true, 'Python candidate index file escapes simple root.');
    const actual = await fileRecord(index, item.path);
    assert.equal(item.bytes, actual.bytes, `Python candidate index file size differs: ${item.path}.`);
    assert.equal(item.sha256, actual.sha256, `Python candidate index file digest differs: ${item.path}.`);
  }
  assert.deepEqual(
    manifest.indexFiles,
    await Promise.all(['simple/index.html', `simple/${PROJECT}/index.html`].map((path) => fileRecord(index, path))),
    'Python candidate index file inventory is not canonical.',
  );
  verifyProjectIndex(await readFile(join(index, 'simple', PROJECT, 'index.html'), 'utf8'), validated.distributions);
  const rootLinks = anchors(await readFile(join(index, 'simple', 'index.html'), 'utf8'));
  assert.deepEqual(rootLinks, [{ href: `${PROJECT}/`, label: PROJECT }], 'Root PEP 503 index is not canonical.');
  for (const distribution of validated.distributions) {
    const path = join(index, 'simple', PROJECT, distribution.filename);
    assert.equal((await stat(path)).size, distribution.bytes, `Indexed distribution size differs: ${distribution.filename}.`);
    assert.equal(await sha256(path), distribution.sha256, `Indexed distribution digest differs: ${distribution.filename}.`);
  }
  return {
    candidateId: String(manifest.candidateId),
    candidateManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    packageCandidateId: input.packageCandidateId,
    runtimeCandidateId: input.runtimeCandidateId,
    version: input.version,
  };
}

function pythonExecutable(venv: string): string {
  return process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
}

async function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync(command, [...args], { cwd, env, maxBuffer: 1024 * 1024 * 8 });
  return result.stdout.trim();
}

export async function runPythonCandidateIndexHttpSmoke(input: {
  readonly index: string;
  readonly version: string;
}): Promise<{
  readonly url: string;
  readonly pipVersion: string;
  readonly poetryInstalledVersion: string;
  readonly poetryLockContainsLoopbackSource: boolean;
  readonly directUrlFiles: readonly string[];
  readonly poetryDirectUrlFiles: readonly string[];
  readonly poetryWheelSha256: string;
  readonly tempCleanupVerified: boolean;
  readonly requestCounts: Readonly<Record<string, number>>;
}> {
  const root = resolve(input.index);
  await verifyIndexShapeWithoutSource(root, input.version);
  const indexManifest = await readJsonFile(join(root, 'candidate-index-manifest.json'));
  assert(Array.isArray(indexManifest.distributions), 'Python candidate index distributions are invalid.');
  const wheel = indexManifest.distributions.find(
    (item): item is JsonRecord => isRecord(item) && typeof item.filename === 'string' && item.filename.endsWith('.whl'),
  );
  assert(wheel && typeof wheel.filename === 'string', 'Python candidate index wheel is missing.');
  assertSha(wheel.sha256, 'Python candidate wheel hash');
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      countRequest(pathname);
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
        response.writeHead(403).end();
        return;
      }
      const metadata = await stat(path);
      const filePath = metadata.isDirectory() ? join(path, 'index.html') : path;
      const bytes = await readFile(filePath);
      response.writeHead(200, { 'content-type': filePath.endsWith('.html') ? 'text/html' : 'application/octet-stream' }).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert(address && typeof address !== 'string', 'HTTP smoke server did not bind.');
  const url = `http://127.0.0.1:${address.port}`;
  const requestCounts = new Map<string, number>();
  const countRequest = (pathname: string): void => {
    requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
  };
  const smokeRoot = await mkdtemp(join(tmpdir(), 'capture-python-index-smoke-'));
  const venv = join(smokeRoot, 'venv');
  const installTarget = join(smokeRoot, 'pip-install');
  const poetryProject = join(smokeRoot, 'poetry-project');
  let smokeResult: {
    readonly url: string;
    readonly pipVersion: string;
    readonly poetryInstalledVersion: string;
    readonly poetryLockContainsLoopbackSource: boolean;
    readonly directUrlFiles: readonly string[];
    readonly poetryDirectUrlFiles: readonly string[];
    readonly poetryWheelSha256: string;
    readonly requestCounts: Readonly<Record<string, number>>;
  } | undefined;
  try {
    const rootResponse = await fetch(`${url}/simple/`);
    assert.equal(rootResponse.status, 200, 'HTTP smoke could not read the simple root index.');
    await run('python', ['-m', 'venv', venv], smokeRoot);
    const executable = pythonExecutable(venv);
    await mkdir(installTarget, { recursive: true });
    const pipVersion = await run(executable, ['-m', 'pip', '--version'], smokeRoot);
    await run(executable, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps',
      '--isolated', '--no-cache-dir', '--index-url', `${url}/simple/`, '--target', installTarget,
      `${PROJECT}==${input.version}`,
    ], smokeRoot);
    const directUrlFiles = (await allFiles(installTarget)).filter((path) => path.endsWith('/direct_url.json') || path === 'direct_url.json');
    assert.equal(directUrlFiles.length, 0, 'pip wrote direct_url.json for an index installation.');
    const pipMetadata = JSON.parse(await run(executable, [
      '-c',
      'import importlib.metadata as m, importlib.util, json; d=m.distribution("capture-runtime-client"); s=importlib.util.find_spec("capture_runtime_client"); print(json.dumps({"version":d.version,"origin":s.origin if s else None}))',
    ], smokeRoot, { ...process.env, PYTHONPATH: installTarget })) as unknown;
    assert(isRecord(pipMetadata), 'pip installed distribution report is invalid.');
    assert.equal(pipMetadata.version, input.version, 'pip installed distribution version differs.');
    assert(typeof pipMetadata.origin === 'string' && pipMetadata.origin.startsWith(installTarget), 'pip import/spec path escaped the temporary target.');
    assert(!(await allFiles(installTarget)).some((path) => path.includes('0.4.1')), 'pip target contains stale 0.4.1 metadata.');
    await mkdir(poetryProject, { recursive: true });
    await writeFile(join(poetryProject, 'pyproject.toml'), [
      '[tool.poetry]',
      'name = "capture-index-smoke"',
      'version = "0.0.0"',
      'description = "Temporary candidate-index smoke project"',
      'authors = ["Capture Workbench <capture@example.invalid>"]',
      '',
      '[tool.poetry.dependencies]',
      'python = ">=3.12,<3.15"',
      `${PROJECT} = { version = "${input.version}", source = "capture-candidate" }`,
      '',
      '[[tool.poetry.source]]',
      'name = "capture-candidate"',
      `url = "${url}/simple/"`,
      'priority = "supplemental"',
      '',
    ].join('\n'), 'utf8');
    const poetryEnv = {
      ...process.env,
      POETRY_VIRTUALENVS_CREATE: 'true',
      POETRY_VIRTUALENVS_IN_PROJECT: 'true',
      POETRY_CACHE_DIR: join(smokeRoot, 'poetry-cache'),
      POETRY_INSTALLER_ONLY_BINARY: PROJECT,
    };
    await run('poetry', ['lock', '--no-interaction'], poetryProject, poetryEnv);
    await run('poetry', ['install', '--no-interaction', '--no-root'], poetryProject, poetryEnv);
    const poetryVenv = await run('poetry', ['env', 'info', '-p'], poetryProject, poetryEnv);
    assert(poetryVenv.length > 0, 'Poetry did not report its virtualenv.');
    assert(isAbsolute(poetryVenv), 'Poetry reported a relative virtualenv path.');
    assert.equal(resolve(poetryVenv), resolve(poetryProject, '.venv'), 'Poetry did not use the isolated in-project virtualenv.');
    const installedMetadata = JSON.parse(await run('poetry', [
      'run', 'python', '-c',
      'import json; from importlib.metadata import distributions; name="capture-runtime-client"; items=[d for d in distributions() if (d.metadata.get("Name") or "").lower().replace("_","-")==name]; print(json.dumps([{"name":d.metadata.get("Name"),"version":d.version,"direct_url":d.read_text("direct_url.json")} for d in items]))',
    ], poetryProject, poetryEnv)) as unknown;
    assert(Array.isArray(installedMetadata), 'Poetry installed distribution report is invalid.');
    assert.equal(installedMetadata.length, 1, 'Poetry installed more than one capture-runtime-client distribution.');
    const installed = installedMetadata[0];
    assert(isRecord(installed), 'Poetry installed distribution record is invalid.');
    assert.equal(installed.name, PROJECT, 'Poetry installed distribution name differs.');
    assert.equal(installed.version, input.version, 'Poetry installed distribution version differs.');
    assert.equal(installed.direct_url, null, 'Poetry wrote direct_url.json for an index installation.');
    const poetryVenvFiles = await allFiles(poetryVenv);
    const poetryDirectUrlFiles = poetryVenvFiles.filter((path) => path.endsWith('/direct_url.json') || path === 'direct_url.json');
    assert.equal(poetryDirectUrlFiles.length, 0, 'Poetry virtualenv contains direct_url.json.');
    const captureMetadata = poetryVenvFiles.filter((path) => /capture_runtime_client-[^/]+\.dist-info\/METADATA$/iu.test(path));
    assert.equal(captureMetadata.length, 1, 'Poetry virtualenv contains missing or duplicate capture-runtime-client metadata.');
    assert(
      captureMetadata[0]?.toLowerCase().replaceAll('\\', '/').includes('capture_runtime_client-0.4.2.dist-info/metadata'),
      'Poetry virtualenv contains stale capture-runtime-client metadata.',
    );
    const poetryCache = join(smokeRoot, 'poetry-cache');
    const cachedWheels = (await allFiles(poetryCache)).filter((path) => path.endsWith(`/${wheel.filename}`) || path === wheel.filename);
    assert(cachedWheels.length > 0, 'Poetry did not retain the candidate wheel provenance.');
    const firstCachedWheel = cachedWheels[0];
    assert(firstCachedWheel, 'Poetry candidate wheel cache entry is missing.');
    const poetryWheelSha256 = await sha256(join(poetryCache, firstCachedWheel));
    assert.equal(poetryWheelSha256, wheel.sha256, 'Poetry installed wheel provenance differs from the index manifest.');
    const lock = await readFile(join(poetryProject, 'poetry.lock'), 'utf8');
    assert(!lock.includes('0.4.1'), 'Poetry lock contains stale capture-runtime-client 0.4.1.');
    const expectedRequests = [
      '/simple/',
      `/simple/${PROJECT}/`,
      `/simple/${PROJECT}/${wheel.filename}`,
    ];
    for (const pathname of expectedRequests) {
      assert((requestCounts.get(pathname) ?? 0) > 0, `HTTP smoke did not request ${pathname}.`);
    }
    smokeResult = {
      url,
      pipVersion,
      poetryInstalledVersion: String(installed.version),
      poetryLockContainsLoopbackSource: lock.includes('127.0.0.1'),
      directUrlFiles,
      poetryDirectUrlFiles,
      poetryWheelSha256,
      requestCounts: Object.fromEntries(requestCounts),
    };
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(smokeRoot, { recursive: true, force: true });
    assert.equal(await pathExists(smokeRoot), false, 'HTTP smoke temporary root was not removed.');
  }
  assert(smokeResult, 'HTTP smoke did not produce a result.');
  return { ...smokeResult, tempCleanupVerified: true };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyIndexShapeWithoutSource(index: string, version: string): Promise<void> {
  const projectIndex = await readFile(join(index, 'simple', PROJECT, 'index.html'), 'utf8');
  const links = anchors(projectIndex);
  assert(links.length === 2, 'Python candidate index must expose wheel and source archive.');
  assert(links.every((link) => link.href.includes(`#sha256=`) && link.label.includes(version)), 'Python candidate index version is invalid.');
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--http-smoke') {
      if (values.has(name)) throw new Error('Arguments must be unique.');
      values.set(name, 'true');
      continue;
    }
    const value = args[index + 1];
    if (!name || !value || values.has(name)) throw new Error('Arguments must be unique name/value pairs.');
    values.set(name, value);
    index += 1;
  }
  return values;
}

function required(values: Map<string, string>, name: string, environment: string): string {
  const value = values.get(name) ?? process.env[environment];
  if (!value) throw new Error(`Missing ${name} (or ${environment}).`);
  return value;
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const mode = values.get('--mode') ?? 'assemble';
  if (mode === 'assemble') {
    const result = await assemblePythonCandidateIndex({
      packageCandidate: required(values, '--package-candidate', 'PYTHON_INDEX_PACKAGE_CANDIDATE'),
      runtimeCandidate: required(values, '--runtime-candidate', 'PYTHON_INDEX_RUNTIME_CANDIDATE'),
      output: required(values, '--output', 'PYTHON_INDEX_OUTPUT'),
      sourceCommit: required(values, '--source-commit', 'PYTHON_INDEX_SOURCE_COMMIT'),
      version: required(values, '--version', 'PYTHON_INDEX_VERSION'),
      contractSetSha256: required(values, '--contract-set-sha256', 'PYTHON_INDEX_CONTRACT_SET_SHA256'),
    });
    const output = required(values, '--output', 'PYTHON_INDEX_OUTPUT');
    const version = required(values, '--version', 'PYTHON_INDEX_VERSION');
    process.stdout.write(`Assembled Python candidate index ${result.version} (${result.candidateId}) at ${resolve(output)}.\n`);
    if (values.has('--http-smoke')) {
      const smoke = await runPythonCandidateIndexHttpSmoke({ index: output, version });
      process.stdout.write(`HTTP smoke passed: ${smoke.pipVersion}; poetryVersion=${smoke.poetryInstalledVersion}; pipDirectUrlFiles=${smoke.directUrlFiles.length}; poetryDirectUrlFiles=${smoke.poetryDirectUrlFiles.length}; poetryWheelSha256=${smoke.poetryWheelSha256}; poetryLoopbackSource=${smoke.poetryLockContainsLoopbackSource}; requests=${JSON.stringify(smoke.requestCounts)}; tempCleanup=${smoke.tempCleanupVerified}.\n`);
    }
    return;
  }
  if (mode === 'verify') {
    const result = await verifyPythonCandidateIndex({
      index: required(values, '--index', 'PYTHON_INDEX_OUTPUT'),
      packageCandidate: required(values, '--package-candidate', 'PYTHON_INDEX_PACKAGE_CANDIDATE'),
      runtimeCandidate: required(values, '--runtime-candidate', 'PYTHON_INDEX_RUNTIME_CANDIDATE'),
      sourceCommit: required(values, '--source-commit', 'PYTHON_INDEX_SOURCE_COMMIT'),
      version: required(values, '--version', 'PYTHON_INDEX_VERSION'),
      packageCandidateId: required(values, '--package-candidate-id', 'PYTHON_INDEX_PACKAGE_CANDIDATE_ID'),
      runtimeCandidateId: required(values, '--runtime-candidate-id', 'PYTHON_INDEX_RUNTIME_CANDIDATE_ID'),
      contractSetSha256: required(values, '--contract-set-sha256', 'PYTHON_INDEX_CONTRACT_SET_SHA256'),
    });
    process.stdout.write(`Verified Python candidate index ${result.version} (${result.candidateId}).\n`);
    if (values.has('--http-smoke')) {
      const smoke = await runPythonCandidateIndexHttpSmoke({ index: required(values, '--index', 'PYTHON_INDEX_OUTPUT'), version: required(values, '--version', 'PYTHON_INDEX_VERSION') });
      process.stdout.write(`HTTP smoke passed: ${smoke.pipVersion}; poetryVersion=${smoke.poetryInstalledVersion}; pipDirectUrlFiles=${smoke.directUrlFiles.length}; poetryDirectUrlFiles=${smoke.poetryDirectUrlFiles.length}; poetryWheelSha256=${smoke.poetryWheelSha256}; poetryLoopbackSource=${smoke.poetryLockContainsLoopbackSource}; requests=${JSON.stringify(smoke.requestCounts)}; tempCleanup=${smoke.tempCleanupVerified}.\n`);
    }
    return;
  }
  throw new Error(`Unsupported mode: ${mode}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
