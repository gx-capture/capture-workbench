import { readFile, readdir, writeFile } from 'node:fs/promises';
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

function normalizeGeneratedSource(
  source: string,
  language: 'typescript' | 'python',
  manifest: JsonObject,
): string {
  const withoutComments =
    language === 'typescript'
      ? source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
      : source.replace(/^\s*#.*$/gmu, '');
  return withoutComments
    .replace(
      new RegExp(
        String(manifest.runtimeVersion).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
        'gu',
      ),
      '<runtime-version>',
    )
    .replace(/[0-9a-f]{64}/gu, '<digest>')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function readJson(path: string): Promise<JsonObject> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isRecord(value)) throw new Error(`Expected an object in ${path}.`);
  return value;
}

async function readOptionalCollection(
  root: string,
  names: readonly string[],
): Promise<unknown[]> {
  for (const name of names) {
    try {
      const value = JSON.parse(
        await readFile(join(root, name), 'utf8'),
      ) as unknown;
      if (!Array.isArray(value))
        throw new Error(`${name} must contain an array.`);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [];
}

export async function createContractSnapshot(
  sourceRoot: string,
): Promise<JsonObject> {
  const typescriptRoot = join(
    sourceRoot,
    'packages/capture-contracts/src/generated',
  );
  const pythonRoot = join(
    sourceRoot,
    'packages/capture-contracts/python/src/capture_contracts',
  );
  const manifest = await readJson(
    join(typescriptRoot, 'contract-manifest.json'),
  );
  const schemaDirectory = join(typescriptRoot, 'schemas');
  const schemaNames = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const schemas: JsonObject = {};
  for (const name of schemaNames) {
    schemas[name] = await readJson(join(schemaDirectory, name));
  }
  const runtimeApi = {
    apiVersion: manifest.apiVersion,
    documentSchemaVersion: manifest.captureDocumentSchemaVersion,
    documentSchemaId: manifest.captureDocumentSchemaId,
    documentSchemaSha256: manifest.captureDocumentSchemaSha256,
  };
  if (Object.values(runtimeApi).some((value) => typeof value !== 'string')) {
    throw new Error('Contract manifest is missing runtime API metadata.');
  }
  return {
    schemaVersion: '1',
    releaseVersion: manifest.runtimeVersion,
    runtimeApi,
    contractManifest: canonicalize(manifest),
    schemas: canonicalize(schemas),
    typescript: normalizeGeneratedSource(
      await readFile(join(typescriptRoot, 'contracts.ts'), 'utf8'),
      'typescript',
      manifest,
    ),
    python: normalizeGeneratedSource(
      await readFile(join(pythonRoot, 'generated_models.py'), 'utf8'),
      'python',
      manifest,
    ),
    events: await readOptionalCollection(typescriptRoot, [
      'events.json',
      'event-codes.json',
    ]),
    errorCodes: await readOptionalCollection(typescriptRoot, [
      'error-codes.json',
      'errors.json',
    ]),
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
