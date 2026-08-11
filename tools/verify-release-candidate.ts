import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_SCHEMA_SHA256 =
  '2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2';
const EXPECTED_NPM_PACKAGES = new Set([
  '@gx-capture/capture-workbench',
  '@gx-capture/capture-contracts',
  '@gx-capture/capture-structuring',
]);

function parseArguments(args: readonly string[]): {
  candidate: string;
  version: string;
  sourceCommit?: string;
  releaseMode?: 'core-only' | 'model-enabled';
  packageCandidateId?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        '--candidate',
        '--version',
        '--source-commit',
        '--release-mode',
        '--package-candidate-id',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --candidate <directory> --version <semver> [--source-commit <sha>] [--release-mode <mode>].',
      );
    }
    values.set(name, value);
  }
  const version = values.get('--version');
  const sourceCommit = values.get('--source-commit');
  const releaseMode = values.get('--release-mode');
  const packageCandidateId = values.get('--package-candidate-id');
  if (
    !values.has('--candidate') ||
    !version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    (sourceCommit !== undefined &&
      !/^(?:local|[0-9a-f]{40})$/iu.test(sourceCommit)) ||
    (releaseMode !== undefined &&
      !['core-only', 'model-enabled'].includes(releaseMode)) ||
    (packageCandidateId !== undefined &&
      !/^[0-9a-f]{64}$/iu.test(packageCandidateId))
  ) {
    throw new Error(
      'Use --candidate <directory> --version <semver> [--source-commit <sha>] [--release-mode <mode>].',
    );
  }
  return {
    candidate: resolve(values.get('--candidate')!),
    version,
    sourceCommit,
    releaseMode: releaseMode as 'core-only' | 'model-enabled' | undefined,
    packageCandidateId,
  };
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  digest.update(await readFile(path));
  return digest.digest('hex');
}

async function candidateFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await candidateFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(
        `Candidate contains a non-regular entry: ${relative(directory, path)}.`,
      );
    }
  }
  return files;
}

export function computeCandidateId(manifest: Record<string, unknown>): string {
  const normalized = JSON.stringify(manifest);
  return createHash('sha256').update(normalized).digest('hex');
}

function candidateManifestBase(
  version: string,
  sourceCommit: string,
  releaseMode: 'core-only' | 'model-enabled',
  packageCandidateId: string | null,
  artifacts: Array<{ path: string; bytes: number; sha256: string }>,
  toolchains: Record<string, string>,
) {
  const base = {
    schemaVersion: '1',
    sourceCommit,
    releaseVersion: version,
    releaseMode,
    runtimeApiVersion: '1.0',
    documentSchemaVersion: '1',
    artifacts: artifacts.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    toolchains,
    contractImpact: null,
  } as const;
  return packageCandidateId === null ? base : { ...base, packageCandidateId };
}

async function inferReleaseMode(
  runtimeDirectory: string,
): Promise<'core-only' | 'model-enabled'> {
  const catalog = JSON.parse(
    await readFile(
      join(runtimeDirectory, 'capture-engine-catalog.json'),
      'utf8',
    ),
  ) as { requirements?: unknown };
  const requirements = Array.isArray(catalog.requirements)
    ? catalog.requirements
    : [];
  return requirements.some((requirement) => {
    if (!requirement || typeof requirement !== 'object') return false;
    const item = requirement as { artifacts?: unknown; modelFiles?: unknown };
    return (
      (Array.isArray(item.artifacts) && item.artifacts.length > 0) ||
      (item.modelFiles !== null && item.modelFiles !== undefined)
    );
  })
    ? 'model-enabled'
    : 'core-only';
}

async function requireFiles(
  directory: string,
  pattern: RegExp,
  label: string,
): Promise<string[]> {
  const entries = (await readdir(directory)).filter((entry) =>
    pattern.test(entry),
  );
  if (entries.length === 0) {
    throw new Error(`${label} is missing from ${directory}.`);
  }
  for (const entry of entries) {
    const metadata = await stat(join(directory, entry));
    if (!metadata.isFile())
      throw new Error(`${label} contains a non-file entry.`);
  }
  return entries;
}

