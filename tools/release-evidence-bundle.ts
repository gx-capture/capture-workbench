import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ReleaseEvidenceBundle = {
  readonly schemaVersion: 1;
  readonly evidence: Record<string, unknown>;
  readonly fixtureRegistry: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`Release evidence bundle has unknown field: ${key}.`);
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new Error(`Release evidence bundle is missing field: ${key}.`);
    }
  }
}

export function parseReleaseEvidenceBundle(
  value: unknown,
): ReleaseEvidenceBundle {
  if (!isPlainObject(value)) {
    throw new Error('Release evidence bundle must be a JSON object.');
  }
  assertExactKeys(value, ['schemaVersion', 'evidence', 'fixtureRegistry']);
  if (value.schemaVersion !== 1) {
    throw new Error('Release evidence bundle schemaVersion must be 1.');
  }
  if (!isPlainObject(value.evidence)) {
    throw new Error('Release evidence bundle evidence must be an object.');
  }
  if (!isPlainObject(value.fixtureRegistry)) {
    throw new Error(
      'Release evidence bundle fixtureRegistry must be an object.',
    );
  }
  return value as unknown as ReleaseEvidenceBundle;
}

export function encodeReleaseEvidenceBundle(
  evidenceJson: string,
  fixtureRegistryJson: string,
): string {
  let evidence: unknown;
  let fixtureRegistry: unknown;
  try {
    evidence = JSON.parse(evidenceJson) as unknown;
    fixtureRegistry = JSON.parse(fixtureRegistryJson) as unknown;
  } catch (error) {
    throw new Error(
      `Release evidence bundle input is not valid JSON: ${String(error)}`,
    );
  }
  if (!isPlainObject(evidence)) {
    throw new Error('Release evidence JSON must be an object.');
  }
  if (!isPlainObject(fixtureRegistry)) {
    throw new Error('Fixture registry JSON must be an object.');
  }
  const bundle = parseReleaseEvidenceBundle({
    schemaVersion: 1,
    evidence,
    fixtureRegistry,
  });
  return Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');
}

function argumentValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${name} is required.`);
  }
  return args[index + 1];
}

function main(): void {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: node tools/release-evidence-bundle.ts --evidence <path> --fixture-registry <path>\n',
    );
    return;
  }
  const allowed = new Set(['--evidence', '--fixture-registry']);
  for (let index = 0; index < args.length; index += 1) {
    if (!allowed.has(args[index])) {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
    index += 1;
  }
  const evidencePath = resolve(argumentValue(args, '--evidence'));
  const fixtureRegistryPath = resolve(
    argumentValue(args, '--fixture-registry'),
  );
  process.stdout.write(
    `${encodeReleaseEvidenceBundle(
      readFileSync(evidencePath, 'utf8'),
      readFileSync(fixtureRegistryPath, 'utf8'),
    )}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
