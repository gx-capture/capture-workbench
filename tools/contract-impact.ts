import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type ImpactClassification =
  | 'no-impact'
  | 'additive'
  | 'breaking'
  | 'manual-review';

export type ContractImpactChange = {
  readonly classification: Exclude<ImpactClassification, 'no-impact'>;
  readonly path: string;
  readonly reason: string;
};

export type ContractSnapshot = {
  readonly schemaVersion: '1';
  readonly releaseVersion: string;
  readonly runtimeApi: Record<string, unknown>;
  readonly contractManifest: Record<string, unknown>;
  readonly schemas: Record<string, unknown>;
  readonly typescript: string;
  readonly python: string;
  readonly events: readonly unknown[];
  readonly errorCodes: readonly unknown[];
};

export type ContractImpactResult = {
  readonly classification: ImpactClassification;
  readonly baselineRelease: string;
  readonly candidateId: string;
  readonly changes: readonly ContractImpactChange[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function equal(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
}

function sortedCollection(value: readonly unknown[]): unknown[] {
  return value
    .map((item) => canonicalize(item))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function addChange(
  changes: ContractImpactChange[],
  classification: Exclude<ImpactClassification, 'no-impact'>,
  path: string,
  reason: string,
): void {
  if (
    changes.some(
      (change) =>
        change.classification === classification &&
        change.path === path &&
        change.reason === reason,
    )
  ) {
    return;
  }
  changes.push({ classification, path, reason });
}

function compareEnum(
  baseline: readonly unknown[],
  candidate: readonly unknown[],
  path: string,
  changes: ContractImpactChange[],
): void {
  const baselineValues = new Set(baseline.map((item) => JSON.stringify(item)));
  const candidateValues = new Set(
    candidate.map((item) => JSON.stringify(item)),
  );
  for (const value of baselineValues) {
    if (!candidateValues.has(value)) {
      addChange(changes, 'breaking', path, `Enum value removed: ${value}.`);
    }
  }
  for (const value of candidateValues) {
    if (!baselineValues.has(value)) {
      addChange(
        changes,
        'manual-review',
        path,
        `Closed enum value added: ${value}.`,
      );
    }
  }
}

function compareSchema(
  baseline: unknown,
  candidate: unknown,
  path: string,
  changes: ContractImpactChange[],
): void {
  if (!isRecord(baseline) || !isRecord(candidate)) {
    if (!equal(baseline, candidate)) {
      addChange(
        changes,
        'manual-review',
        path,
        'Schema shape changed in an unknown way.',
      );
    }
    return;
  }
  for (const key of ['$id', '$schema']) {
    if (!equal(baseline[key], candidate[key])) {
      addChange(changes, 'breaking', `${path}.${key}`, `${key} changed.`);
    }
  }
  if (!equal(baseline.type, candidate.type)) {
    addChange(changes, 'manual-review', `${path}.type`, 'Schema type changed.');
    return;
  }
  if (Array.isArray(baseline.enum) && Array.isArray(candidate.enum)) {
    compareEnum(baseline.enum, candidate.enum, `${path}.enum`, changes);
  } else if (!equal(baseline.enum, candidate.enum)) {
    addChange(
      changes,
      'manual-review',
      `${path}.enum`,
      'Enum representation changed.',
    );
  }
  if (Array.isArray(baseline.required) && Array.isArray(candidate.required)) {
    const baselineRequired = new Set(baseline.required);
    const candidateRequired = new Set(candidate.required);
    for (const name of candidateRequired) {
      if (!baselineRequired.has(name)) {
        addChange(
          changes,
          'breaking',
          `${path}.required`,
          `Required property added: ${String(name)}.`,
        );
      }
    }
    for (const name of baselineRequired) {
      if (!candidateRequired.has(name)) {
        addChange(
          changes,
          'manual-review',
          `${path}.required`,
          `Required property removed: ${String(name)}.`,
        );
      }
    }
  } else if (!equal(baseline.required, candidate.required)) {
    addChange(
      changes,
      'manual-review',
      `${path}.required`,
      'Required-property policy changed.',
    );
  }
  if (
    baseline.additionalProperties === false &&
    candidate.additionalProperties !== false
  ) {
    addChange(
      changes,
      'additive',
      `${path}.additionalProperties`,
      'Object became more permissive.',
    );
  } else if (
    baseline.additionalProperties !== false &&
    candidate.additionalProperties === false
  ) {
    addChange(
      changes,
      'breaking',
      `${path}.additionalProperties`,
      'Object became restrictive.',
    );
  } else if (
    !equal(baseline.additionalProperties, candidate.additionalProperties)
  ) {
    addChange(
      changes,
      'manual-review',
      `${path}.additionalProperties`,
      'Additional-property policy changed.',
    );
  }
  const baselineProperties = isRecord(baseline.properties)
    ? baseline.properties
    : {};
  const candidateProperties = isRecord(candidate.properties)
    ? candidate.properties
    : {};
  const required = new Set(
    Array.isArray(candidate.required) ? candidate.required.map(String) : [],
  );
  for (const name of Object.keys(baselineProperties)) {
    if (!(name in candidateProperties)) {
      addChange(
        changes,
        'breaking',
        `${path}.properties.${name}`,
        'Property removed or renamed.',
      );
    }
  }
  for (const name of Object.keys(candidateProperties)) {
    if (!(name in baselineProperties)) {
      addChange(
        changes,
        required.has(name)
          ? 'breaking'
          : baseline.additionalProperties === false
            ? 'manual-review'
            : 'additive',
        `${path}.properties.${name}`,
        required.has(name)
          ? 'New property is required.'
          : baseline.additionalProperties === false
            ? 'Optional property may be rejected by existing strict consumers.'
            : 'New optional property is accepted by existing consumers.',
      );
    } else {
      compareSchema(
        baselineProperties[name],
        candidateProperties[name],
        `${path}.properties.${name}`,
        changes,
      );
    }
  }
  if (baseline.items !== undefined || candidate.items !== undefined) {
    compareSchema(baseline.items, candidate.items, `${path}.items`, changes);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (!equal(baseline[key], candidate[key])) {
      addChange(
        changes,
        'manual-review',
        `${path}.${key}`,
        `${key} composition changed.`,
      );
    }
  }
  const ignored = new Set([
    '$id',
    '$schema',
    'additionalProperties',
    'anyOf',
    'allOf',
    'description',
    'enum',
    'items',
    'oneOf',
    'properties',
    'required',
    'title',
    'type',
  ]);
  for (const key of new Set([
    ...Object.keys(baseline),
    ...Object.keys(candidate),
  ])) {
    if (!ignored.has(key) && !equal(baseline[key], candidate[key])) {
      addChange(
        changes,
        'manual-review',
        `${path}.${key}`,
        'Schema constraint changed.',
      );
    }
  }
}

function semanticManifest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticManifest);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'generator',
            'packageVersion',
            'runtimeVersion',
            'schemaSha256',
            'captureDocumentSchemaSha256',
          ].includes(key),
      )
      .map(([key, item]) => [key, semanticManifest(item)]),
  );
}