async function requireChecksums(
  candidate: string,
  directories: readonly string[],
  artifacts: readonly string[],
): Promise<Map<string, string>> {
  const checksumsDirectory = join(candidate, 'checksums');
  const checksums = new Map<string, string>();
  for (const artifact of artifacts) {
    const checksumPath = join(checksumsDirectory, `${artifact}.sha256`);
    const checksumText = (await readFile(checksumPath, 'utf8')).trim();
    const match = checksumText.match(/^([0-9a-f]{64})  (.+)$/u);
    if (!match || match[2] !== artifact) {
      throw new Error(`Checksum record is malformed for ${artifact}.`);
    }
    let artifactPath: string | undefined;
    for (const directory of directories) {
      const path = join(directory, artifact);
      try {
        await stat(path);
        artifactPath = path;
        break;
      } catch {
        // Continue searching the candidate artifact directories.
      }
    }
    if (!artifactPath) {
      throw new Error(
        `Checksum record references a missing artifact: ${artifact}.`,
      );
    }
    const actualDigest = await sha256(artifactPath);
    if (actualDigest !== match[1]) {
      throw new Error(`Checksum mismatch for ${artifact}.`);
    }
    checksums.set(artifact, actualDigest);
  }
  return checksums;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const { candidate, version } = parsed;
  const runtime = join(candidate, 'runtime');
  const packages = join(candidate, 'package');
  const python = join(candidate, 'python');
  const crate = join(candidate, 'crate');
  const contracts = join(candidate, 'contracts');
  const desktop = join(candidate, 'desktop');

  const manifest = JSON.parse(
    await readFile(join(runtime, 'capture-runtime-manifest.json'), 'utf8'),
  ) as {
    runtimeVersion?: unknown;
    schemaFileName?: unknown;
    schemaSha256?: unknown;
  };
  const schemaPath = join(runtime, 'capture-document-v1.schema.json');
  const schemaDigest = await sha256(schemaPath);
  if (
    manifest.runtimeVersion !== version ||
    manifest.schemaFileName !== basename(schemaPath) ||
    manifest.schemaSha256 !== schemaDigest ||
    schemaDigest !== EXPECTED_SCHEMA_SHA256
  ) {
    throw new Error(
      'Release runtime version, schema filename, or schema SHA-256 is inconsistent.',
    );
  }

  const npmPackages = await requireFiles(
    packages,
    /\.tgz$/u,
    'npm package candidate',
  );
  if (npmPackages.length !== EXPECTED_NPM_PACKAGES.size) {
    throw new Error(
      `Expected ${EXPECTED_NPM_PACKAGES.size} npm package candidates.`,
    );
  }

  const pythonArtifacts = await requireFiles(
    python,
    new RegExp(
      `^(capture_contracts|capture_structuring)-${version.replaceAll('.', '\\.')}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`,
      'u',
    ),
    'Python package candidate',
  );
  if (
    !pythonArtifacts.some((name) =>
      name.startsWith(`capture_contracts-${version}`),
    )
  ) {
    throw new Error('capture-contracts Python artifact version is missing.');
  }
  if (
    !pythonArtifacts.some((name) =>
      name.startsWith(`capture_structuring-${version}`),
    )
  ) {
    throw new Error('capture-structuring Python artifact version is missing.');
  }

  const crateArtifacts = await requireFiles(
    crate,
    new RegExp(`^capture-sidecar-launcher-${version}\\.crate$`, 'u'),
    'Cargo package candidate',
  );
  if (crateArtifacts.length !== 1)
    throw new Error('Expected exactly one launcher crate candidate.');

  const expectedNpmPackages = new Set([
    `gx-capture-capture-workbench-${version}.tgz`,
    `gx-capture-capture-contracts-${version}.tgz`,
    `gx-capture-capture-structuring-${version}.tgz`,
  ]);
  if (!npmPackages.every((name) => expectedNpmPackages.has(name))) {
    throw new Error(
      'The npm candidate filenames do not match the synchronized release.',
    );
  }
  const artifactNames = [...npmPackages, ...pythonArtifacts, ...crateArtifacts];
  const artifactDigests = await requireChecksums(
    candidate,
    [packages, python, crate],
    artifactNames,
  );

  const existingManifestPath = join(candidate, 'candidate-manifest.json');
  let existingManifest: Record<string, unknown> | undefined;
  try {
    existingManifest = JSON.parse(
      await readFile(existingManifestPath, 'utf8'),
    ) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A first candidate has no prior manifest. Reused candidates are checked below.
  }
  const sourceCommit =
    parsed.sourceCommit ??
    (typeof existingManifest?.sourceCommit === 'string'
      ? existingManifest.sourceCommit
      : (process.env.GITHUB_SHA ?? 'local'));
  const releaseMode =
    parsed.releaseMode ??
    (typeof existingManifest?.releaseMode === 'string'
      ? (existingManifest.releaseMode as 'core-only' | 'model-enabled')
      : await inferReleaseMode(runtime));
  const packageCandidateId =
    parsed.packageCandidateId ??
    (typeof existingManifest?.packageCandidateId === 'string'
      ? existingManifest.packageCandidateId
      : null);
  if (!/^(?:local|[0-9a-f]{40})$/iu.test(sourceCommit)) {
    throw new Error(
      'Candidate sourceCommit must be a 40-character commit SHA.',
    );
  }
  if (!['core-only', 'model-enabled'].includes(releaseMode)) {
    throw new Error(
      'Candidate releaseMode must be core-only or model-enabled.',
    );
  }
  if (
    packageCandidateId !== null &&
    !/^[0-9a-f]{64}$/iu.test(packageCandidateId)
  ) {
    throw new Error('Candidate package identity is invalid.');
  }

  const candidateDirectories = [
    runtime,
    packages,
    python,
    crate,
    desktop,
    join(candidate, 'checksums'),
  ];
  let hasContracts = false;
  try {
    const metadata = await stat(contracts);
    if (!metadata.isDirectory()) {
      throw new Error('Candidate contracts path must be a directory.');
    }
    hasContracts = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Candidates created before Phase 4 remain valid for recovery.
  }
  if (hasContracts) {
    const snapshot = JSON.parse(
      await readFile(join(contracts, 'contract-snapshot.json'), 'utf8'),
    ) as { schemaVersion?: unknown };
    if (snapshot.schemaVersion !== '1') {
      throw new Error('Candidate contract snapshot schema is unsupported.');
    }
    candidateDirectories.push(contracts);
  }
  const inventory = [];
  for (const directory of candidateDirectories) {
    for (const path of await candidateFiles(directory)) {
      const metadata = await stat(path);
      inventory.push({
        path: relative(candidate, path).replaceAll('\\', '/'),
        bytes: metadata.size,
        sha256: await sha256(path),
      });
    }
  }
  const existingToolchains = existingManifest?.toolchains;
  const toolchains =
    existingToolchains &&
    typeof existingToolchains === 'object' &&
    !Array.isArray(existingToolchains)
      ? (existingToolchains as Record<string, string>)
      : { node: process.version };
  const baseManifest = candidateManifestBase(
    version,
    sourceCommit,
    releaseMode,
    packageCandidateId,
    inventory,
    toolchains,
  );
  const candidateId = computeCandidateId(baseManifest);
  const candidateManifest = { ...baseManifest, candidateId };
  if (
    existingManifest?.candidateId &&
    existingManifest.candidateId !== candidateId
  ) {
    throw new Error(
      'Reused candidate bytes do not match the stored candidate ID.',
    );
  }
  if (
    existingManifest?.sourceCommit &&
    existingManifest.sourceCommit !== sourceCommit
  ) {
    throw new Error(
      'Reused candidate source commit differs from the requested source commit.',
    );
  }
  await writeFile(
    existingManifestPath,
    `${JSON.stringify(candidateManifest, null, 2)}\n`,
    'utf8',
  );
  const candidateManifestSha256 = await sha256(existingManifestPath);
  await writeFile(
    join(candidate, 'candidate-manifest.json.sha256'),
    `${candidateManifestSha256}  candidate-manifest.json\n`,
    'utf8',
  );

  const ledger = {
    candidateId,
    sourceCommit,
    releaseMode,
    candidateManifestSha256,
    version,
    schemaSha256: schemaDigest,
    artifacts: [
      ...npmPackages.map((name) => ({
        registry: 'npm',
        name,
        sha256: artifactDigests.get(name),
      })),
      ...pythonArtifacts.map((name) => ({
        registry: 'pypi',
        name,
        sha256: artifactDigests.get(name),
      })),
      ...crateArtifacts.map((name) => ({
        registry: 'crates.io',
        name,
        sha256: artifactDigests.get(name),
      })),
    ],
    status: 'candidate-verified',
  };
  await writeFile(
    join(candidate, 'release-ledger.json'),
    `${JSON.stringify(ledger, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `Release candidate ${version} verified: ${ledger.artifacts.length} registry artifacts; candidate ${candidateId}.\n`,
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
