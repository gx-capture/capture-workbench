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
        '--package-candidate',
        '--candidate-id',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --release-candidate <directory> --package-candidate <directory> --candidate-id <sha>.',
      );
    }
    values.set(name, value);
  }
  if (
    !values.has('--release-candidate') ||
    !values.has('--package-candidate') ||
    !/^[0-9a-f]{64}$/u.test(values.get('--candidate-id')!)
  ) {
    throw new Error(
      'Use --release-candidate <directory> --package-candidate <directory> --candidate-id <sha>.',
    );
  }
  return {
    releaseCandidate: resolve(values.get('--release-candidate')!),
    packageCandidate: resolve(values.get('--package-candidate')!),
    candidateId: values.get('--candidate-id')!,
  };
}

export async function verifyPackageCandidateBinding(input: {
  readonly releaseCandidate: string;
  readonly packageCandidate: string;
  readonly candidateId: string;
}): Promise<void> {
  const releaseManifest = JSON.parse(
    await readFile(
      join(input.releaseCandidate, 'candidate-manifest.json'),
      'utf8',
    ),
  ) as unknown;
  const packageManifest = JSON.parse(
    await readFile(
      join(input.packageCandidate, 'candidate-manifest.json'),
      'utf8',
    ),
  ) as unknown;
  if (!isRecord(releaseManifest) || !isRecord(packageManifest)) {
    throw new Error('Release and package candidate manifests must be objects.');
  }
  if (packageManifest.candidateId !== input.candidateId) {
    throw new Error('Package candidate ID does not match the binding input.');
  }
  if (
    packageManifest.candidateKind !== 'package' &&
    packageManifest.candidateKind !== 'npm-package-set'
  ) {
    throw new Error('Binding input must be a Package Candidate.');
  }
  if (releaseManifest.packageCandidateId !== input.candidateId) {
    throw new Error(
      'Release Candidate does not reference the Package Candidate.',
    );
  }
  if (
    releaseManifest.sourceCommit !== packageManifest.sourceCommit ||
    releaseManifest.releaseVersion !== packageManifest.releaseVersion
  ) {
    throw new Error(
      'Release and package candidates do not share source commit and release version.',
    );
  }
  if (
    !Array.isArray(releaseManifest.artifacts) ||
    !Array.isArray(packageManifest.artifacts)
  ) {
    throw new Error(
      'Release and package candidate artifact inventories are invalid.',
    );
  }
  const releaseArtifacts = new Map(
    releaseManifest.artifacts
      .filter(isRecord)
      .map((artifact) => [artifact.path, artifact] as const),
  );
  for (const artifact of packageManifest.artifacts.filter(isRecord)) {
    if (
      typeof artifact.path !== 'string' ||
      !artifact.path.startsWith('package/')
    )
      continue;
    const releaseArtifact = releaseArtifacts.get(artifact.path);
    if (
      !releaseArtifact ||
      releaseArtifact.sha256 !== artifact.sha256 ||
      releaseArtifact.bytes !== artifact.bytes
    ) {
      throw new Error(
        `Release Candidate package bytes differ: ${artifact.path}.`,
      );
    }
    if (
      (await sha256(join(input.releaseCandidate, artifact.path))) !==
      artifact.sha256
    ) {
      throw new Error(
        `Release Candidate package digest is not self-consistent: ${artifact.path}.`,
      );
    }
  }
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  await verifyPackageCandidateBinding(input);
  process.stdout.write(
    `Release Candidate is bound to Package Candidate ${input.candidateId}.\n`,
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
