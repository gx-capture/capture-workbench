import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageName = '@wodenwang820118/capture-angular';
const registry = 'https://npm.pkg.github.com';
const runtimeAssetNames = Object.freeze([
  'capture-runtime-x86_64-pc-windows-msvc.exe',
  'capture-runtime-x86_64-pc-windows-msvc.exe.sha256',
  'capture-runtime-manifest.json',
  'capture-document-v1.schema.json',
]);

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(-2000)}`,
    );
  }
  return result;
}

export async function sha512Integrity(path) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha512-${hash.digest('base64')}`;
}

export function packagePublicationDecision(existingIntegrity, localIntegrity) {
  if (existingIntegrity === undefined) return 'publish';
  if (existingIntegrity === localIntegrity) return 'already-published';
  throw new Error(
    'Published package integrity differs from the local synchronized package.',
  );
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--tag', '--runtime-dir', '--package'].includes(name) || !value) {
      throw new Error('Use --tag, --runtime-dir, and --package exactly once.');
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error('Use --tag, --runtime-dir, and --package exactly once.');
  }
  const tag = values.get('--tag');
  if (!/^v\d+\.\d+\.\d+$/u.test(tag))
    throw new Error('Release tag must be vMAJOR.MINOR.PATCH.');
  return {
    tag,
    version: tag.slice(1),
    runtimeDirectory: resolve(values.get('--runtime-dir')),
    packagePath: resolve(values.get('--package')),
  };
}

async function exactRuntimeAssets(runtimeDirectory) {
  const paths = runtimeAssetNames.map((name) => join(runtimeDirectory, name));
  for (const [index, path] of paths.entries()) {
    const metadata = await stat(path);
    if (!metadata.isFile())
      throw new Error(`Runtime release asset is not a file: ${path}`);
    if (basename(path) !== runtimeAssetNames[index]) {
      throw new Error('Runtime release asset name is not canonical.');
    }
  }
  return paths;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertSameFile(left, right) {
  const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
  if (
    leftStat.size !== rightStat.size ||
    (await sha256(left)) !== (await sha256(right))
  ) {
    throw new Error(
      `Published runtime asset differs from local bytes: ${basename(left)}`,
    );
  }
}

function releaseState(tag, runCommand) {
  const result = runCommand(
    'gh',
    ['release', 'view', tag, '--json', 'isDraft'],
    {
      allowFailure: true,
    },
  );
  if (result.status !== 0) {
    if (
      /release not found|HTTP 404|not found/iu.test(
        result.stderr || result.stdout || '',
      )
    ) {
      return 'missing';
    }
    throw new Error(
      `Unable to inspect release ${tag}: ${(result.stderr || '').slice(-1000)}`,
    );
  }
  return JSON.parse(result.stdout).isDraft ? 'draft' : 'public';
}

async function ensureRuntimeReleasePublic(tag, runtimeDirectory, runCommand) {
  const assets = await exactRuntimeAssets(runtimeDirectory);
  let state = releaseState(tag, runCommand);
  if (state === 'missing') {
    runCommand('gh', [
      'release',
      'create',
      tag,
      '--verify-tag',
      '--draft',
      '--generate-notes',
    ]);
    state = 'draft';
  }
  if (state === 'draft') {
    for (const asset of assets)
      runCommand('gh', ['release', 'upload', tag, asset, '--clobber']);
    runCommand('gh', ['release', 'edit', tag, '--verify-tag', '--draft=false']);
  } else {
    const temporary = await mkdtemp(join(tmpdir(), 'capture-release-verify-'));
    try {
      for (const asset of assets) {
        runCommand('gh', [
          'release',
          'download',
          tag,
          '--pattern',
          basename(asset),
          '--dir',
          temporary,
          '--clobber',
        ]);
        await assertSameFile(asset, join(temporary, basename(asset)));
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  if (releaseState(tag, runCommand) !== 'public')
    throw new Error('Runtime release did not become public.');
}

function existingPackageIntegrity(version, runCommand) {
  const result = runCommand(
    'npm',
    [
      'view',
      `${packageName}@${version}`,
      'dist.integrity',
      '--json',
      '--registry',
      registry,
    ],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    if (/E404|404 Not Found/iu.test(result.stderr || result.stdout || ''))
      return undefined;
    throw new Error(
      `Unable to inspect package version: ${(result.stderr || '').slice(-1000)}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed !== 'string' || !parsed.startsWith('sha512-')) {
    throw new Error('Registry returned an invalid package integrity value.');
  }
  return parsed;
}

export async function preflightPackagePublication(
  version,
  packagePath,
  { runCommand = run, lstatPath = lstat } = {},
) {
  const metadata = await lstatPath(packagePath);
  if (!metadata.isFile() || !packagePath.endsWith('.tgz')) {
    throw new Error('Angular publication input must be one .tgz file.');
  }
  const localIntegrity = await sha512Integrity(packagePath);
  const inspection = runCommand('npm', [
    'pack',
    '--dry-run',
    '--json',
    packagePath,
  ]);
  const inspected = JSON.parse(inspection.stdout);
  if (
    !Array.isArray(inspected) ||
    inspected.length !== 1 ||
    inspected[0].name !== packageName ||
    inspected[0].version !== version ||
    inspected[0].integrity !== localIntegrity
  ) {
    throw new Error(
      'Angular tarball identity/version/integrity does not match the release tag.',
    );
  }
  const existingIntegrity = existingPackageIntegrity(version, runCommand);
  return Object.freeze({
    version,
    packagePath,
    localIntegrity,
    decision: packagePublicationDecision(existingIntegrity, localIntegrity),
  });
}

async function applyPackagePublication(plan, runCommand) {
  const currentDecision = packagePublicationDecision(
    existingPackageIntegrity(plan.version, runCommand),
    plan.localIntegrity,
  );
  if (currentDecision === 'publish') {
    runCommand('npm', [
      'publish',
      plan.packagePath,
      '--registry',
      registry,
      '--access',
      'public',
    ]);
  }
  const publishedIntegrity = existingPackageIntegrity(plan.version, runCommand);
  if (publishedIntegrity === undefined) {
    throw new Error(
      'Package registry did not expose the version after publish.',
    );
  }
  packagePublicationDecision(publishedIntegrity, plan.localIntegrity);
}

export async function publishRelease(
  { tag, version, runtimeDirectory, packagePath },
  { runCommand = run } = {},
) {
  const packagePlan = await preflightPackagePublication(version, packagePath, {
    runCommand,
  });
  await ensureRuntimeReleasePublic(tag, runtimeDirectory, runCommand);
  await applyPackagePublication(packagePlan, runCommand);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  publishRelease(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
