import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractSetPath = join(
  workspaceRoot,
  'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
);
const contractSetDigestPath = join(
  workspaceRoot,
  'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
);
const runtimeProjectPath = join(
  workspaceRoot,
  'packages/capture-runtime/pyproject.toml',
);
const desktopRoot = join(workspaceRoot, 'apps/capture-workbench-desktop');
const versionsPath = join(desktopRoot, 'src-tauri/src/constants/versions.rs');
const cargoPath = join(desktopRoot, 'src-tauri/Cargo.toml');
const desktopManifestPath = join(
  desktopRoot,
  'src-tauri/resources/capture-runtime-manifest.json',
);
const desktopSchemaPath = join(
  desktopRoot,
  'src-tauri/resources/capture-document-v2.schema.json',
);

interface ContractManifest {
  readonly manifestVersion: string;
  readonly packageVersion: string;
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly captureDocumentSchemaSha256: string;
}

interface RuntimeManifest {
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly schemaFileName: string;
  readonly schemaSha256: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function expectedConstant(source: string, name: string): string {
  const match = source.match(
    new RegExp(`^pub\\(crate\\) const ${name}: &str = "([^"]+)";`, 'mu'),
  );
  if (!match) throw new Error(`Missing desktop version constant ${name}.`);
  return match[1];
}

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `${name} drifted: expected ${String(expected)}, found ${String(actual)}.`,
    );
  }
}

const contractSet = readJson<{
  readonly contractSetVersion: string;
  readonly schemas: readonly {
    readonly name: string;
    readonly schemaFile: string;
    readonly schemaSha256: string;
  }[];
}>(contractSetPath);
const runtimeVersion = readFileSync(runtimeProjectPath, 'utf8').match(
  /^version\s*=\s*"([^"]+)"/mu,
)?.[1];
if (!runtimeVersion) throw new Error('Missing runtime package version.');
const captureDocumentSchema = contractSet.schemas.find(
  (schema) => schema.name === 'CaptureDocument',
);
if (!captureDocumentSchema) throw new Error('Missing CaptureDocument schema.');
const contracts: ContractManifest = {
  manifestVersion: '1',
  packageVersion: runtimeVersion,
  runtimeVersion,
  apiVersion: '2.0',
  captureDocumentSchemaVersion: '2',
  captureDocumentSchemaSha256: captureDocumentSchema.schemaSha256,
};
expectEqual('contract-set version', contractSet.contractSetVersion, '2');
expectEqual(
  'contract-set digest',
  createHash('sha256').update(readFileSync(contractSetPath)).digest('hex'),
  readFileSync(contractSetDigestPath, 'utf8').trim(),
);
const desktopManifest = readJson<RuntimeManifest>(desktopManifestPath);
const versionsSource = readFileSync(versionsPath, 'utf8');
const cargoSource = readFileSync(cargoPath, 'utf8');
const cargoVersion = cargoSource.match(
  /^\[package\][\s\S]*?^version = "([^"]+)"/mu,
)?.[1];
if (!cargoVersion) throw new Error('Missing desktop Cargo package version.');

expectEqual(
  'desktop EXPECTED_MANIFEST_VERSION',
  expectedConstant(versionsSource, 'EXPECTED_MANIFEST_VERSION'),
  contracts.manifestVersion,
);
expectEqual(
  'desktop EXPECTED_API_VERSION',
  expectedConstant(versionsSource, 'EXPECTED_API_VERSION'),
  contracts.apiVersion,
);
expectEqual(
  'desktop EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION',
  expectedConstant(versionsSource, 'EXPECTED_CAPTURE_DOCUMENT_SCHEMA_VERSION'),
  contracts.captureDocumentSchemaVersion,
);
expectEqual(
  'desktop EXPECTED_RUNTIME_VERSION source',
  versionsSource.match(
    /^pub\(crate\) const EXPECTED_RUNTIME_VERSION: &str = (.+);$/mu,
  )?.[1],
  'env!("CARGO_PKG_VERSION")',
);
expectEqual(
  'desktop Cargo package version',
  cargoVersion,
  contracts.runtimeVersion,
);
expectEqual(
  'contract package/runtime version',
  contracts.packageVersion,
  contracts.runtimeVersion,
);
expectEqual(
  'desktop runtime manifest runtimeVersion',
  desktopManifest.runtimeVersion,
  contracts.runtimeVersion,
);
expectEqual(
  'desktop runtime manifest apiVersion',
  desktopManifest.apiVersion,
  contracts.apiVersion,
);
expectEqual(
  'desktop runtime manifest captureDocumentSchemaVersion',
  desktopManifest.captureDocumentSchemaVersion,
  contracts.captureDocumentSchemaVersion,
);
expectEqual(
  'desktop runtime manifest schemaFileName',
  desktopManifest.schemaFileName,
  'capture-document-v2.schema.json',
);
expectEqual(
  'desktop runtime manifest schemaSha256',
  desktopManifest.schemaSha256,
  contracts.captureDocumentSchemaSha256,
);

const schemaSha256 = createHash('sha256')
  .update(readFileSync(desktopSchemaPath))
  .digest('hex');
expectEqual(
  'desktop schema resource SHA-256',
  schemaSha256,
  contracts.captureDocumentSchemaSha256,
);

console.log(
  `Desktop contract consistency verified: runtime ${contracts.runtimeVersion}, schema ${contracts.captureDocumentSchemaSha256}.`,
);
