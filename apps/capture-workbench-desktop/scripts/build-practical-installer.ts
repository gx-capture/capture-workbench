import { execFileSync, spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { firstValueFrom } from 'rxjs';

import {
  RUNTIME_EXECUTABLE_NAME,
  RUNTIME_MANIFEST_NAME,
  RUNTIME_SCHEMA_NAME,
  assertAbsent,
  assertNsisTargetsOnlyVariant,
  assertPracticalProvenance,
  assertSha256,
  practicalInstallerFileName,
  practicalOverlay,
  practicalVariant,
  sha256Hex,
  verifyRuntimeReleaseDirectory,
  type PracticalInstallerProvenance,
  type PracticalMode,
} from './practical-installed.ts';
import { appRoot, sha256File, stageRuntime } from './stage-runtime.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
export const practicalRoot = join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'practical-installed');
// Shared across runs for incremental Cargo builds and kept apart from the
// ordinary release target, whose bundle directory must remain untouched.
const cargoTargetDir = join(practicalRoot, 'cargo-target');

export interface BuildPracticalInstallerArguments {
  readonly mode: PracticalMode;
  readonly runtimeRelease: string;
  readonly runtimeSha256: string;
  readonly runId: string;
}

export function parseBuildArguments(args: readonly string[]): BuildPracticalInstallerArguments {
  const allowed = ['--mode', '--runtime-release', '--runtime-sha256', '--run-id'];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.includes(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error(
        'Use --mode <rehearsal|published> --runtime-release <directory> --runtime-sha256 <sha256> --run-id <id>.',
      );
    }
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`Missing required ${name}.`);
  }
  const mode = values.get('--mode');
  if (mode !== 'rehearsal' && mode !== 'published') {
    throw new Error('--mode must be rehearsal or published.');
  }
  const runtimeSha256 = values.get('--runtime-sha256') ?? '';
  assertSha256(runtimeSha256, '--runtime-sha256');
  const runId = values.get('--run-id') ?? '';
  practicalVariant(runId);
  return { mode, runtimeRelease: resolve(values.get('--runtime-release') ?? ''), runtimeSha256, runId };
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true }).trim();
}

function runTauriBuild(overlayPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'corepack',
      [
        'pnpm',
        'exec',
        'tauri',
        'build',
        '--target',
        'x86_64-pc-windows-msvc',
        '--bundles',
        'nsis',
        '--ci',
        '--config',
        'apps/capture-workbench-desktop/src-tauri/tauri.conf.json',
        '--config',
        `"${overlayPath}"`,
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
        shell: true,
        windowsHide: false,
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Practical NSIS Tauri build failed with exit code ${code ?? 'unknown'}.`));
    });
  });
}

export async function buildPracticalInstaller(
  input: BuildPracticalInstallerArguments,
): Promise<{ readonly provenancePath: string; readonly provenance: PracticalInstallerProvenance }> {
  if (process.platform !== 'win32') throw new Error('Practical installers are Windows x64 NSIS bundles.');
  const variant = practicalVariant(input.runId);
  const releaseVersion = JSON.parse(await readFile(join(workspaceRoot, 'release', 'version.json'), 'utf8'))
    .releaseVersion as string;
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const sourceTreeClean = git(['status', '--porcelain', '--untracked-files=no']).length === 0;
  if (input.mode === 'published' && !sourceTreeClean) {
    throw new Error('Published practical installers require a clean tracked source tree.');
  }

  const runRoot = join(practicalRoot, input.runId);
  await assertAbsent([runRoot], 'Practical run directory');
  const release = await verifyRuntimeReleaseDirectory(input.runtimeRelease, input.runtimeSha256, releaseVersion);
  await mkdir(runRoot, { recursive: true });

  // Staging copies and validates the exact release bytes; nothing is rebuilt.
  await firstValueFrom(
    stageRuntime({
      artifactPath: join(release.directory, RUNTIME_EXECUTABLE_NAME),
      manifestPath: join(release.directory, RUNTIME_MANIFEST_NAME),
      schemaPath: join(release.directory, RUNTIME_SCHEMA_NAME),
      source: 'release',
    }),
  );
  const stagedExecutable = join(appRoot, 'src-tauri', 'binaries', RUNTIME_EXECUTABLE_NAME);
  if ((await firstValueFrom(sha256File(stagedExecutable))) !== release.executable.sha256) {
    throw new Error('Staged runtime differs from the verified release executable.');
  }

  const overlayBytes = Buffer.from(`${JSON.stringify(practicalOverlay(variant), null, 2)}\n`, 'utf8');
  const overlayPath = join(runRoot, 'tauri.practical.json');
  await writeFile(overlayPath, overlayBytes, { flag: 'wx' });
  await runTauriBuild(overlayPath);

  const releaseDirectory = join(cargoTargetDir, 'x86_64-pc-windows-msvc', 'release');
  assertNsisTargetsOnlyVariant(
    await readFile(join(releaseDirectory, 'nsis', 'x64', 'installer.nsi'), 'utf8'),
    variant,
  );
  const installerName = practicalInstallerFileName(variant, releaseVersion);
  const builtInstaller = join(releaseDirectory, 'bundle', 'nsis', installerName);
  if (!(await lstat(builtInstaller).catch(() => undefined))?.isFile()) {
    throw new Error('Practical NSIS build did not produce the expected installer.');
  }
  const installerPath = join(runRoot, installerName);
  await copyFile(builtInstaller, installerPath);
  const installerBytes = await readFile(installerPath);

  const provenance: PracticalInstallerProvenance = {
    schemaVersion: '1',
    evidenceKind: 'capture-practical-installer',
    mode: input.mode,
    variant,
    sourceCommit,
    sourceTreeClean,
    releaseVersion,
    runtime: {
      runtimeVersion: release.runtimeVersion,
      executable: release.executable,
      manifest: release.manifest,
      schema: release.schema,
      catalog: release.catalog,
      workers: release.workers,
    },
    overlaySha256: sha256Hex(overlayBytes),
    installer: { fileName: installerName, bytes: installerBytes.length, sha256: sha256Hex(installerBytes) },
  };
  assertPracticalProvenance(provenance);
  const provenancePath = join(runRoot, 'installer-provenance.json');
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
  return { provenancePath, provenance };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildPracticalInstaller(parseBuildArguments(process.argv.slice(2))).then(
    ({ provenancePath }) => process.stdout.write(`Practical installer provenance: ${provenancePath}\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
