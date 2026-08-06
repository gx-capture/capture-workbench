import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REGISTRIES = ['npm', 'pypi', 'crates.io'] as const;
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
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --directory <path> --candidate-id <sha256> --release-version <semver> --scope <all|npm|pypi|crates>.',
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
  if (scope === 'crates') return ['crates.io'];
  throw new Error('Publication scope is invalid.');
}

export function verifyRegistryLedger(
  value: unknown,
  expectedRegistry: Registry,
  candidateId: string,
  releaseVersion: string,
): void {
  if (!isRecord(value)) throw new Error('Registry ledger must be an object.');
  if (
    value.schemaVersion !== '1' ||
    value.registry !== expectedRegistry ||
    value.candidateId !== candidateId ||
    value.releaseVersion !== releaseVersion ||
    value.status !== 'published'
  ) {
    throw new Error(
      `Registry ledger is not a passing ${expectedRegistry} ledger.`,
    );
  }
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const directory = resolve(required(values, '--directory'));
  const candidateId = required(values, '--candidate-id');
  const releaseVersion = required(values, '--release-version');
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
