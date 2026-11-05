// eslint-disable-next-line @nx/enforce-module-boundaries -- repository tooling reads shared release intent.
import { RELEASE_VERSION } from '../../../tools/release/release-intent.ts';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catchError, concatMap, defer, from, map, throwError } from 'rxjs';

import { deterministicQaTarget } from './deterministic-qa.ts';
import { sha256File, stageRuntime } from './stage-runtime.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(scriptDirectory, 'fixtures', 'deterministic-runtime');
const fixtureManifest = join(fixtureRoot, 'Cargo.toml');
const target = 'x86_64-pc-windows-msvc';

export function stageDeterministicRuntime() {
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
  return defer(() => from(mkdir(deterministicQaTarget, { recursive: true }))).pipe(
    concatMap(() => defer(() => from(stat(executable)))),
    concatMap((metadata) =>
      defer(() => from(mkdtemp(join(deterministicQaTarget, 'fixture-')))).pipe(
        concatMap((temporary) => {
          const manifestPath = join(
            temporary,
            `manifest-${randomBytes(4).toString('hex')}.json`,
          );
          const schemaPath = join(temporary, 'capture-document-v2.schema.json');
          const schema = `${JSON.stringify(
            {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              $id: 'https://github.com/gx-capture/capture-workbench/schema/capture-document-v2.schema.json',
              title: 'CaptureDocument deterministic QA fixture',
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
                runtimeVersion: RELEASE_VERSION,
                apiVersion: '2.0',
                captureDocumentSchemaVersion: '2',
                platform: 'windows',
                arch: 'x86_64',
                fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
                bytes: metadata.size,
                sha256: digest,
                schemaFileName: 'capture-document-v2.schema.json',
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
            concatMap((result) => defer(() => from(rm(temporary, { recursive: true, force: true }))).pipe(
              map(() => result),
            )),
            catchError((error) => defer(() => from(rm(temporary, { recursive: true, force: true }))).pipe(
              concatMap(() => throwError(() => error)),
            )),
          );
        }),
      ),
    ),
  );
}

stageDeterministicRuntime().subscribe({
  next: ({ manifest }) => {
    process.stdout.write(
      `Staged QA ONLY fake runtime ${manifest.runtimeVersion} and fake data schema under target/deterministic-qa/staged.\n`,
    );
  },
  error: (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
});
