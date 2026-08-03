// Node 24 executes this type-strippable TypeScript script directly.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_RUNTIME_ARTIFACT_BYTES } from './constants/runtime.ts';
import {
  Observable,
  concatMap,
  defer,
  from,
  map,
  throwError,
} from 'rxjs';

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const stagedExecutable = join(
  appRoot,
  'src-tauri',
  'binaries',
  'capture-runtime-x86_64-pc-windows-msvc.exe',
);
export const stagedManifest = join(
  appRoot,
  'src-tauri',
  'resources',
  'capture-runtime-manifest.json',
);
export const stagedSchema = join(
  appRoot,
  'src-tauri',
  'resources',
  'capture-document-v1.schema.json',
);
export const stageProvenance = join(
  appRoot,
  'src-tauri',
  'resources',
  '.runtime-stage.json',
);

const expected = Object.freeze({
  manifestVersion: '1',
  runtimeVersion: '0.3.9',
  apiVersion: '1.0',
  captureDocumentSchemaVersion: '1',
  platform: 'windows',
  arch: 'x86_64',
  fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
  schemaFileName: 'capture-document-v1.schema.json',
});

const manifestFields = Object.freeze([
  'apiVersion',
  'arch',
  'bytes',
  'captureDocumentSchemaVersion',
  'fileName',
  'manifestVersion',
  'platform',
  'runtimeVersion',
  'schemaFileName',
  'schemaSha256',
  'sha256',
]);

export function validateRuntime(manifestPath, artifactPath, schemaPath) {
  return defer(() => from(readFile(manifestPath, 'utf8'))).pipe(
    map((manifestText) => {
      const manifest = JSON.parse(manifestText);
      validateManifestShape(manifest);
      return manifest;
    }),
    concatMap((manifest) =>
      defer(() => from(stat(artifactPath))).pipe(
        concatMap((artifact) => {
          if (!artifact.isFile()) {
            return throwError(() => new Error('Capture runtime artifact must be a regular file.'));
          }
          if (artifact.size !== manifest.bytes) {
            return throwError(
              () =>
                new Error(
                  `Capture runtime byte count mismatch: expected ${manifest.bytes}, found ${artifact.size}.`,
                ),
            );
          }
          return sha256File(artifactPath).pipe(
            concatMap((digest) => {
              if (digest !== manifest.sha256.toLowerCase()) {
                return throwError(() => new Error('Capture runtime SHA-256 mismatch.'));
              }
              return defer(() => from(stat(schemaPath))).pipe(
                concatMap((schema) => {
                  if (!schema.isFile()) {
                    return throwError(
                      () => new Error('Capture document schema must be a regular file.'),
                    );
                  }
                  return defer(() => from(readFile(schemaPath, 'utf8'))).pipe(
                    map((schemaText) => {
                      const schemaDocument = JSON.parse(schemaText);
                      if (
                        !schemaDocument ||
                        typeof schemaDocument !== 'object' ||
                        Array.isArray(schemaDocument)
                      ) {
                        throw new Error('Capture document schema must be a JSON object.');
                      }
                      return schemaDocument;
                    }),
                    concatMap(() =>
                      sha256File(schemaPath).pipe(
                        map((schemaDigest) => {
                          if (schemaDigest !== manifest.schemaSha256.toLowerCase()) {
                            throw new Error('Capture document schema SHA-256 mismatch.');
                          }
                          return { manifest, digest, schemaDigest };
                        }),
                      ),
                    ),
                  );
                }),
              );
            }),
          );
        }),
      ),
    ),
  );
}

