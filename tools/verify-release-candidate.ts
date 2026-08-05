import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const EXPECTED_SCHEMA_SHA256 =
  '2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2';
const EXPECTED_NPM_PACKAGES = new Set([
  '@gx-capture/capture-workbench',
  '@gx-capture/capture-contracts',
  '@gx-capture/capture-structuring',
]);

function parseArguments(args: readonly string[]): { candidate: string; version: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--candidate', '--version'].includes(name) || !value || values.has(name)) {
      throw new Error('Use --candidate <directory> and --version <semver> exactly once.');
    }
    values.set(name, value);
  }
  if (values.size !== 2 || !/^\d+\.\d+\.\d+$/u.test(values.get('--version')!)) {
    throw new Error('Use --candidate <directory> and --version <semver> exactly once.');
  }
  return { candidate: resolve(values.get('--candidate')!), version: values.get('--version')! };
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  digest.update(await readFile(path));
  return digest.digest('hex');
}

async function requireFiles(directory: string, pattern: RegExp, label: string): Promise<string[]> {
  const entries = (await readdir(directory)).filter((entry) => pattern.test(entry));
  if (entries.length === 0) {
    throw new Error(`${label} is missing from ${directory}.`);
  }
  for (const entry of entries) {
    const metadata = await stat(join(directory, entry));
    if (!metadata.isFile()) throw new Error(`${label} contains a non-file entry.`);
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
      throw new Error(`Checksum record references a missing artifact: ${artifact}.`);
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
  const { candidate, version } = parseArguments(process.argv.slice(2));
  const runtime = join(candidate, 'runtime');
  const packages = join(candidate, 'package');
  const python = join(candidate, 'python');
  const crate = join(candidate, 'crate');

  const manifest = JSON.parse(await readFile(join(runtime, 'capture-runtime-manifest.json'), 'utf8')) as {
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
    throw new Error('Release runtime version, schema filename, or schema SHA-256 is inconsistent.');
  }

  const npmPackages = await requireFiles(packages, /\.tgz$/u, 'npm package candidate');
  if (npmPackages.length !== EXPECTED_NPM_PACKAGES.size) {
    throw new Error(`Expected ${EXPECTED_NPM_PACKAGES.size} npm package candidates.`);
  }

  const pythonArtifacts = await requireFiles(
    python,
    new RegExp(`^(capture_contracts|capture_structuring)-${version.replaceAll('.', '\\.')}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`, 'u'),
    'Python package candidate',
  );
  if (!pythonArtifacts.some((name) => name.startsWith(`capture_contracts-${version}`))) {
    throw new Error('capture-contracts Python artifact version is missing.');
  }
  if (!pythonArtifacts.some((name) => name.startsWith(`capture_structuring-${version}`))) {
    throw new Error('capture-structuring Python artifact version is missing.');
  }

  const crateArtifacts = await requireFiles(
    crate,
    new RegExp(`^capture-sidecar-launcher-${version}\\.crate$`, 'u'),
    'Cargo package candidate',
  );
  if (crateArtifacts.length !== 1) throw new Error('Expected exactly one launcher crate candidate.');

  const expectedNpmPackages = new Set([
    `gx-capture-capture-workbench-${version}.tgz`,
    `gx-capture-capture-contracts-${version}.tgz`,
    `gx-capture-capture-structuring-${version}.tgz`,
  ]);
  if (!npmPackages.every((name) => expectedNpmPackages.has(name))) {
    throw new Error('The npm candidate filenames do not match the synchronized release.');
  }
  const artifactNames = [...npmPackages, ...pythonArtifacts, ...crateArtifacts];
  const artifactDigests = await requireChecksums(
    candidate,
    [packages, python, crate],
    artifactNames,
  );

  const ledger = {
    version,
    schemaSha256: schemaDigest,
    artifacts: [
      ...npmPackages.map((name) => ({ registry: 'npm', name, sha256: artifactDigests.get(name) })),
      ...pythonArtifacts.map((name) => ({ registry: 'pypi', name, sha256: artifactDigests.get(name) })),
      ...crateArtifacts.map((name) => ({ registry: 'crates.io', name, sha256: artifactDigests.get(name) })),
    ],
    status: 'candidate-verified',
  };
  await writeFile(join(candidate, 'release-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  process.stdout.write(`Release candidate ${version} verified: ${ledger.artifacts.length} registry artifacts.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
