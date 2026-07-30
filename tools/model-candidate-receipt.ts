import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const receiptVersion = '1';
const receiptFileName = 'model-candidate-receipt.json';
const maximumReceiptArchiveBytes = 8 * 1024 * 1024;
const allowedFutureSkewMs = 5 * 60 * 1000;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function parseJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseCanonicalJsonBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > maximumReceiptArchiveBytes) {
    throw new Error(`${label} exceeds the receipt size limit.`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value), 'utf8'))) {
    throw new Error(`${label} must be canonical UTF-8 JSON.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    throw new Error(`${label} fields are invalid.`);
  }
  return value;
}

function parsePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function modelManifestSummaries(catalog) {
  if (!Array.isArray(catalog?.requirements)) {
    throw new Error('Release catalog requirements are invalid.');
  }
  return catalog.requirements
    .map((requirement) => ({
      entryCount: requirement.modelFiles?.entryCount,
      extractedBytes: requirement.modelFiles?.extractedBytes,
      manifestSha256: requirement.modelFiles?.manifestSha256,
      requirementId: requirement.requirementId,
    }))
    .sort((left, right) =>
      left.requirementId.localeCompare(right.requirementId),
    );
}

function assertModelManifestEvidence(modelManifests) {
  if (!Array.isArray(modelManifests) || modelManifests.length !== 2) {
    throw new Error('Candidate receipt model manifest evidence is invalid.');
  }
  const identifiers = modelManifests.map((item) => {
    exactKeys(
      item,
      new Set([
        'entryCount',
        'extractedBytes',
        'manifestSha256',
        'requirementId',
      ]),
      'Candidate receipt model manifest',
    );
    return item.requirementId;
  });
  if (
    JSON.stringify(identifiers) !==
      JSON.stringify(['whisper-primary', 'windowsml-ocr']) ||
    modelManifests.some(
      (item) =>
        !/^[a-f0-9]{64}$/u.test(item.manifestSha256) ||
        !Number.isSafeInteger(item.entryCount) ||
        item.entryCount < 1 ||
        !Number.isSafeInteger(item.extractedBytes) ||
        item.extractedBytes < 1,
    )
  ) {
    throw new Error('Candidate receipt model manifest evidence is invalid.');
  }
}

export function selectTrustedRun(
  workflow,
  runsPayload,
  expected,
  { nowMs, maxAgeMs },
) {
  exactKeys(
    workflow,
    new Set(['id', 'path', 'state']),
    'Trusted workflow metadata',
  );
  if (
    workflow.path !== expected.workflowPath ||
    workflow.state !== 'active' ||
    !Number.isSafeInteger(workflow.id)
  ) {
    throw new Error('Trusted candidate workflow identity is invalid.');
  }
  if (
    !Array.isArray(runsPayload?.workflow_runs) ||
    runsPayload.total_count !== runsPayload.workflow_runs.length
  ) {
    throw new Error('Workflow run metadata is invalid.');
  }
  const qualifying = runsPayload.workflow_runs.filter((run) => {
    const created = Date.parse(run.created_at);
    const updated = Date.parse(run.updated_at);
    return (
      run.workflow_id === workflow.id &&
      run.path === expected.workflowPath &&
      run.event === 'workflow_dispatch' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.head_sha === expected.commitSha &&
      Number.isSafeInteger(run.id) &&
      Number.isFinite(created) &&
      Number.isFinite(updated) &&
      created >= nowMs - maxAgeMs &&
      created <= nowMs + allowedFutureSkewMs &&
      updated >= created &&
      updated <= nowMs + allowedFutureSkewMs
    );
  });
  if (qualifying.length !== 1) {
    throw new Error(
      `Expected exactly one fresh successful candidate run; found ${qualifying.length}.`,
    );
  }
  return { run: qualifying[0], workflow };
}

export function selectTrustedArtifact(
  artifactsPayload,
  expected,
  trustedRun,
  { nowMs },
) {
  if (
    !Array.isArray(artifactsPayload?.artifacts) ||
    artifactsPayload.total_count !== artifactsPayload.artifacts.length
  ) {
    throw new Error('Workflow artifact metadata is invalid.');
  }
  const qualifying = artifactsPayload.artifacts.filter((artifact) => {
    const created = Date.parse(artifact.created_at);
    const expires = Date.parse(artifact.expires_at);
    return (
      artifact.name === expected.artifactName &&
      artifact.expired === false &&
      Number.isSafeInteger(artifact.id) &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= maximumReceiptArchiveBytes &&
      typeof artifact.digest === 'string' &&
      /^sha256:[a-f0-9]{64}$/u.test(artifact.digest) &&
      artifact.workflow_run?.id === trustedRun.id &&
      artifact.workflow_run?.head_sha === expected.commitSha &&
      Number.isFinite(created) &&
      Number.isFinite(expires) &&
      created >= Date.parse(trustedRun.created_at) &&
      created <= nowMs + allowedFutureSkewMs &&
      expires > nowMs
    );
  });
  if (qualifying.length !== 1) {
    throw new Error(
      `Expected exactly one non-expired candidate receipt artifact; found ${qualifying.length}.`,
    );
  }
  return qualifying[0];
}

export function assertArtifactDigest(serverDigest, archiveBytes) {
  const local = `sha256:${sha256Bytes(archiveBytes)}`;
  if (serverDigest !== local) {
    throw new Error('Downloaded receipt artifact does not match the server digest.');
  }
}

export function validateReceipt(receipt, expected, trusted) {
  exactKeys(
    receipt,
    new Set([
      'catalogSha256',
      'commitSha',
      'evidenceSha256',
      'modelManifests',
      'receiptVersion',
      'runId',
      'sourceLockSha256',
      'version',
      'workflowId',
      'workflowPath',
    ]),
    'Candidate receipt',
  );
  if (
    receipt.receiptVersion !== receiptVersion ||
    receipt.version !== expected.version ||
    receipt.commitSha !== expected.commitSha ||
    receipt.sourceLockSha256 !== expected.sourceLockSha256 ||
    receipt.workflowPath !== expected.workflowPath ||
    receipt.workflowId !== trusted.workflow.id ||
    receipt.runId !== trusted.run.id ||
    !/^[a-f0-9]{64}$/u.test(receipt.catalogSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.evidenceSha256)
  ) {
    throw new Error('Candidate receipt identity or source binding is invalid.');
  }
  assertModelManifestEvidence(receipt.modelManifests);
  return receipt;
}

export function createReceipt(input) {
  if (!/^[a-f0-9]{40}$/u.test(input.commitSha)) {
    throw new Error('Receipt commit must be a full lowercase Git SHA.');
  }
  const sourceLockSha256 = sha256File(input.sourceLock);
  const sourceLock = parseJsonFile(input.sourceLock);
  const catalog = parseJsonFile(input.catalog);
  const evidence = parseJsonFile(input.evidence);
  const fixtures = new Map(
    sourceLock?.fixtures?.map((fixture) => [fixture.kind, fixture]) ?? [],
  );
  const evidenceRequirements = evidence?.requirements;
  if (
    catalog?.catalogVersion !== '2' ||
    catalog?.runtimeVersion !== input.version ||
    evidence?.evidenceVersion !== '1' ||
    evidence?.sourceLockSha256 !== sourceLockSha256 ||
    evidence?.catalogSha256 !== sha256File(input.catalog) ||
    !Array.isArray(evidenceRequirements) ||
    JSON.stringify(
      evidenceRequirements.map((item) => item.requirementId).sort(),
    ) !== JSON.stringify(['whisper-primary', 'windowsml-ocr']) ||
    fixtures.size !== 2
  ) {
    throw new Error('Real model candidate evidence is incomplete or inconsistent.');
  }
  for (const item of evidenceRequirements) {
    exactKeys(
      item,
      new Set([
        'assertionsPassed',
        'device',
        'digest',
        'engine',
        'fixtureSha256',
        'model',
        'normalizedTextSha256',
        'requirementId',
        'segmentCount',
      ]),
      'Real model candidate requirement evidence',
    );
    const fixtureKind =
      item.requirementId === 'windowsml-ocr' ? 'ocr' : 'whisper';
    const fixture = fixtures.get(fixtureKind);
    if (
      item.assertionsPassed !== true ||
      item.engine !== fixture?.expectedEngine ||
      item.model !== fixture?.expectedModel ||
      item.device !== fixture?.expectedDevice ||
      item.fixtureSha256 !== fixture?.sha256 ||
      item.normalizedTextSha256 !==
        sha256Bytes(Buffer.from(fixture?.expectedText ?? '', 'utf8')) ||
      !Number.isSafeInteger(item.segmentCount) ||
      item.segmentCount < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.digest)
    ) {
      throw new Error('Real model candidate evidence is incomplete or inconsistent.');
    }
  }
  const modelManifests = modelManifestSummaries(catalog);
  if (
    catalog.requirements.some(
      (requirement) =>
        requirement.modelFiles?.sourceLockSha256 !== sourceLockSha256,
    )
  ) {
    throw new Error('Real model candidate catalog is not bound to the source lock.');
  }
  const receipt = {
    catalogSha256: sha256File(input.catalog),
    commitSha: input.commitSha,
    evidenceSha256: sha256File(input.evidence),
    modelManifests,
    receiptVersion,
    runId: parsePositiveInteger(Number(input.runId), 'runId'),
    sourceLockSha256,
    version: input.version,
    workflowId: parsePositiveInteger(Number(input.workflowId), 'workflowId'),
    workflowPath: input.workflowPath,
  };
  validateReceipt(
    receipt,
    {
      commitSha: input.commitSha,
      sourceLockSha256,
      version: input.version,
      workflowPath: input.workflowPath,
    },
    {
      run: { id: receipt.runId },
      workflow: { id: receipt.workflowId },
    },
  );
  writeFileSync(input.output, canonicalJson(receipt), {
    encoding: 'utf8',
    flag: 'wx',
  });
  return receipt;
}

export function assertCatalogMatchesReceipt(receiptPath, catalogPath) {
  const receipt = parseCanonicalJsonBytes(
    readFileSync(receiptPath),
    'Candidate receipt',
  );
  exactKeys(
    receipt,
    new Set([
      'catalogSha256',
      'commitSha',
      'evidenceSha256',
      'modelManifests',
      'receiptVersion',
      'runId',
      'sourceLockSha256',
      'version',
      'workflowId',
      'workflowPath',
    ]),
    'Candidate receipt',
  );
  const catalog = parseJsonFile(catalogPath);
  assertModelManifestEvidence(receipt.modelManifests);
  const rebuiltModelManifests = modelManifestSummaries(catalog);
  assertModelManifestEvidence(rebuiltModelManifests);
  if (
    receipt.receiptVersion !== receiptVersion ||
    !/^[a-f0-9]{64}$/u.test(receipt.catalogSha256) ||
    !/^[a-f0-9]{64}$/u.test(receipt.sourceLockSha256) ||
    catalog?.catalogVersion !== '2' ||
    catalog?.runtimeVersion !== receipt.version ||
    catalog.requirements.some(
      (requirement) =>
        requirement.modelFiles?.sourceLockSha256 !==
        receipt.sourceLockSha256,
    ) ||
    JSON.stringify(rebuiltModelManifests) !==
      JSON.stringify(receipt.modelManifests)
  ) {
    throw new Error(
      'Rebuilt release catalog model bindings do not match the trusted model candidate.',
    );
  }
}

function run(command, args, { encoding = 'utf8' } = {}) {
  const childEnvironment = { ...process.env };
  if (command !== 'gh') {
    for (const name of [
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'NODE_AUTH_TOKEN',
    ]) {
      delete childEnvironment[name];
    }
  }
  const result = spawnSync(command, args, {
    encoding,
    env: childEnvironment,
    maxBuffer: maximumReceiptArchiveBytes,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error?.code === 'ENOBUFS') {
    throw new Error(`${command} output exceeds the receipt size limit.`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${String(result.stderr).slice(-1000)}`,
    );
  }
  return result.stdout;
}

