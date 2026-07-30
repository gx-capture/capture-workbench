import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { concatMap, defer, from, map, Observable, finalize } from 'rxjs';

import { sha256File, stageRuntime } from './stage-runtime.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(scriptDirectory, 'fixtures', 'deterministic-runtime');
const fixtureManifest = join(fixtureRoot, 'Cargo.toml');
const target = 'x86_64-pc-windows-msvc';

export function stageDeterministicRuntime(): Observable<unknown> {
  const build = spawnSync(
    'cargo',
    [
      'build',
      '--release',
      '--target',
      target,
      '--manifest-path',
      fixtureManifest,
    ],
    { cwd: fixtureRoot, encoding: 'utf8' },
  );
  if (build.status !== 0) {
    throw new Error(
      `Deterministic runtime build failed: ${(build.stderr || build.stdout || '').trim()}`,
    );
  }

  const executable = join(
    fixtureRoot,
    'target',
    target,
    'release',
    'capture-runtime.exe',
  );
  return defer(() => from(stat(executable))).pipe(
    concatMap((metadata) =>
      defer(() => from(mkdtemp(join(tmpdir(), 'capture-workbench-runtime-')))).pipe(
        concatMap((temporary) => {
          const manifestPath = join(
            temporary,
            `manifest-${randomBytes(4).toString('hex')}.json`,
          );
          const schemaPath = join(temporary, 'capture-document-v1.schema.json');
          const schema = `${JSON.stringify(
            {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              $id: 'https://github.com/gx-capture/capture-workbench/schema/capture-document-v1.schema.json',
              title: 'CaptureDocumentV1 deterministic QA fixture',
              type: 'object',
            },
            null,
            2,
          )}\n`;
          return defer(() => from(writeFile(schemaPath, schema, 'utf8'))).pipe(
            concatMap(() => sha256File(executable)),
            concatMap((digest) => sha256File(schemaPath).pipe(
              map((schemaSha256) => ({ digest, schemaSha256 })),
            )),
            concatMap(({ digest, schemaSha256 }) => {
              const manifest = {
                manifestVersion: '1',
                runtimeVersion: '0.3.5',
                apiVersion: '1.0',
                captureDocumentSchemaVersion: '1',
                platform: 'windows',
                arch: 'x86_64',
                fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
                bytes: metadata.size,
                sha256: digest,
                schemaFileName: 'capture-document-v1.schema.json',
                schemaSha256,
              };
              return defer(() =>
                from(writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')),
              ).pipe(
                concatMap(() =>
                  stageRuntime({
                    artifactPath: executable,
                    manifestPath,
                    schemaPath,
                    source: 'deterministic',
                  }),
                ),
              );
            }),
            finalize(() => {
              from(rm(temporary, { recursive: true, force: true })).subscribe();
            }),
          );
        }),
      ),
    ),
  );
}

stageDeterministicRuntime().subscribe({
  next: ({ manifest }) => {
    process.stdout.write(
      `Staged deterministic runtime ${manifest.runtimeVersion} for QA only.\n`,
    );
  },
  error: (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
});
