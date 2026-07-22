import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sha256File, stageRuntime } from './stage-runtime.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(scriptDirectory, 'fixtures', 'deterministic-runtime');
const fixtureManifest = join(fixtureRoot, 'Cargo.toml');
const target = 'x86_64-pc-windows-msvc';

export async function stageDeterministicRuntime() {
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
  const metadata = await stat(executable);
  const temporary = await mkdtemp(join(tmpdir(), 'capture-workbench-runtime-'));
  try {
    const manifestPath = join(
      temporary,
      `manifest-${randomBytes(4).toString('hex')}.json`,
    );
    const schemaPath = join(temporary, 'capture-document-v1.schema.json');
    await writeFile(
      schemaPath,
      `${JSON.stringify(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: 'https://github.com/WodenWang820118/capture-workbench/schema/capture-document-v1.schema.json',
          title: 'CaptureDocumentV1 deterministic QA fixture',
          type: 'object',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const manifest = {
      manifestVersion: '1',
      runtimeVersion: '0.1.0',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      platform: 'windows',
      arch: 'x86_64',
      fileName: 'capture-runtime-x86_64-pc-windows-msvc.exe',
      bytes: metadata.size,
      sha256: await sha256File(executable),
      schemaFileName: 'capture-document-v1.schema.json',
      schemaSha256: await sha256File(schemaPath),
      runtimeRequirements: {
        'windowsml-ocr': {
          artifactUrl:
            'https://downloads.example.org/capture-windowsml-ocr-windows-x64.zip',
          artifactFileName: 'capture-windowsml-ocr-windows-x64.zip',
          bytes: 1,
          sha256: '0'.repeat(64),
        },
      },
    };
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    return await stageRuntime({
      artifactPath: executable,
      manifestPath,
      schemaPath,
      source: 'deterministic',
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

stageDeterministicRuntime()
  .then(({ manifest }) => {
    process.stdout.write(
      `Staged deterministic runtime ${manifest.runtimeVersion} for QA only.\n`,
    );
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