function ghJson(endpoint) {
  return JSON.parse(run('gh', ['api', endpoint]));
}

export function assertCanonicalReceiptArchiveListing(listing) {
  if (typeof listing !== 'string') {
    throw new Error('Receipt artifact entry listing is invalid.');
  }
  const entries = listing
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0);
  if (
    entries.length !== 1 ||
    entries[0] !== receiptFileName ||
    entries[0].includes('/') ||
    entries[0].includes('\\') ||
    entries[0].includes('..')
  ) {
    throw new Error(
      'Receipt artifact must contain exactly the canonical receipt file.',
    );
  }
}

export function assertRegularReceiptArchiveEntry(verboseListing) {
  if (typeof verboseListing !== 'string') {
    throw new Error('Receipt artifact entry metadata is invalid.');
  }
  const entries = verboseListing
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0);
  if (
    entries.length !== 1 ||
    !entries[0].startsWith('-') ||
    !entries[0].endsWith(` ${receiptFileName}`)
  ) {
    throw new Error('Candidate receipt archive entry must be a regular file.');
  }
}

export function readCanonicalReceiptArchive(archivePath) {
  const metadata = lstatSync(archivePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumReceiptArchiveBytes
  ) {
    throw new Error('Candidate receipt archive must be a bounded regular file.');
  }
  assertCanonicalReceiptArchiveListing(run('tar', ['-tf', archivePath]));
  assertRegularReceiptArchiveEntry(run('tar', ['-tvf', archivePath]));
  const receiptBytes = run(
    'tar',
    ['-xOf', archivePath, receiptFileName],
    { encoding: null },
  );
  return parseCanonicalJsonBytes(receiptBytes, 'Candidate receipt');
}