function compareCollections(
  baseline: readonly unknown[],
  candidate: readonly unknown[],
  path: string,
  changes: ContractImpactChange[],
): void {
  const baselineValues = sortedCollection(baseline);
  const candidateValues = sortedCollection(candidate);
  const baselineSet = new Set(
    baselineValues.map((item) => JSON.stringify(item)),
  );
  const candidateSet = new Set(
    candidateValues.map((item) => JSON.stringify(item)),
  );
  for (const value of baselineSet) {
    if (!candidateSet.has(value))
      addChange(changes, 'breaking', path, `Entry removed: ${value}.`);
  }
  for (const value of candidateSet) {
    if (!baselineSet.has(value))
      addChange(changes, 'manual-review', path, `Entry added: ${value}.`);
  }
}

function validateSnapshot(value: unknown, label: string): ContractSnapshot {
  if (!isRecord(value)) throw new Error(`${label} snapshot must be an object.`);
  const required = ['runtimeApi', 'contractManifest', 'schemas'];
  if (
    value.schemaVersion !== '1' ||
    typeof value.releaseVersion !== 'string' ||
    !isRecord(value.runtimeApi) ||
    !isRecord(value.contractManifest) ||
    !isRecord(value.schemas) ||
    typeof value.typescript !== 'string' ||
    typeof value.python !== 'string' ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.errorCodes)
  ) {
    throw new Error(
      `${label} snapshot is incomplete; expected ${required.join(', ')}.`,
    );
  }
  return value as unknown as ContractSnapshot;
}

