import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REGISTRIES = ['npm', 'pypi', 'crates.io', 'maven'] as const;
type Registry = (typeof REGISTRIES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        '--directory',
        '--candidate-id',
        '--release-version',
        '--scope',
        '--release-candidate-id',
        '--package-candidate-id',
        '--runtime-candidate-id',
        '--java-candidate-id',
        '--contract-set-sha256',
        '--package-candidate-manifest-sha256',
        '--java-candidate-manifest-sha256',
        '--runtime-candidate-manifest-sha256',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --directory <path> --candidate-id <sha256> --release-version <semver> --scope <all|npm|pypi|pypi-client|crates|maven> --release-candidate-id <sha256> --package-candidate-id <sha256> --runtime-candidate-id <sha256> --java-candidate-id <sha256> --package-candidate-manifest-sha256 <sha256> --java-candidate-manifest-sha256 <sha256> --runtime-candidate-manifest-sha256 <sha256> --contract-set-sha256 <sha256>.',
      );
    }
    values.set(name, value);
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}.`);
  return value;
}

export function requiredRegistries(scope: string): readonly Registry[] {
  if (scope === 'all') return REGISTRIES;
  if (scope === 'npm') return ['npm'];
  if (scope === 'pypi') return ['pypi'];
  if (scope === 'pypi-client') return ['pypi'];
  if (scope === 'crates') return ['crates.io'];
  if (scope === 'maven') return ['maven'];
  throw new Error('Publication scope is invalid.');
}

export function verifyRegistryLedger(
  value: unknown,
  expectedRegistry: Registry,
  candidateId: string,
  releaseVersion: string,
  options: {
    readonly releaseCandidateId?: string;
    readonly sourceCandidateId?: string;
    readonly contractSetSha256?: string;
    readonly sourceCandidateManifestSha256?: string;
  } = {},
): void {
  if (!isRecord(value)) throw new Error('Registry ledger must be an object.');
  const sourceCandidateId = options.sourceCandidateId ?? candidateId;
  if (
    value.schemaVersion !== '1' ||
    value.registry !== expectedRegistry ||
    value.candidateId !== sourceCandidateId ||
    value.releaseVersion !== releaseVersion ||
    value.status !== 'published'
  ) {
    throw new Error(
      `Registry ledger is not a passing ${expectedRegistry} ledger.`,
    );
  }
  if (
    options.releaseCandidateId !== undefined &&
    value.releaseCandidateId !== options.releaseCandidateId
  ) {
    throw new Error(
      `Registry ledger is not bound to release candidate ${options.releaseCandidateId}.`,
    );
  }
  if (
    options.contractSetSha256 !== undefined &&
    value.contractSetSha256 !== options.contractSetSha256
  ) {
    throw new Error(
      `Registry ledger is not bound to contract set ${options.contractSetSha256}.`,
    );
  }
  if (
    typeof value.sourceCandidateManifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.sourceCandidateManifestSha256)
  ) {
    throw new Error(
      `Registry ledger is missing a valid source candidate manifest digest: ${expectedRegistry}.`,
    );
  }
  if (
    options.sourceCandidateManifestSha256 !== undefined &&
    value.sourceCandidateManifestSha256 !==
      options.sourceCandidateManifestSha256
  ) {
    throw new Error(
      `Registry ledger is not bound to source candidate manifest ${options.sourceCandidateManifestSha256}.`,
    );
  }
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const directory = resolve(required(values, '--directory'));
  const candidateId = required(values, '--candidate-id');
  const releaseVersion = required(values, '--release-version');
  const releaseCandidateId = required(values, '--release-candidate-id');
  const packageCandidateId =
    values.get('--package-candidate-id') || candidateId;
  const runtimeCandidateId =
    values.get('--runtime-candidate-id') || candidateId;
  const javaCandidateId = required(values, '--java-candidate-id');
  const contractSetSha256 = required(values, '--contract-set-sha256');
  const packageCandidateManifestSha256 = required(
    values,
    '--package-candidate-manifest-sha256',
  );
  const javaCandidateManifestSha256 = required(
    values,
    '--java-candidate-manifest-sha256',
  );
  const runtimeCandidateManifestSha256 = required(
    values,
    '--runtime-candidate-manifest-sha256',
  );
  if (
    !/^[0-9a-f]{64}$/u.test(releaseCandidateId) ||
    !/^[0-9a-f]{64}$/u.test(packageCandidateId) ||
    !/^[0-9a-f]{64}$/u.test(runtimeCandidateId) ||
    !/^[0-9a-f]{64}$/u.test(javaCandidateId) ||
    !/^[0-9a-f]{64}$/u.test(contractSetSha256) ||
    !/^[0-9a-f]{64}$/u.test(packageCandidateManifestSha256) ||
    !/^[0-9a-f]{64}$/u.test(javaCandidateManifestSha256) ||
    !/^[0-9a-f]{64}$/u.test(runtimeCandidateManifestSha256)
  ) {
    throw new Error('Registry ledger binding identities are invalid.');
  }
  const registries = requiredRegistries(required(values, '--scope'));
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith('.json'),
  );
  for (const registry of registries) {
    const expectedName = `registry-ledger-${registry}.json`;
    if (!files.includes(expectedName)) {
      throw new Error(`Missing registry ledger: ${expectedName}.`);
    }
    verifyRegistryLedger(
      JSON.parse(
        await readFile(join(directory, expectedName), 'utf8'),
      ) as unknown,
      registry,
      candidateId,
      releaseVersion,
      {
        releaseCandidateId,
        sourceCandidateId:
          registry === 'npm'
            ? packageCandidateId
            : registry === 'maven'
              ? javaCandidateId
              : runtimeCandidateId,
        contractSetSha256,
        sourceCandidateManifestSha256:
          registry === 'npm'
            ? packageCandidateManifestSha256
            : registry === 'maven'
              ? javaCandidateManifestSha256
              : runtimeCandidateManifestSha256,
      },
    );
  }
  process.stdout.write(
    `Registry ledgers verified for ${registries.join(', ')}.\n`,
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
