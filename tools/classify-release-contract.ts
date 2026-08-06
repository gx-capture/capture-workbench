import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  classifyContractImpact,
  type ContractSnapshot,
  type ImpactClassification,
} from './contract-impact.ts';

type JsonRecord = Record<string, unknown>;

const CLASSIFICATIONS = new Set<ImpactClassification>([
  'no-impact',
  'additive',
  'breaking',
  'manual-review',
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}.`);
  return value;
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--candidate', '--candidate-id', '--baseline', '--output'].includes(
        name,
      ) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --candidate <directory> --candidate-id <sha256> [--baseline <file>] --output <file>.',
      );
    }
    values.set(name, value);
  }
  if (!values.has('--candidate') || !values.has('--candidate-id')) {
    throw new Error(
      'Use --candidate <directory> --candidate-id <sha256> [--baseline <file>] --output <file>.',
    );
  }
  return values;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function requireSnapshot(value: unknown, label: string): ContractSnapshot {
  if (!isRecord(value) || value.schemaVersion !== '1') {
    throw new Error(`${label} is not a supported contract snapshot.`);
  }
  return value as ContractSnapshot;
}

export function verifyContractImpact(
  value: unknown,
  expected: { candidateId: string; candidateSnapshotSha256: string },
): {
  schemaVersion: '1';
  candidateId: string;
  candidateSnapshotSha256: string;
  classification: ImpactClassification;
  baselineRelease: string;
  changes: readonly unknown[];
} {
  if (!isRecord(value))
    throw new Error('Contract impact evidence must be an object.');
  const keys = Object.keys(value).sort();
  if (
    keys.join(',') !==
    'baselineRelease,candidateId,candidateSnapshotSha256,changes,classification,schemaVersion'
  ) {
    throw new Error('Contract impact evidence fields are not canonical.');
  }
  if (
    value.schemaVersion !== '1' ||
    value.candidateId !== expected.candidateId ||
    value.candidateSnapshotSha256 !== expected.candidateSnapshotSha256 ||
    typeof value.baselineRelease !== 'string' ||
    !Array.isArray(value.changes) ||
    typeof value.classification !== 'string' ||
    !CLASSIFICATIONS.has(value.classification as ImpactClassification)
  ) {
    throw new Error('Contract impact evidence is not bound to this candidate.');
  }
  return value as {
    schemaVersion: '1';
    candidateId: string;
    candidateSnapshotSha256: string;
    classification: ImpactClassification;
    baselineRelease: string;
    changes: readonly unknown[];
  };
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const candidate = resolve(required(values, '--candidate'));
  const candidateId = required(values, '--candidate-id');
  if (!/^[0-9a-f]{64}$/u.test(candidateId))
    throw new Error('Candidate ID must be a lowercase SHA-256 digest.');
  const snapshotPath = join(candidate, 'contracts', 'contract-snapshot.json');
  const snapshot = requireSnapshot(
    JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown,
    'Candidate contract snapshot',
  );
  const candidateSnapshotSha256 = await sha256File(snapshotPath);
  let result: {
    classification: ImpactClassification;
    baselineRelease: string;
    changes: readonly unknown[];
  };
  const baselinePath = values.get('--baseline');
  if (baselinePath) {
    const baseline = requireSnapshot(
      JSON.parse(await readFile(resolve(baselinePath), 'utf8')) as unknown,
      'Stable contract baseline',
    );
    result = classifyContractImpact(baseline, snapshot, candidateId);
  } else {
    result = {
      classification: 'manual-review',
      baselineRelease: 'unavailable',
      changes: [
        {
          classification: 'manual-review',
          path: 'baseline',
          reason:
            'No stable contract snapshot was available; independent compatibility review is required.',
        },
      ],
    };
  }
  const output = values.get('--output');
  if (!output) throw new Error('Missing required argument: --output.');
  await writeFile(
    resolve(output),
    `${JSON.stringify(
      {
        schemaVersion: '1',
        candidateId,
        candidateSnapshotSha256,
        ...result,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(
    `Contract impact classification: ${result.classification} for ${candidateId}.\n`,
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