export function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Capture runtime manifest must be a JSON object.');
  }
  if (
    JSON.stringify(Object.keys(manifest).sort()) !==
    JSON.stringify(manifestFields)
  ) {
    throw new Error(
      'Capture runtime manifest contains missing or unsupported fields.',
    );
  }
  for (const [name, value] of Object.entries(expected)) {
    if (manifest[name] !== value) {
      throw new Error(`Capture runtime ${name} must equal ${value}.`);
    }
  }
  if (
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    manifest.bytes > MAX_RUNTIME_ARTIFACT_BYTES
  ) {
    throw new Error(
      'Capture runtime bytes must be an integer from 1 through 536870912.',
    );
  }
  if (
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256)
  ) {
    throw new Error(
      'Capture runtime sha256 must contain 64 hexadecimal characters.',
    );
  }
  if (
    typeof manifest.schemaSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(manifest.schemaSha256)
  ) {
    throw new Error(
      'Capture document schemaSha256 must contain 64 hexadecimal characters.',
    );
  }
}

export function stageRuntime({
  artifactPath,
  manifestPath,
  schemaPath,
  source,
}) {
  if (!['release', 'deterministic'].includes(source)) {
    throw new Error('Runtime stage source must be release or deterministic.');
  }
  const resolvedArtifact = resolveInput(artifactPath);
  const resolvedManifest = resolveInput(manifestPath);
  const resolvedSchema = resolveInput(schemaPath);
  return defer(() =>
    validateRuntime(resolvedManifest, resolvedArtifact, resolvedSchema),
  ).pipe(
    concatMap(({ manifest }) =>
      defer(() => from(mkdir(dirname(stagedExecutable), { recursive: true }))).pipe(
        concatMap(() => defer(() => from(mkdir(dirname(stagedManifest), { recursive: true })))),
        concatMap(() => atomicCopy(resolvedArtifact, stagedExecutable)),
        concatMap(() => atomicCopy(resolvedSchema, stagedSchema)),
        concatMap(() => atomicWrite(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`)),
        concatMap(() =>
          atomicWrite(
            stageProvenance,
            `${JSON.stringify(
              {
                source,
                runtimeVersion: manifest.runtimeVersion,
                schemaSha256: manifest.schemaSha256,
              },
              null,
              2,
            )}\n`,
          ),
        ),
        concatMap(() => validateRuntime(stagedManifest, stagedExecutable, stagedSchema)),
        map(() => ({
          manifest,
          source,
          stagedExecutable,
          stagedManifest,
          stagedSchema,
        })),
      ),
    ),
  );
}

function atomicCopy(source, destination) {
  const temporary = `${destination}.tmp`;
  return defer(() => from(rm(temporary, { force: true }))).pipe(
    concatMap(() => defer(() => from(copyFile(source, temporary)))),
    concatMap(() => defer(() => from(rm(destination, { force: true })))),
    concatMap(() => defer(() => from(rename(temporary, destination)))),
    map(() => undefined),
  );
}

function atomicWrite(destination, content) {
  const temporary = `${destination}.tmp`;
  return defer(() => from(rm(temporary, { force: true }))).pipe(
    concatMap(() => defer(() => from(writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })))),
    concatMap(() => defer(() => from(rm(destination, { force: true })))),
    concatMap(() => defer(() => from(rename(temporary, destination)))),
    map(() => undefined),
  );
}

export function sha256File(path): Observable<string> {
  const hash = createHash('sha256');
  return new Observable<string>((subscriber) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => subscriber.error(error));
    stream.on('end', () => {
      subscriber.next(hash.digest('hex'));
      subscriber.complete();
    });
    return () => stream.destroy();
  });
}

function resolveInput(path) {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('A runtime staging path is required.');
  }
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--artifact', '--manifest', '--schema', '--source'].includes(name)) {
      throw new Error(`Unknown runtime staging argument: ${name}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}.`);
    }
    values.set(name, value);
    index += 1;
  }
  return {
    artifactPath: values.get('--artifact'),
    manifestPath: values.get('--manifest'),
    schemaPath: values.get('--schema'),
    source: values.get('--source') ?? 'release',
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  stageRuntime(parseArguments(process.argv.slice(2))).subscribe({
    next: ({ manifest, source }) => {
      process.stdout.write(
        `Staged ${source} Capture runtime ${manifest.runtimeVersion}; digest verified.\n`,
      );
    },
    error: (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  });
}
