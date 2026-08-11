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
        '--package-candidate',
        '--candidate-id',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --desktop-candidate <directory> --package-candidate <directory> --candidate-id <sha>.',
      );
    }
    values.set(name, value);
  }
  if (
    !values.has('--desktop-candidate') ||
    !values.has('--package-candidate') ||
    !/^[0-9a-f]{64}$/u.test(values.get('--candidate-id')!)
  ) {
    throw new Error(
      'Use --desktop-candidate <directory> --package-candidate <directory> --candidate-id <sha>.',
    );
  }
  return {
    desktopCandidate: resolve(values.get('--desktop-candidate')!),
    packageCandidate: resolve(values.get('--package-candidate')!),
    candidateId: values.get('--candidate-id')!,
  };
}

export async function verifyPackageCandidateBinding(input: {
  readonly desktopCandidate: string;
  readonly packageCandidate: string;
  readonly candidateId: string;
}): Promise<void> {
  const desktopManifest = JSON.parse(
    await readFile(
      join(input.desktopCandidate, 'candidate-manifest.json'),
      'utf8',
    ),
  ) as unknown;
  const packageManifest = JSON.parse(
    await readFile(
      join(input.packageCandidate, 'candidate-manifest.json'),
      'utf8',
    ),
  ) as unknown;
  if (!isRecord(desktopManifest) || !isRecord(packageManifest)) {
    throw new Error('Desktop and package candidate manifests must be objects.');
  }
  if (packageManifest.candidateId !== input.candidateId) {
    throw new Error('Package candidate ID does not match the binding input.');
  }
  if (packageManifest.candidateKind !== 'npm-package-set') {
    throw new Error('Binding input is not an npm Package Candidate.');
  }
  if (desktopManifest.packageCandidateId !== input.candidateId) {
    throw new Error(
      'Desktop Product Candidate does not reference the Package Candidate.',
    );
  }
  if (
    desktopManifest.sourceCommit !== packageManifest.sourceCommit ||
    desktopManifest.releaseVersion !== packageManifest.releaseVersion
  ) {
    throw new Error(
      'Desktop and package candidates do not share source commit and release version.',
    );
  }
  if (
    !Array.isArray(desktopManifest.artifacts) ||
    !Array.isArray(packageManifest.artifacts)
  ) {
    throw new Error(
      'Desktop and package candidate artifact inventories are invalid.',
    );
  }
  const desktopArtifacts = new Map(
    desktopManifest.artifacts
      .filter(isRecord)
      .map((artifact) => [artifact.path, artifact] as const),
  );
  for (const artifact of packageManifest.artifacts.filter(isRecord)) {
    if (
      typeof artifact.path !== 'string' ||
      !artifact.path.startsWith('package/')
    )
      continue;
    const desktopArtifact = desktopArtifacts.get(artifact.path);
    if (
      !desktopArtifact ||
      desktopArtifact.sha256 !== artifact.sha256 ||
      desktopArtifact.bytes !== artifact.bytes
    ) {
      throw new Error(
        `Desktop candidate package bytes differ: ${artifact.path}.`,
      );
    }
    if (
      (await sha256(join(input.desktopCandidate, artifact.path))) !==
      artifact.sha256
    ) {
      throw new Error(
        `Desktop candidate package digest is not self-consistent: ${artifact.path}.`,
      );
    }
  }
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  await verifyPackageCandidateBinding(input);
  process.stdout.write(
    `Desktop candidate is bound to Package Candidate ${input.candidateId}.\n`,
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
