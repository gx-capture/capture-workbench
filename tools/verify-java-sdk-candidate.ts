import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type RecordValue = Record<string, unknown>;
const ARTIFACTS = [
  'maven/capture-runtime-client-{version}.jar',
  'maven/capture-runtime-client-{version}-sources.jar',
  'maven/pom.xml',
  'maven/capture-runtime-contract-set.sha256',
];

function record(value: unknown, label: string): RecordValue {
  assert.equal(typeof value, 'object', `${label} must be an object.`);
  assert(
    value !== null && !Array.isArray(value),
    `${label} must be an object.`,
  );
  return value as RecordValue;
}
function keys(
  value: RecordValue,
  expected: readonly string[],
  label: string,
): void {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} fields are not canonical.`,
  );
}
async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export async function verifyJavaSdkCandidate(input: {
  candidate: string;
  version: string;
  sourceCommit: string;
  candidateId: string;
  candidateManifestSha256: string;
  contractSetSha256: string;
  releaseCandidateId?: string;
  requireLedger?: boolean;
}): Promise<RecordValue> {
  assert.match(input.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  assert.match(input.sourceCommit, /^(?:local|[0-9a-f]{40})$/u);
  assert.match(input.candidateId, /^[0-9a-f]{64}$/u);
  assert.match(input.candidateManifestSha256, /^[0-9a-f]{64}$/u);
  assert.match(input.contractSetSha256, /^[0-9a-f]{64}$/u);
  const manifestPath = join(
    resolve(input.candidate),
    'java-candidate-manifest.json',
  );
  const manifestBytes = await readFile(manifestPath);
  assert.equal(
    await digest(manifestPath),
    input.candidateManifestSha256,
    'Java candidate manifest digest differs.',
  );
  const manifest = record(
    JSON.parse(manifestBytes.toString('utf8')),
    'Java candidate manifest',
  );
  keys(
    manifest,
    [
      'artifacts',
      'candidateId',
      'candidateKind',
      'contractSetSha256',
      'coordinates',
      'producerRunId',
      'releaseVersion',
      'schemaVersion',
      'sourceCommit',
      'toolchains',
    ],
    'Java candidate manifest',
  );
  assert.equal(manifest.schemaVersion, '1');
  assert.equal(manifest.candidateKind, 'maven-java-sdk');
  assert.equal(manifest.candidateId, input.candidateId);
  assert.equal(manifest.sourceCommit, input.sourceCommit);
  assert.equal(manifest.releaseVersion, input.version);
  assert.equal(
    manifest.contractSetSha256,
    input.contractSetSha256,
    'Java candidate contract-set hash differs from the requested release hash.',
  );
  const base = { ...manifest };
  delete base.candidateId;
  assert.equal(
    createHash('sha256').update(JSON.stringify(base)).digest('hex'),
    input.candidateId,
    'Java candidate ID is not bound to its manifest.',
  );
  const coordinates = record(manifest.coordinates, 'Java coordinates');
  keys(coordinates, ['artifactId', 'groupId', 'packaging'], 'Java coordinates');
  assert.deepEqual(coordinates, {
    groupId: 'com.gx.capture',
    artifactId: 'capture-runtime-client',
    packaging: 'jar',
  });
  assert(
    Array.isArray(manifest.artifacts),
    'Java candidate artifacts must be an array.',
  );
  const expected = new Set(
    ARTIFACTS.map((path) => path.replace('{version}', input.version)),
  );
  const actual = new Set<string>();
  for (const itemValue of manifest.artifacts) {
    const item = record(itemValue, 'Java candidate artifact');
    keys(item, ['bytes', 'path', 'sha256'], 'Java candidate artifact');
    const path = String(item.path);
    actual.add(path);
    assert(expected.has(path), `Unexpected Java candidate artifact: ${path}.`);
    const absolute = join(input.candidate, path);
    const metadata = await stat(absolute);
    assert(
      metadata.isFile(),
      `Java candidate artifact is not a file: ${path}.`,
    );
    assert.equal(
      metadata.size,
      item.bytes,
      `Java candidate artifact size differs: ${path}.`,
    );
    assert.equal(
      await digest(absolute),
      item.sha256,
      `Java candidate artifact digest differs: ${path}.`,
    );
    const checksum = await readFile(
      join(
        input.candidate,
        'checksums',
        `${path.replaceAll('/', '__')}.sha256`,
      ),
      'utf8',
    );
    assert.equal(checksum.trim(), `${item.sha256}  ${path}`);
  }
  assert.deepEqual(
    actual,
    expected,
    'Java candidate artifact inventory differs.',
  );
  assert.equal(
    (
      await readFile(
        join(input.candidate, 'maven/capture-runtime-contract-set.sha256'),
        'utf8',
      )
    ).trim(),
    input.contractSetSha256,
    'Java candidate embedded contract-set hash differs.',
  );
  if (input.requireLedger) {
    const ledger = record(
      JSON.parse(
        await readFile(join(input.candidate, 'maven-ledger.json'), 'utf8'),
      ),
      'Maven publication ledger',
    );
    keys(
      ledger,
      [
        'candidateId',
        'contractSetSha256',
        'registry',
        'releaseCandidateId',
        'releaseVersion',
        'schemaVersion',
        'sourceCandidateManifestSha256',
        'status',
      ],
      'Maven publication ledger',
    );
    assert.equal(ledger.schemaVersion, '1');
    assert.equal(ledger.registry, 'maven');
    assert.equal(ledger.status, 'published');
    assert.equal(ledger.candidateId, input.candidateId);
    assert.equal(
      ledger.releaseCandidateId,
      input.releaseCandidateId ?? input.candidateId,
    );
    assert.equal(ledger.releaseVersion, input.version);
    assert.equal(ledger.contractSetSha256, input.contractSetSha256);
    assert.match(
      String(ledger.sourceCandidateManifestSha256),
      /^[0-9a-f]{64}$/u,
    );
  }
  return manifest;
}

async function main(): Promise<void> {
  const values = new Map<string, string>();
  let requireLedger = false;
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i];
    if (key === '--require-ledger') {
      requireLedger = true;
      i -= 1;
      continue;
    }
    const value = raw[i + 1];
    if (
      ![
        '--candidate',
        '--version',
        '--source-commit',
        '--candidate-id',
        '--candidate-manifest-sha256',
        '--contract-set-sha256',
        '--release-candidate-id',
      ].includes(key) ||
      !value ||
      values.has(key)
    )
      throw new Error('Java candidate verification arguments are invalid.');
    values.set(key, value);
  }
  const required = [
    '--candidate',
    '--version',
    '--source-commit',
    '--candidate-id',
    '--candidate-manifest-sha256',
    '--contract-set-sha256',
  ];
  if (required.some((key) => !values.has(key)))
    throw new Error('Java candidate verification arguments are incomplete.');
  await verifyJavaSdkCandidate({
    candidate: values.get('--candidate')!,
    version: values.get('--version')!,
    sourceCommit: values.get('--source-commit')!,
    candidateId: values.get('--candidate-id')!,
    candidateManifestSha256: values.get('--candidate-manifest-sha256')!,
    contractSetSha256: values.get('--contract-set-sha256')!,
    releaseCandidateId: values.get('--release-candidate-id'),
    requireLedger,
  });
  process.stdout.write('Verified Maven Java SDK candidate.\n');
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
