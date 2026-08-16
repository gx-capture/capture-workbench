import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} fields are not canonical.`,
  );
}

function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  let requireEvidence = false;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (name === '--require-evidence') {
      if (index !== args.length - 1)
        throw new Error('Use --require-evidence without a value.');
      requireEvidence = true;
      continue;
    }
    const value = args[index + 1];
    if (
      ![
        '--candidate',
        '--version',
        '--source-commit',
        '--producer-run-id',
        '--candidate-id',
        '--candidate-manifest-sha256',
        '--package-candidate-id',
        '--contract-set-sha256',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Runtime candidate identity arguments are invalid or incomplete.',
      );
    }
    values.set(name, value);
  }
  const producerRunId = Number(values.get('--producer-run-id'));
  const version = values.get('--version');
  const hex64 = (value: string | undefined) =>
    Boolean(value && /^[0-9a-f]{64}$/u.test(value));
  if (
    !values.has('--candidate') ||
    !version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    !/^[0-9a-f]{40}$/u.test(values.get('--source-commit') ?? '') ||
    !Number.isSafeInteger(producerRunId) ||
    producerRunId < 1 ||
    !hex64(values.get('--candidate-id')) ||
    !hex64(values.get('--candidate-manifest-sha256')) ||
    !hex64(values.get('--package-candidate-id')) ||
    !hex64(values.get('--contract-set-sha256'))
  ) {
    throw new Error('Runtime candidate identity arguments are invalid.');
  }
  return {
    candidate: resolve(values.get('--candidate')!),
    version,
    sourceCommit: values.get('--source-commit')!,
    producerRunId,
    candidateId: values.get('--candidate-id')!,
    candidateManifestSha256: values.get('--candidate-manifest-sha256')!,
    packageCandidateId: values.get('--package-candidate-id')!,
    contractSetSha256: values.get('--contract-set-sha256')!,
    requireEvidence,
  };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function collectFiles(
  root: string,
  directory: string,
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectFiles(root, path)));
    else if (entry.isFile()) result.push(path.replaceAll('\\', '/'));
    else
      throw new Error(`Runtime candidate contains a non-file entry: ${path}.`);
  }
  return result;
}

export async function verifyRuntimeCandidate(input: {
  readonly candidate: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly producerRunId: number;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly packageCandidateId: string;
  readonly contractSetSha256: string;
  readonly requireEvidence?: boolean;
}): Promise<void> {
  const manifestPath = join(input.candidate, 'candidate-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  assert.equal(
    createHash('sha256').update(manifestBytes).digest('hex'),
    input.candidateManifestSha256,
    'Runtime candidate manifest digest differs.',
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  assert(isRecord(manifest), 'Runtime candidate manifest must be an object.');
  exactKeys(
    manifest,
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
  assert.equal(manifest.schemaVersion, '1');
  assert.equal(manifest.candidateKind, 'runtime');
  assert.equal(manifest.candidateId, input.candidateId);
  assert.equal(manifest.packageCandidateId, input.packageCandidateId);
  assert.match(String(manifest.contractSetSha256), /^[0-9a-f]{64}$/u);
  assert.equal(manifest.sourceCommit, input.sourceCommit);
  assert.equal(manifest.releaseVersion, input.version);
  assert.equal(manifest.producerRunId, input.producerRunId);
  assert.match(String(manifest.releaseMode), /^(?:core-only|model-enabled)$/u);
  assert(Array.isArray(manifest.artifacts));

  const baseManifest = { ...manifest } as JsonRecord;
  delete baseManifest.candidateId;
  assert.equal(
    createHash('sha256').update(JSON.stringify(baseManifest)).digest('hex'),
    input.candidateId,
    'Runtime candidate ID is not bound to its manifest.',
  );

  const runtimeManifest = JSON.parse(
    await readFile(
      join(input.candidate, 'runtime', 'capture-runtime-manifest.json'),
      'utf8',
    ),
  ) as JsonRecord;
  const schemaPath = join(
    input.candidate,
    'runtime',
    'capture-document-v2.schema.json',
  );
  const schemaDigest = await sha256(schemaPath);
  assert.equal(runtimeManifest.runtimeVersion, input.version);
  assert.equal(
    runtimeManifest.schemaFileName,
    'capture-document-v2.schema.json',
  );
  assert.equal(runtimeManifest.schemaSha256, schemaDigest);
  const catalog = JSON.parse(
    await readFile(
      join(input.candidate, 'runtime', 'capture-engine-catalog.json'),
      'utf8',
    ),
  ) as JsonRecord;
  assert.equal(catalog.runtimeVersion, input.version);

  const expectedArtifacts = new Set(
    (
      await Promise.all(
        ['runtime', 'python', 'crate', 'contracts'].map((directory) =>
          collectFiles(input.candidate, directory),
        ),
      )
    ).flat(),
  );
  const actualArtifacts = new Set<string>();
  for (const item of manifest.artifacts) {
    assert(isRecord(item), 'Runtime candidate artifact is invalid.');
    exactKeys(item, ['bytes', 'path', 'sha256'], 'Runtime candidate artifact');
    assert(typeof item.path === 'string' && !item.path.includes('..'));
    actualArtifacts.add(item.path);
    const path = join(input.candidate, item.path);
    const metadata = await stat(path);
    assert(
      metadata.isFile(),
      `Runtime candidate artifact is not a file: ${item.path}.`,
    );
    assert.equal(metadata.size, item.bytes);
    assert.equal(await sha256(path), item.sha256);
    assert.equal(
      (
        await readFile(
          join(
            input.candidate,
            'checksums',
            `${item.path.replaceAll('/', '__')}.sha256`,
          ),
          'utf8',
        )
      ).trim(),
      `${item.sha256}  ${item.path}`,
    );
  }
  assert.deepEqual(actualArtifacts, expectedArtifacts);

  const runtimeFiles = [...expectedArtifacts].filter((path) =>
    path.startsWith('runtime/'),
  );
  assert(runtimeFiles.some((path) => path.endsWith('.exe')));
  assert(runtimeFiles.includes('runtime/capture-runtime-manifest.json'));
  assert(runtimeFiles.includes('runtime/capture-document-v2.schema.json'));
  assert(runtimeFiles.includes('runtime/capture-engine-catalog.json'));
  const contractSetSha256 = (
    await readFile(
      join(input.candidate, 'contracts', 'contract-set.sha256'),
      'utf8',
    )
  ).trim();
  assert.equal(manifest.contractSetSha256, contractSetSha256);
  assert.match(contractSetSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    contractSetSha256,
    input.contractSetSha256,
    'Runtime candidate contract-set SHA-256 differs from the requested identity.',
  );
  assert.equal(
    await sha256(join(input.candidate, 'contracts', 'contract-set.json')),
    contractSetSha256,
  );
  assert(
    [...expectedArtifacts].some((path) =>
      /^python\/capture_runtime_client-.*\.(?:whl|tar\.gz)$/u.test(path),
    ),
  );
  assert([...expectedArtifacts].some((path) => path.endsWith('.crate')));
  const snapshot = JSON.parse(
    await readFile(
      join(input.candidate, 'contracts', 'contract-snapshot.json'),
      'utf8',
    ),
  ) as JsonRecord;
  assert.equal(snapshot.schemaVersion, '1');

  if (input.requireEvidence) {
    const evidence = JSON.parse(
      await readFile(join(input.candidate, 'runtime-product.json'), 'utf8'),
    ) as unknown;
    assert(isRecord(evidence));
    exactKeys(
      evidence,
      ['candidateId', 'schemaVersion', 'status', 'verification'],
      'Runtime candidate evidence',
    );
    assert.equal(evidence.schemaVersion, '1');
    assert.equal(evidence.candidateId, input.candidateId);
    assert.equal(evidence.verification, 'runtime-product');
    assert.equal(evidence.status, 'success');
  }
}

async function main(): Promise<void> {
  await verifyRuntimeCandidate(parseArguments(process.argv.slice(2)));
  process.stdout.write('Verified runtime candidate.\n');
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
