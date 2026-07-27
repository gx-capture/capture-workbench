import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Observable, concatMap, defer, from, map, mergeMap, toArray } from 'rxjs';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import { appRoot, sha256File } from './stage-runtime.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const nsisDirectory = join(
  appRoot,
  'src-tauri',
  'target',
  'x86_64-pc-windows-msvc',
  'release',
  'bundle',
  'nsis',
);
const reportDirectory = join(
  workspaceRoot,
  'tmp',
  'capture-workbench-desktop',
  'package-qa',
);
const reportPath = join(reportDirectory, 'package-qa.json');

export function collectPackageQa(): Observable<{ report: unknown; reportPath: string }> {
  return assertStagedRuntime('deterministic').pipe(
    concatMap(({ manifest, provenance }) =>
      defer(() => from(readdir(nsisDirectory, { withFileTypes: true }))).pipe(
        map((entries) =>
          entries.filter(
            (entry) =>
              entry.isFile() && entry.name.toLowerCase().endsWith('-setup.exe'),
          ),
        ),
        mergeMap((installers) => {
          if (installers.length === 0) {
            throw new Error('No Windows x64 NSIS installer was produced.');
          }
          return from(installers).pipe(
            concatMap((installer) => {
              const path = join(nsisDirectory, installer.name);
              return defer(() => from(stat(path))).pipe(
                concatMap((metadata) =>
                  sha256File(path).pipe(
                    map((sha256) => ({
                      file: relative(workspaceRoot, path).replaceAll('\\', '/'),
                      bytes: metadata.size,
                      sha256,
                    })),
                  ),
                ),
              );
            }),
            toArray(),
            map((artifacts) => ({ manifest, provenance, artifacts })),
          );
        }),
      ),
    ),
    concatMap(({ manifest, provenance, artifacts }) => {
      const report = {
    evidenceKind: 'deterministic-package-qa',
    releaseGateSatisfied: false,
    platform: 'windows',
    arch: 'x86_64',
    bundle: 'nsis',
    runtime: {
      source: provenance.source,
      runtimeVersion: manifest.runtimeVersion,
      apiVersion: manifest.apiVersion,
      captureDocumentSchemaVersion: manifest.captureDocumentSchemaVersion,
      bytes: manifest.bytes,
      sha256: manifest.sha256,
      schemaFileName: manifest.schemaFileName,
      schemaSha256: manifest.schemaSha256,
    },
        artifacts,
        disclaimer:
          'Deterministic fixture evidence only; real WindowsML, Whisper, Ollama, and clean-install release gates remain required.',
      };
      assertRedactedEvidence(report);
      return defer(() => from(mkdir(reportDirectory, { recursive: true }))).pipe(
        concatMap(() =>
          defer(() =>
            from(writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')),
          ),
        ),
        map(() => ({ report, reportPath })),
      );
    }),
  );
}

export function assertRedactedEvidence(value) {
  const serialized = JSON.stringify(value);
  if (/authorization|bearer|api[_-]?token|secret-token/iu.test(serialized)) {
    throw new Error('Package QA evidence contains authorization material.');
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  collectPackageQa().subscribe({
    next: ({ reportPath: path }) => {
      process.stdout.write(`Deterministic package QA report: ${path}\n`);
    },
    error: (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  });
}
