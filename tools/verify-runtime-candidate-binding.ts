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
        '--desktop-candidate',
        '--runtime-candidate',
        '--candidate-id',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --desktop-candidate <directory> --runtime-candidate <directory> --candidate-id <sha>.',
      );
    }
    values.set(name, value);
  }
  if (
    !values.has('--desktop-candidate') ||
    !values.has('--runtime-candidate') ||
    !/^[0-9a-f]{64}$/u.test(values.get('--candidate-id')!)
  ) {
    throw new Error(
      'Use --desktop-candidate <directory> --runtime-candidate <directory> --candidate-id <sha>.',
    );
  }
  return {
    desktopCandidate: resolve(values.get('--desktop-candidate')!),
    runtimeCandidate: resolve(values.get('--runtime-candidate')!),
    candidateId: values.get('--candidate-id')!,
  };
}

export async function verifyRuntimeCandidateBinding(input: {
  readonly desktopCandidate: string;
  readonly runtimeCandidate: string;
  readonly candidateId: string;
}): Promise<void> {
  const desktopManifest = JSON.parse(
    await readFile(
      join(input.desktopCandidate, 'candidate-manifest.json'),
      'utf8',
    ),
  ) as unknown;
  const runtimeManifest = JSON.parse(
    await readFile(
      join(input.runtimeCandidate, 'candidate-manifest.json'),
      'utf8',
    ),
  ) as unknown;
  assert(isRecord(desktopManifest) && isRecord(runtimeManifest));
  assert.equal(runtimeManifest.candidateId, input.candidateId);
  assert.equal(runtimeManifest.candidateKind, 'runtime');
  assert.equal(
    desktopManifest.runtimeCandidateId,
    input.candidateId,
    'Desktop Product Candidate does not reference the Runtime Candidate.',
  );
  assert.equal(desktopManifest.sourceCommit, runtimeManifest.sourceCommit);
  assert.equal(desktopManifest.releaseVersion, runtimeManifest.releaseVersion);
  assert.equal(desktopManifest.releaseMode, runtimeManifest.releaseMode);
  assert(Array.isArray(desktopManifest.artifacts));
  assert(Array.isArray(runtimeManifest.artifacts));
  const desktopArtifacts = new Map(
    desktopManifest.artifacts
      .filter(isRecord)
      .map((artifact) => [artifact.path, artifact] as const),
  );
  for (const artifact of runtimeManifest.artifacts.filter(isRecord)) {
    if (typeof artifact.path !== 'string') continue;
    const desktopArtifact = desktopArtifacts.get(artifact.path);
    if (
      !desktopArtifact ||
      desktopArtifact.sha256 !== artifact.sha256 ||
      desktopArtifact.bytes !== artifact.bytes
    ) {
      throw new Error(
        `Desktop candidate runtime bytes differ: ${artifact.path}.`,
      );
    }
    assert.equal(
      await sha256(join(input.desktopCandidate, artifact.path)),
      artifact.sha256,
      `Desktop candidate runtime digest is not self-consistent: ${artifact.path}.`,
    );
  }
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  await verifyRuntimeCandidateBinding(input);
  process.stdout.write(
    `Desktop candidate is bound to Runtime Candidate ${input.candidateId}.\n`,
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
