import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        '--release-candidate',
        '--runtime-candidate',
        '--candidate-id',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --release-candidate <directory> --runtime-candidate <directory> --candidate-id <sha>.',
      );
    }
    values.set(name, value);
  }
  if (
    !values.has('--release-candidate') ||
    !values.has('--runtime-candidate') ||
    !/^[0-9a-f]{64}$/u.test(values.get('--candidate-id')!)
  ) {
    throw new Error(
      'Use --release-candidate <directory> --runtime-candidate <directory> --candidate-id <sha>.',
    );
  }
  return {
    releaseCandidate: resolve(values.get('--release-candidate')!),
    runtimeCandidate: resolve(values.get('--runtime-candidate')!),
    candidateId: values.get('--candidate-id')!,
  };
}

export async function verifyRuntimeCandidateBinding(input: {
  readonly releaseCandidate: string;
  readonly runtimeCandidate: string;
  readonly candidateId: string;
}): Promise<void> {
  const releaseManifest = JSON.parse(
    await readFile(
      join(input.releaseCandidate, 'candidate-manifest.json'),
      'utf8',
    ),
  ) as unknown;
  const runtimeManifest = JSON.parse(
    await readFile(
      join(input.runtimeCandidate, 'candidate-manifest.json'),
      'utf8',
    ),
  ) as unknown;
  assert(isRecord(releaseManifest) && isRecord(runtimeManifest));
  assert.equal(runtimeManifest.candidateId, input.candidateId);
  assert.equal(runtimeManifest.candidateKind, 'runtime');
  assert.equal(
    releaseManifest.runtimeCandidateId,
    input.candidateId,
    'Release Candidate does not reference the Runtime Candidate.',
  );
  assert.equal(releaseManifest.sourceCommit, runtimeManifest.sourceCommit);
  assert.equal(releaseManifest.releaseVersion, runtimeManifest.releaseVersion);
  assert.equal(releaseManifest.releaseMode, runtimeManifest.releaseMode);
  assert(Array.isArray(releaseManifest.artifacts));
  assert(Array.isArray(runtimeManifest.artifacts));
  const releaseArtifacts = new Map(
    releaseManifest.artifacts
      .filter(isRecord)
      .map((artifact) => [artifact.path, artifact] as const),
  );
  for (const artifact of runtimeManifest.artifacts.filter(isRecord)) {
    if (typeof artifact.path !== 'string') continue;
    const releaseArtifact = releaseArtifacts.get(artifact.path);
    if (
      !releaseArtifact ||
      releaseArtifact.sha256 !== artifact.sha256 ||
      releaseArtifact.bytes !== artifact.bytes
    ) {
      throw new Error(
        `Release Candidate runtime bytes differ: ${artifact.path}.`,
      );
    }
    assert.equal(
      await sha256(join(input.releaseCandidate, artifact.path)),
      artifact.sha256,
      `Release Candidate runtime digest is not self-consistent: ${artifact.path}.`,
    );
  }
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  await verifyRuntimeCandidateBinding(input);
  process.stdout.write(
    `Release Candidate is bound to Runtime Candidate ${input.candidateId}.\n`,
  );
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
