import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const CRATES_API = 'https://crates.io/api/v1/crates/new';
const CRATES_REGISTRY = 'https://crates.io/api/v1/crates';

type CargoPackage = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  homepage?: unknown;
  documentation?: unknown;
  readme?: unknown;
  keywords?: unknown;
  categories?: unknown;
  license?: unknown;
  license_file?: unknown;
  repository?: unknown;
  dependencies?: unknown;
};

export function uploadBody(metadata: unknown, crate: Uint8Array): Uint8Array {
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  const crateBytes = Buffer.from(crate);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(metadataBytes.byteLength, 0);
  header.writeUInt32LE(crateBytes.byteLength, 4);
  return Buffer.concat([
    header.subarray(0, 4),
    metadataBytes,
    header.subarray(4),
    crateBytes,
  ]);
}

export function registryChecksum(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const version = (payload as { version?: unknown }).version;
  if (typeof version !== 'object' || version === null) return undefined;
  const checksum = (version as { checksum?: unknown }).checksum;
  return typeof checksum === 'string' && /^[0-9a-f]{64}$/u.test(checksum)
    ? checksum
    : undefined;
}

function run(command: string, args: readonly string[], allowFailure = false) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} failed with status ${String(result.status)}.`);
  }
  return result;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--candidate', '--output'].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error('Use --candidate <directory> --output <file>.');
    }
    values.set(name, value);
  }
  if (values.size !== 2)
    throw new Error('Use --candidate <directory> --output <file>.');
  return values;
}

function crateMetadata(packageValue: CargoPackage): Record<string, unknown> {
  if (
    typeof packageValue.name !== 'string' ||
    typeof packageValue.version !== 'string' ||
    !Array.isArray(packageValue.dependencies)
  ) {
    throw new Error('Cargo metadata is incomplete.');
  }
  return {
    name: packageValue.name,
    vers: packageValue.version,
    deps: packageValue.dependencies.map((dependency) => {
      const value = dependency as {
        name?: unknown;
        req?: unknown;
        optional?: unknown;
        uses_default_features?: unknown;
        features?: unknown;
        target?: unknown;
        kind?: unknown;
        rename?: unknown;
        registry?: unknown;
      };
      if (
        typeof value.name !== 'string' ||
        typeof value.req !== 'string' ||
        typeof value.optional !== 'boolean' ||
        typeof value.uses_default_features !== 'boolean' ||
        !Array.isArray(value.features)
      ) {
        throw new Error('Cargo dependency metadata is incomplete.');
      }
      return {
        name: value.name,
        version_req: value.req,
        optional: value.optional,
        default_features: value.uses_default_features,
        features: value.features,
        target: value.target ?? null,
        kind: value.kind ?? 'normal',
        registry: value.registry ?? null,
        package: value.rename ?? null,
      };
    }),
    description: packageValue.description ?? null,
    homepage: packageValue.homepage ?? null,
    documentation: packageValue.documentation ?? null,
    readme: packageValue.readme ?? null,
    keywords: packageValue.keywords ?? [],
    categories: packageValue.categories ?? [],
    license: packageValue.license ?? null,
    license_file: packageValue.license_file ?? null,
    repository: packageValue.repository ?? null,
  };
}

async function existingRegistryDigest(
  name: string,
  version: string,
): Promise<string | undefined> {
  const response = await fetch(
    `${CRATES_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    {
      headers: { 'User-Agent': 'gx-capture-release-verifier' },
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`Unable to inspect crates.io ${name}@${version}.`);
  const checksum = registryChecksum(await response.json());
  if (!checksum)
    throw new Error(`crates.io returned no checksum for ${name}@${version}.`);
  return checksum;
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const candidate = resolve(values.get('--candidate')!);
  const output = resolve(values.get('--output')!);
  const manifestBytes = await readFile(join(candidate, 'candidate-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { candidateId?: unknown };
  if (
    typeof manifest.candidateId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(manifest.candidateId)
  ) {
    throw new Error('Crate candidate manifest has no valid candidate ID.');
  }
  const names = (await readdir(join(candidate, 'crate'))).filter((name) =>
    name.endsWith('.crate'),
  );
  if (names.length !== 1)
    throw new Error('Expected exactly one crate candidate.');
  const crateName = names[0]!;
  const match =
    /^(?<name>[A-Za-z0-9_-]+)-(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.crate$/u.exec(
      crateName,
    );
  if (!match?.groups) throw new Error('Crate candidate filename is invalid.');
  const name = match.groups.name;
  const version = match.groups.version;
  const crateBytes = await readFile(join(candidate, 'crate', crateName));
  const candidateSha256 = sha256(crateBytes);
  const existingSha256 = await existingRegistryDigest(name, version);
  if (existingSha256 !== undefined) {
    if (existingSha256 !== candidateSha256) {
      throw new Error(
        'Existing crates.io archive differs from the approved candidate.',
      );
    }
  } else {
    const extractionRoot = await mkdtemp(
      join(tmpdir(), 'capture-crate-metadata-'),
    );
    try {
      run('tar', [
        '-xf',
        join(candidate, 'crate', crateName),
        '-C',
        extractionRoot,
      ]);
      const packageDirectories = (
        await readdir(extractionRoot, { withFileTypes: true })
      ).filter((entry) => entry.isDirectory());
      if (packageDirectories.length !== 1)
        throw new Error('Crate archive package root is ambiguous.');
      const manifestPath = join(
        extractionRoot,
        packageDirectories[0]!.name,
        'Cargo.toml',
      );
      const metadataResult = run('cargo', [
        'metadata',
        '--format-version',
        '1',
        '--no-deps',
        '--manifest-path',
        manifestPath,
      ]);
      const cargo = JSON.parse(metadataResult.stdout) as { packages?: unknown };
      if (!Array.isArray(cargo.packages) || cargo.packages.length !== 1) {
        throw new Error('Cargo metadata did not identify exactly one package.');
      }
      const body = uploadBody(
        crateMetadata(cargo.packages[0] as CargoPackage),
        crateBytes,
      );
      const token = process.env.CARGO_REGISTRY_TOKEN;
      if (!token)
        throw new Error(
          'CARGO_REGISTRY_TOKEN is required for new crate publication.',
        );
      const response = await fetch(CRATES_API, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: token,
          'Content-Type': 'application/octet-stream',
          'User-Agent': `gx-capture-release/${name}-${version}`,
        },
        body,
      });
      if (!response.ok)
        throw new Error(
          `crates.io rejected the approved crate (${response.status}).`,
        );
    } finally {
      await rm(extractionRoot, { recursive: true, force: true });
    }
  }
  let registrySha256: string | undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    registrySha256 = await existingRegistryDigest(name, version);
    if (registrySha256 !== undefined) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  }
  if (registrySha256 === undefined)
    throw new Error('Timed out waiting for the crates.io archive.');
  if (registrySha256 !== candidateSha256) {
    throw new Error(
      'crates.io archive digest differs from the approved candidate.',
    );
  }
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: '1',
        registry: 'crates.io',
        candidateId: manifest.candidateId,
        sourceCandidateManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        releaseVersion: version,
        status: 'published',
        artifacts: [{ name: crateName, candidateSha256, registrySha256 }],
      },
      null,
      2,
    )}\n`,
    'utf8',
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
