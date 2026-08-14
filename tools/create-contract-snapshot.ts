import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
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

async function readJson(path: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isRecord(value)) throw new Error(`Expected an object in ${path}.`);
  return value;
}

export async function createContractSnapshot(
  sourceRoot: string,
): Promise<JsonObject> {
  const bundlePath = join(
    sourceRoot,
    'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
  );
  const hashPath = join(
    sourceRoot,
    'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
  );
  const bundleBytes = await readFile(bundlePath);
  const bundle = JSON.parse(bundleBytes.toString('utf8')) as JsonObject;
  const contractSetSha256 = (await readFile(hashPath, 'utf8')).trim();
  if (
    bundle.contractSetVersion !== '2' ||
    !/^[0-9a-f]{64}$/u.test(contractSetSha256) ||
    createHash('sha256').update(bundleBytes).digest('hex') !== contractSetSha256
  ) {
    throw new Error('Canonical v2 contract-set bundle/hash is invalid.');
  }
  const schemas: JsonObject = {};
  let captureDocumentEntry: JsonObject | undefined;
  for (const value of Array.isArray(bundle.schemas) ? bundle.schemas : []) {
    if (!isRecord(value) || !isRecord(value.schema)) continue;
    const name =
      typeof value.schemaFile === 'string'
        ? value.schemaFile
        : typeof value.name === 'string'
          ? value.name
          : undefined;
    if (name) schemas[name] = value.schema;
    if (name === 'capture-document.schema.json') captureDocumentEntry = value;
  }
  const captureDocument = captureDocumentEntry?.schema;
  const runtimeVersion =
    /(?:^|\n)version\s*=\s*"([^"]+)"/u.exec(
      await readFile(
        join(sourceRoot, 'packages/capture-runtime/pyproject.toml'),
        'utf8',
      ),
    )?.[1] ?? '0.0.0';
  const runtimeApi = {
    apiVersion: '2.0',
    documentSchemaVersion: '2',
    documentSchemaId:
      isRecord(captureDocument) && typeof captureDocument.$id === 'string'
        ? captureDocument.$id
        : 'https://github.com/gx-capture/capture-workbench/schema/capture-document-v2.schema.json',
    documentSchemaSha256:
      typeof captureDocumentEntry?.schemaSha256 === 'string'
        ? captureDocumentEntry.schemaSha256
        : '',
  };
  if (Object.values(runtimeApi).some((value) => typeof value !== 'string')) {
    throw new Error('Contract manifest is missing runtime API metadata.');
  }
  return {
    schemaVersion: '1',
    releaseVersion: runtimeVersion,
    runtimeApi,
    contractManifest: canonicalize({
      contractSetVersion: bundle.contractSetVersion,
      operations: bundle.operations,
      problems: bundle.problems,
      surfaces: bundle.surfaces,
      invariants: bundle.invariants,
    }),
    schemas: canonicalize(schemas),
    typescript: '',
    python: '',
    events: [],
    errorCodes: Array.isArray(bundle.problems) ? bundle.problems : [],
    contractSetSha256,
  };
}

function parseArguments(args: readonly string[]): {
  output: string;
  sourceRoot: string;
} {
  if (args.length !== 2 && args.length !== 4) {
    throw new Error('Use --output <file> [--source-root <directory>].');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--output', '--source-root'].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error('Use --output <file> [--source-root <directory>].');
    }
    values.set(name, value);
  }
  const output = values.get('--output');
  if (!output)
    throw new Error('Use --output <file> [--source-root <directory>].');
  return {
    output: resolve(output),
    sourceRoot: resolve(
      values.get('--source-root') ?? resolve(import.meta.dirname, '..'),
    ),
  };
}

async function main(): Promise<void> {
  const { output, sourceRoot } = parseArguments(process.argv.slice(2));
  const snapshot = await createContractSnapshot(sourceRoot);
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stdout.write(`Contract snapshot written to ${output}.\n`);
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
