import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createContractSnapshot } from './create-contract-snapshot.ts';

type ReleaseMode = 'core-only' | 'model-enabled';

function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        '--output',
        '--version',
        '--release-mode',
        '--package-candidate',
        '--runtime-candidate',
      ].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --output <directory> --version <semver> --release-mode <mode> [--package-candidate <directory>] [--runtime-candidate <directory>].',
      );
    }
    values.set(name, value);
  }
  const output = values.get('--output');
  const version = values.get('--version');
  const releaseMode = values.get('--release-mode');
  if (
    !output ||
    !version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    !releaseMode ||
    !['core-only', 'model-enabled'].includes(releaseMode)
  ) {
    throw new Error(
      'Use --output <directory> --version <semver> --release-mode <mode> [--package-candidate <directory>] [--runtime-candidate <directory>].',
    );
  }
  return {
    output: resolve(output),
    version,
    releaseMode: releaseMode as ReleaseMode,
    packageCandidate: values.get('--package-candidate'),
    runtimeCandidate: values.get('--runtime-candidate'),
  };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function copyMatching(
  sourceDirectory: string,
  destinationDirectory: string,
  pattern: RegExp,
  expectedCount: number,
): Promise<string[]> {
  const names = (await readdir(sourceDirectory)).filter((name) =>
    pattern.test(name),
  );
  if (names.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} artifacts matching ${pattern} in ${sourceDirectory}; found ${names.length}.`,
    );
  }
  for (const name of names)
    await cp(join(sourceDirectory, name), join(destinationDirectory, name));
  return names;
}

async function main(): Promise<void> {
  const { output, version, releaseMode, packageCandidate, runtimeCandidate } =
    parseArguments(process.argv.slice(2));
  const root = resolve(import.meta.dirname, '..');
  const runtime = join(output, 'runtime');
  const packages = join(output, 'package');
  const python = join(output, 'python');
  const crate = join(output, 'crate');
  const contracts = join(output, 'contracts');
  const checksums = join(output, 'checksums');
  const desktop = join(output, 'desktop');
  await mkdir(output, { recursive: false });
  await Promise.all(
    [runtime, packages, python, crate, contracts, checksums, desktop].map(
      (path) => mkdir(path),
    ),
  );

  const runtimeSource = runtimeCandidate
    ? join(resolve(runtimeCandidate), 'runtime')
    : resolve(root, 'packages/capture-runtime/dist/release');
  await cp(runtimeSource, runtime, { recursive: true });
  if (runtimeCandidate) {
    const sizeReport = resolve(
      root,
      'packages/capture-runtime/dist/release/runtime-size-report.json',
    );
    await cp(sizeReport, join(runtime, 'runtime-size-report.json'));
    await cp(
      `${sizeReport}.sha256`,
      join(runtime, 'runtime-size-report.json.sha256'),
    );
  }
  const packageNames = await copyMatching(
    packageCandidate
      ? join(resolve(packageCandidate), 'package')
      : resolve(root, 'dist/packs'),
    packages,
    /^(?:gx-capture-capture-workbench|gx-capture-capture-contracts|gx-capture-capture-structuring)-\d+\.\d+\.\d+(?:-[^/]+)?\.tgz$/u,
    3,
  );
  const pythonNames = [
    ...(await copyMatching(
      runtimeCandidate
        ? join(resolve(runtimeCandidate), 'python')
        : resolve(root, 'packages/capture-contracts/python/dist'),
      python,
      new RegExp(
        `^capture_contracts-${version.replaceAll('.', '\\.')}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`,
        'u',
      ),
      2,
    )),
    ...(await copyMatching(
      runtimeCandidate
        ? join(resolve(runtimeCandidate), 'python')
        : resolve(root, 'packages/capture-structuring-python/dist'),
      python,
      new RegExp(
        `^capture_structuring-${version.replaceAll('.', '\\.')}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`,
        'u',
      ),
      2,
    )),
  ];
  const crateName = `capture-sidecar-launcher-${version}.crate`;
  await cp(
    runtimeCandidate
      ? join(resolve(runtimeCandidate), 'crate', crateName)
      : resolve(
          root,
          `packages/capture-sidecar-launcher/target/package/${crateName}`,
        ),
    join(crate, crateName),
  );
  const installerName = `Capture Workbench_${version}_x64-setup.exe`;
  const installers = (
    await readdir(
      resolve(
        root,
        'apps/capture-workbench-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis',
      ),
    )
  ).filter((name) => name === installerName);
  if (installers.length !== 1)
    throw new Error(`Expected one NSIS installer; found ${installers.length}.`);
  const sourceInstaller = resolve(
    root,
    `apps/capture-workbench-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/${installers[0]}`,
  );
  const candidateInstallerName = `Capture.Workbench_${version}_x64-setup.exe`;
  await cp(sourceInstaller, join(desktop, candidateInstallerName));
  const sourceMetadata = await stat(sourceInstaller);
  const sourceDigest = await sha256(sourceInstaller);
  const stagedMetadata = await stat(join(desktop, candidateInstallerName));
  if (
    sourceMetadata.size !== stagedMetadata.size ||
    sourceDigest !== (await sha256(join(desktop, candidateInstallerName)))
  ) {
    throw new Error(
      'Staged installer bytes differ from the Tauri-generated installer.',
    );
  }

  const reportPath = join(runtime, 'runtime-size-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<
    string,
    any
  >;
  if (
    report.nsisInstaller?.fileName !== installers[0] ||
    report.nsisInstaller?.bytes !== sourceMetadata.size ||
    report.nsisInstaller?.sha256 !== sourceDigest
  ) {
    throw new Error(
      'Installed-size report does not bind the Tauri-generated installer.',
    );
  }
  report.nsisInstaller = {
    path: `desktop/${candidateInstallerName}`,
    fileName: candidateInstallerName,
    bytes: stagedMetadata.size,
    sha256: sourceDigest,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(
    `${reportPath}.sha256`,
    `${await sha256(reportPath)}  runtime-size-report.json\n`,
    'utf8',
  );
  await writeFile(
    join(contracts, 'contract-snapshot.json'),
    `${JSON.stringify(await createContractSnapshot(root), null, 2)}\n`,
    'utf8',
  );

  for (const name of [...packageNames, ...pythonNames, crateName]) {
    const directory = packageNames.includes(name)
      ? packages
      : pythonNames.includes(name)
        ? python
        : crate;
    await writeFile(
      join(checksums, `${name}.sha256`),
      `${await sha256(join(directory, name))}  ${name}\n`,
      'utf8',
    );
  }
  process.stdout.write(
    `Assembled ${releaseMode} release candidate ${version} at ${output}.\n`,
  );
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