export function classifyContractImpact(
  baselineValue: unknown,
  candidateValue: unknown,
  candidateId: string,
): ContractImpactResult {
  if (!/^[0-9a-f]{64}$/u.test(candidateId)) {
    throw new Error('Candidate ID must be a lowercase SHA-256 digest.');
  }
  const baseline = validateSnapshot(baselineValue, 'Baseline');
  const candidate = validateSnapshot(candidateValue, 'Candidate');
  const changes: ContractImpactChange[] = [];
  if (!equal(baseline.runtimeApi.apiVersion, candidate.runtimeApi.apiVersion)) {
    addChange(
      changes,
      'breaking',
      'runtimeApi.apiVersion',
      'Runtime API version changed.',
    );
  }
  if (
    !equal(
      baseline.runtimeApi.documentSchemaVersion,
      candidate.runtimeApi.documentSchemaVersion,
    )
  ) {
    addChange(
      changes,
      'breaking',
      'runtimeApi.documentSchemaVersion',
      'Document schema version changed.',
    );
  }
  if (
    !equal(
      baseline.runtimeApi.documentSchemaId,
      candidate.runtimeApi.documentSchemaId,
    )
  ) {
    addChange(
      changes,
      'breaking',
      'runtimeApi.documentSchemaId',
      'Document schema ID changed.',
    );
  }
  const schemaNames = new Set([
    ...Object.keys(baseline.schemas),
    ...Object.keys(candidate.schemas),
  ]);
  for (const name of [...schemaNames].sort()) {
    if (!(name in baseline.schemas)) {
      addChange(
        changes,
        'additive',
        `schemas.${name}`,
        'New schema definition added.',
      );
    } else if (!(name in candidate.schemas)) {
      addChange(
        changes,
        'breaking',
        `schemas.${name}`,
        'Schema definition removed.',
      );
    } else {
      compareSchema(
        baseline.schemas[name],
        candidate.schemas[name],
        `schemas.${name}`,
        changes,
      );
    }
  }
  if (
    !equal(
      semanticManifest(baseline.contractManifest),
      semanticManifest(candidate.contractManifest),
    )
  ) {
    const baselineEnums = Array.isArray(baseline.contractManifest.enums)
      ? baseline.contractManifest.enums
      : [];
    const candidateEnums = Array.isArray(candidate.contractManifest.enums)
      ? candidate.contractManifest.enums
      : [];
    compareCollections(
      baselineEnums,
      candidateEnums,
      'contractManifest.enums',
      changes,
    );
    const baselineWithoutEnums = {
      ...baseline.contractManifest,
      enums: undefined,
    };
    const candidateWithoutEnums = {
      ...candidate.contractManifest,
      enums: undefined,
    };
    if (
      !equal(
        semanticManifest(baselineWithoutEnums),
        semanticManifest(candidateWithoutEnums),
      )
    ) {
      addChange(
        changes,
        'manual-review',
        'contractManifest',
        'Generated contract metadata changed.',
      );
    }
  }
  if (baseline.typescript !== candidate.typescript) {
    addChange(
      changes,
      'manual-review',
      'typescript',
      'Generated TypeScript contract semantics changed.',
    );
  }
  if (baseline.python !== candidate.python) {
    addChange(
      changes,
      'manual-review',
      'python',
      'Generated Python contract semantics changed.',
    );
  }
  compareCollections(baseline.events, candidate.events, 'events', changes);
  compareCollections(
    baseline.errorCodes,
    candidate.errorCodes,
    'errorCodes',
    changes,
  );
  const classification = changes.some(
    (change) => change.classification === 'breaking',
  )
    ? 'breaking'
    : changes.some((change) => change.classification === 'manual-review')
      ? 'manual-review'
      : changes.length > 0
        ? 'additive'
        : 'no-impact';
  return {
    classification,
    baselineRelease: baseline.releaseVersion,
    candidateId,
    changes,
  };
}

async function readSnapshot(path: string): Promise<unknown> {
  let resolved = resolve(path);
  try {
    if ((await stat(resolved)).isDirectory()) {
      resolved = join(resolved, 'contracts', 'contract-snapshot.json');
    }
  } catch {
    // The file read below produces the useful missing-path error.
  }
  return JSON.parse(await readFile(resolved, 'utf8')) as unknown;
}

function parseArguments(args: readonly string[]): {
  baseline: string;
  candidate: string;
  candidateId: string;
  output: string;
} {
  if (args.length !== 8) {
    throw new Error(
      'Use --baseline <file-or-directory> --candidate <file-or-directory> --candidate-id <sha256> --output <file>.',
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--baseline', '--candidate', '--candidate-id', '--output'].includes(
        name,
      ) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --baseline <file-or-directory> --candidate <file-or-directory> --candidate-id <sha256> --output <file>.',
      );
    }
    values.set(name, value);
  }
  const baseline = values.get('--baseline');
  const candidate = values.get('--candidate');
  const candidateId = values.get('--candidate-id');
  const output = values.get('--output');
  if (
    !baseline ||
    !candidate ||
    !candidateId ||
    !/^[0-9a-f]{64}$/u.test(candidateId) ||
    !output
  ) {
    throw new Error(
      'Use --baseline <file-or-directory> --candidate <file-or-directory> --candidate-id <sha256> --output <file>.',
    );
  }
  return { baseline, candidate, candidateId, output: resolve(output) };
}

async function main(): Promise<void> {
  const { baseline, candidate, candidateId, output } = parseArguments(
    process.argv.slice(2),
  );
  const result = classifyContractImpact(
    await readSnapshot(baseline),
    await readSnapshot(candidate),
    candidateId,
  );
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
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