function parseArguments(args) {
  const [operation, ...pairs] = args;
  const values = new Map();
  for (let index = 0; index < pairs.length; index += 2) {
    if (!pairs[index]?.startsWith('--') || !pairs[index + 1]) {
      throw new Error('Receipt arguments must be complete --name value pairs.');
    }
    if (values.has(pairs[index])) {
      throw new Error(`Duplicate receipt argument: ${pairs[index]}.`);
    }
    values.set(pairs[index], pairs[index + 1]);
  }
  return { operation, values };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}.`);
  return value;
}

function resolveReceipt(values) {
  const repository = required(values, '--repository');
  const version = required(values, '--version');
  const commitSha = required(values, '--commit');
  const workflowPath = required(values, '--workflow-path');
  const sourceLock = resolve(required(values, '--source-lock'));
  const outputDirectory = resolve(required(values, '--output-dir'));
  const maxAgeHours = Number(required(values, '--max-age-hours'));
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 168) {
    throw new Error('Receipt max age must be from 0 through 168 hours.');
  }
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) {
    throw new Error('Receipt commit must be a full lowercase Git SHA.');
  }
  const expected = {
    artifactName: `capture-model-receipt-v${version}-${commitSha}`,
    commitSha,
    sourceLockSha256: sha256File(sourceLock),
    version,
    workflowPath,
  };
  const encodedPath = encodeURIComponent(workflowPath);
  const workflowRaw = ghJson(
    `repos/${repository}/actions/workflows/${encodedPath}`,
  );
  const workflow = {
    id: workflowRaw.id,
    path: workflowRaw.path,
    state: workflowRaw.state,
  };
  const runs = ghJson(
    `repos/${repository}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&status=success&head_sha=${commitSha}&per_page=100`,
  );
  const nowMs = Date.now();
  const trusted = selectTrustedRun(workflow, runs, expected, {
    maxAgeMs: maxAgeHours * 60 * 60 * 1000,
    nowMs,
  });
  const artifacts = ghJson(
    `repos/${repository}/actions/runs/${trusted.run.id}/artifacts?per_page=100`,
  );
  const artifact = selectTrustedArtifact(
    artifacts,
    expected,
    trusted.run,
    { nowMs },
  );
  const archiveBytes = run(
    'gh',
    [
      'api',
      `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    ],
    { encoding: null },
  );
  assertArtifactDigest(artifact.digest, archiveBytes);
  const temporary = mkdtempSync(join(tmpdir(), 'capture-model-receipt-'));
  try {
    const archivePath = join(temporary, 'receipt.zip');
    writeFileSync(archivePath, archiveBytes, { flag: 'wx' });
    const receipt = validateReceipt(
      readCanonicalReceiptArchive(archivePath),
      expected,
      trusted,
    );
    if (existsSync(outputDirectory)) {
      throw new Error('Receipt output directory must not already exist.');
    }
    mkdirSync(outputDirectory, { recursive: false });
    const outputMetadata = lstatSync(outputDirectory);
    if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
      throw new Error('Receipt output directory must be a new regular directory.');
    }
    writeFileSync(
      join(outputDirectory, receiptFileName),
      canonicalJson(receipt),
      { encoding: 'utf8', flag: 'wx' },
    );
    writeFileSync(
      join(outputDirectory, 'verified-model-candidate-receipt.json'),
      canonicalJson({
        artifactCreatedAt: artifact.created_at,
        artifactDigest: artifact.digest,
        artifactExpiresAt: artifact.expires_at,
        artifactId: artifact.id,
        receiptSha256: sha256Bytes(Buffer.from(canonicalJson(receipt))),
        runCreatedAt: trusted.run.created_at,
        runId: trusted.run.id,
        runUpdatedAt: trusted.run.updated_at,
        verificationVersion: '1',
        workflowId: trusted.workflow.id,
        workflowPath,
      }),
      { encoding: 'utf8', flag: 'wx' },
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { operation, values } = parseArguments(process.argv.slice(2));
    if (operation === 'create') {
      createReceipt({
        catalog: resolve(required(values, '--catalog')),
        commitSha: required(values, '--commit'),
        evidence: resolve(required(values, '--evidence')),
        output: resolve(required(values, '--output')),
        runId: required(values, '--run-id'),
        sourceLock: resolve(required(values, '--source-lock')),
        version: required(values, '--version'),
        workflowId: required(values, '--workflow-id'),
        workflowPath: required(values, '--workflow-path'),
      });
    } else if (operation === 'resolve') {
      resolveReceipt(values);
    } else if (operation === 'verify-catalog') {
      assertCatalogMatchesReceipt(
        resolve(required(values, '--receipt')),
        resolve(required(values, '--catalog')),
      );
    } else {
      throw new Error(
        'Receipt operation must be create, resolve, or verify-catalog.',
      );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
