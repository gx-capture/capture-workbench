import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

export async function collectPackageQa() {
  const { manifest, provenance } = await assertStagedRuntime('deterministic');
  const entries = await readdir(nsisDirectory, { withFileTypes: true });
  const installers = entries.filter(
    (entry) =>
      entry.isFile() && entry.name.toLowerCase().endsWith('-setup.exe'),
  );
  if (installers.length === 0) {
    throw new Error('No Windows x64 NSIS installer was produced.');
  }

  const artifacts = [];
  for (const installer of installers) {
    const path = join(nsisDirectory, installer.name);
    const metadata = await stat(path);
    artifacts.push({
      file: relative(workspaceRoot, path).replaceAll('\\', '/'),
      bytes: metadata.size,
      sha256: await sha256File(path),
    });
  }
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
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, reportPath };
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
  collectPackageQa()
    .then(({ reportPath: path }) => {
      process.stdout.write(`Deterministic package QA report: ${path}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
