import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Observable, defer, from, map } from 'rxjs';

const packageName = '@gx-capture/capture-workbench-ui';
const releasePackageNames = Object.freeze([
  packageName,
  '@gx-capture/capture-runtime-client',
  '@gx-capture/capture-structuring',
]);
const registry = 'https://npm.pkg.github.com';
const coreRuntimeAssetNames = Object.freeze([
  'capture-runtime-x86_64-pc-windows-msvc.exe',
  'capture-runtime-x86_64-pc-windows-msvc.exe.sha256',
  'capture-runtime-manifest.json',
  'capture-document-v2.schema.json',
]);
const engineCatalogName = 'capture-engine-catalog.json';
const runtimeSizeReportName = 'runtime-size-report.json';
const sizeReportFields = Object.freeze([
  'arch',
  'installedBytes',
  'installedBytesBlocker',
  'nsisInstaller',
  'platform',
  'pyinstaller',
  'pythonVersion',
  'reportVersion',
  'runtimeExecutable',
]);
const sizeArtifactFields = Object.freeze([
  'bytes',
  'fileName',
  'path',
  'sha256',
]);
const pyinstallerFields = Object.freeze([
  'blocker',
  'categories',
  'files',
  'topFiles',
]);
const pyinstallerCategoryFields = Object.freeze([
  'core',
  'ocr',
  'other',
  'pdf',
  'whisper',
]);
const pyinstallerFileFields = Object.freeze(['bytes', 'path']);
const githubStableAssetNamePattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

function feasibilityReleaseNotes(version) {
  const packageSummary = releasePackageNames
    .map((name) => `\`${name}@${version}\``)
    .join(' and ');
  return [
    '## Windows installer feasibility notice',
    `This is an unsigned feasibility release for Capture Workbench v${version}.`,
    'The NSIS installer is not Authenticode-signed; Windows may show an Unknown publisher or SmartScreen warning.',
    'Verify the SHA-256 checksum for every downloaded GitHub Release asset before running the installer.',
    `${packageSummary} are published only to GitHub Packages; each package tarball is a workflow handoff and registry artifact, never a GitHub Release asset.`,
  ].join('\n\n');
}

function hasExactFields(value, fields) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function assertGitHubStableAssetNames(names, label) {
  if (new Set(names).size !== names.length) {
    throw new Error(`${label} contains duplicate asset basenames.`);
  }
  const invalid = names.filter(
    (name) =>
      typeof name !== 'string' ||
      name !== basename(name) ||
      !githubStableAssetNamePattern.test(name),
  );
  if (invalid.length > 0) {
    throw new Error(
      `${label} contains GitHub-unstable asset basenames: ${invalid.join(', ')}.`,
    );
  }
}

function isJsonInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isCanonicalSizeArtifact(value) {
  return (
    hasExactFields(value, sizeArtifactFields) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.fileName === 'string' &&
    value.fileName.length > 0 &&
    basename(value.path) === value.fileName &&
    isJsonInteger(value.bytes, 1) &&
    isSha256(value.sha256)
  );
}

function isCanonicalPyinstallerFile(value) {
  return (
    hasExactFields(value, pyinstallerFileFields) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    isJsonInteger(value.bytes)
  );
}

function isCanonicalPyinstaller(value) {
  if (!hasExactFields(value, pyinstallerFields)) return false;
  const categories = value.categories;
  return (
    Array.isArray(value.files) &&
    value.files.every(isCanonicalPyinstallerFile) &&
    Array.isArray(value.topFiles) &&
    value.topFiles.every(isCanonicalPyinstallerFile) &&
    hasExactFields(categories, pyinstallerCategoryFields) &&
    Object.values(categories).every((bytes) => isJsonInteger(bytes)) &&
    (value.blocker === null || typeof value.blocker === 'string')
  );
}

function isCanonicalSizeReport(value) {
  return (
    hasExactFields(value, sizeReportFields) &&
    value.reportVersion === '2' &&
    ['arch', 'platform', 'pythonVersion'].every(
      (field) => typeof value[field] === 'string' && value[field].length > 0,
    ) &&
    isCanonicalSizeArtifact(value.runtimeExecutable) &&
    isCanonicalSizeArtifact(value.nsisInstaller) &&
    isJsonInteger(value.installedBytes, 1) &&
    value.installedBytesBlocker === null &&
    isCanonicalPyinstaller(value.pyinstaller)
  );
}

function run(command, args, { allowFailure = false } = {}) {
  const executable =
    process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32' && executable.endsWith('.cmd'),
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

function hashFile(path, algorithm, encoding = 'hex') {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveHash(hash.digest(encoding)));
  });
}

export function sha512Integrity(path) {
  return defer(() => from(hashFile(path, 'sha512', 'base64'))).pipe(
    map((digest) => `sha512-${digest}`),
  );
}

export function packagePublicationDecision(existingIntegrity, localIntegrity) {
  if (existingIntegrity === undefined) return 'publish';
  if (existingIntegrity === localIntegrity) return 'already-published';
  throw new Error(
    'Published package integrity differs from the local synchronized package.',
  );
}

export function parseArguments(args) {
  const required = new Set(['--tag', '--runtime-dir', '--installer']);
  const allowed = new Set([...required, '--package']);
  const values = new Map();
  const packagePaths = [];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name) || !value) {
      throw new Error(
        'Use --tag, --runtime-dir, and --installer exactly once, plus one or more --package arguments.',
      );
    }
    if (name === '--package') {
      packagePaths.push(value);
    } else {
      if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
      values.set(name, value);
    }
  }
  if (values.size !== required.size || packagePaths.length === 0) {
    throw new Error(
      'Use --tag, --runtime-dir, and --installer exactly once, plus one or more --package arguments.',
    );
  }
  const tag = values.get('--tag');
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) {
    throw new Error('Release tag must be vMAJOR.MINOR.PATCH.');
  }
  return Object.freeze({
    tag,
    version: tag.slice(1),
    runtimeDirectory: resolve(values.get('--runtime-dir')),
    installerPath: resolve(values.get('--installer')),
    packagePaths: Object.freeze(packagePaths.map((path) => resolve(path))),
  });
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  return metadata;
}

async function inspectPackage(version, packagePath, runCommand) {
  await assertRegularFile(packagePath, 'Release package');
  if (!packagePath.endsWith('.tgz')) {
    throw new Error('Release package input must be a .tgz file.');
  }
  const localIntegrity = `sha512-${await hashFile(
    packagePath,
    'sha512',
    'base64',
  )}`;
  const inspectionResult = runCommand('npm', [
    'pack',
    '--dry-run',
    '--json',
    packagePath,
  ]);
  const inspection = JSON.parse(inspectionResult.stdout);
  if (
    !Array.isArray(inspection) ||
    inspection.length !== 1 ||
    !releasePackageNames.includes(inspection[0].name) ||
    inspection[0].version !== version ||
    inspection[0].integrity !== localIntegrity
  ) {
    throw new Error(
      'Release package tarball identity/version/integrity does not match the release tag.',
    );
  }
  return Object.freeze({
    localIntegrity,
    name: inspection[0].name,
    packagePath,
    version,
  });
}

async function preflightCandidate(input, runCommand) {
  const runtimeEntries = await readdir(input.runtimeDirectory);
  const coreRuntimeAssets = coreRuntimeAssetNames.map((name) =>
    join(input.runtimeDirectory, name),
  );
  for (const path of coreRuntimeAssets) {
    await assertRegularFile(path, `Runtime asset ${basename(path)}`);
  }
  const catalogPath = join(input.runtimeDirectory, engineCatalogName);
  const sizeReportPath = join(input.runtimeDirectory, runtimeSizeReportName);
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const catalogFields =
    catalog && typeof catalog === 'object' ? Object.keys(catalog).sort() : [];
  const requirementIds = Array.isArray(catalog?.requirements)
    ? catalog.requirements.map((item) => item?.requirementId).sort()
    : null;
  const validRequirementSet =
    requirementIds !== null &&
    (requirementIds.length === 0 ||
      JSON.stringify(requirementIds) ===
        JSON.stringify(['whisper-primary', 'windowsml-ocr']));
  if (
    JSON.stringify(catalogFields) !==
      JSON.stringify(['catalogVersion', 'requirements', 'runtimeVersion']) ||
    catalog?.catalogVersion !== '2' ||
    catalog?.runtimeVersion !== input.version ||
    !validRequirementSet
  ) {
    throw new Error(
      'Engine catalog identity, version, or requirement set is invalid.',
    );
  }
  const descriptors = catalog.requirements.flatMap((requirement) => {
    if (
      requirement.unavailableReason !== null ||
      !Array.isArray(requirement.artifacts) ||
      requirement.artifacts.length !== 1 ||
      requirement.artifacts.some(
        (artifact) =>
          artifact.requirementId !== requirement.requirementId ||
          artifact.role !== 'worker',
      ) ||
      requirement.modelFiles?.artifactVersion !== input.version ||
      requirement.modelFiles?.entryPoint !== 'model' ||
      !Number.isSafeInteger(requirement.modelFiles?.entryCount) ||
      requirement.modelFiles.entryCount < 1 ||
      !Array.isArray(requirement.modelFiles?.files) ||
      requirement.modelFiles.files.length !==
        requirement.modelFiles.entryCount ||
      !Number.isSafeInteger(requirement.modelFiles?.extractedBytes) ||
      requirement.modelFiles.extractedBytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(requirement.modelFiles?.manifestSha256) ||
      !/^[a-f0-9]{64}$/u.test(requirement.modelFiles?.sourceLockSha256)
    ) {
      throw new Error(
        `Engine catalog requirement is incomplete: ${String(requirement.requirementId)}.`,
      );
    }
    return requirement.artifacts;
  });
  const descriptorNames = descriptors.map((descriptor) => descriptor.fileName);
  if (new Set(descriptorNames).size !== descriptorNames.length) {
    throw new Error('Engine catalog worker archive names must be unique.');
  }
  const sidecarNames = runtimeEntries.filter((name) =>
    name.endsWith('-files.json'),
  );
  const engineAssetNames = new Set();
  for (const descriptor of descriptors) {
    if (
      descriptor.role !== 'worker' ||
      typeof descriptor.fileName !== 'string' ||
      descriptor.fileName !== basename(descriptor.fileName) ||
      !descriptor.fileName.endsWith('.zip') ||
      !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(descriptor.sha256) ||
      !/^[a-f0-9]{64}$/u.test(descriptor.filesManifestSha256)
    ) {
      throw new Error('Engine catalog artifact descriptor is invalid.');
    }
    const archive = join(input.runtimeDirectory, descriptor.fileName);
    const archiveMetadata = await assertRegularFile(
      archive,
      `Engine archive ${descriptor.fileName}`,
    );
    if (
      archiveMetadata.size !== descriptor.bytes ||
      (await hashFile(archive, 'sha256')) !== descriptor.sha256
    ) {
      throw new Error(
        `Engine archive differs from catalog: ${descriptor.fileName}.`,
      );
    }
    const matchingSidecars = [];
    for (const name of sidecarNames) {
      const candidate = join(input.runtimeDirectory, name);
      if (
        (await hashFile(candidate, 'sha256')) === descriptor.filesManifestSha256
      ) {
        matchingSidecars.push(name);
      }
    }
    if (matchingSidecars.length !== 1) {
      throw new Error(
        `Engine archive needs exactly one matching files manifest: ${descriptor.fileName}.`,
      );
    }
    for (const name of [descriptor.fileName, matchingSidecars[0]]) {
      const asset = join(input.runtimeDirectory, name);
      const checksum = join(input.runtimeDirectory, `${name}.sha256`);
      await assertRegularFile(checksum, `Checksum for ${name}`);
      if (
        (await readFile(checksum, 'utf8')).trim() !==
        `${await hashFile(asset, 'sha256')}  ${name}`
      ) {
        throw new Error(`Release checksum does not match ${name}.`);
      }
      engineAssetNames.add(name);
      engineAssetNames.add(`${name}.sha256`);
    }
  }
  for (const name of [engineCatalogName, runtimeSizeReportName]) {
    const asset = join(input.runtimeDirectory, name);
    const checksum = join(input.runtimeDirectory, `${name}.sha256`);
    await assertRegularFile(asset, name);
    await assertRegularFile(checksum, `Checksum for ${name}`);
    if (
      (await readFile(checksum, 'utf8')).trim() !==
      `${await hashFile(asset, 'sha256')}  ${name}`
    ) {
      throw new Error(`Release checksum does not match ${name}.`);
    }
  }
  const expectedEntries = [
    ...coreRuntimeAssetNames,
    ...engineAssetNames,
    engineCatalogName,
    `${engineCatalogName}.sha256`,
    runtimeSizeReportName,
    `${runtimeSizeReportName}.sha256`,
  ].sort();
  if (
    JSON.stringify([...runtimeEntries].sort()) !==
    JSON.stringify(expectedEntries)
  ) {
    throw new Error(
      'Runtime release directory must contain only catalogued canonical assets.',
    );
  }
  const runtimeAssets = expectedEntries.map((name) =>
    join(input.runtimeDirectory, name),
  );
  const installerMetadata = await assertRegularFile(
    input.installerPath,
    'NSIS installer',
  );
  if (
    !input.installerPath.toLowerCase().endsWith('.exe') ||
    resolve(input.installerPath) === resolve(coreRuntimeAssets[0]) ||
    dirname(resolve(input.installerPath)) === resolve(input.runtimeDirectory) ||
    expectedEntries.includes(basename(input.installerPath))
  ) {
    throw new Error(
      'NSIS installer must be the distinct release-candidate installer executable.',
    );
  }
  if (installerMetadata.size === 0) {
    throw new Error('NSIS installer is empty.');
  }

  const executable = coreRuntimeAssets[0];
  const executableMetadata = await stat(executable);
  const executableDigest = await hashFile(executable, 'sha256');
  const checksum = (await readFile(coreRuntimeAssets[1], 'utf8')).trim();
  if (checksum !== `${executableDigest}  ${basename(executable)}`) {
    throw new Error('Runtime executable checksum file does not match.');
  }
  const manifest = JSON.parse(await readFile(coreRuntimeAssets[2], 'utf8'));
  const schemaDigest = await hashFile(coreRuntimeAssets[3], 'sha256');
  if (
    manifest.runtimeVersion !== input.version ||
    manifest.fileName !== basename(executable) ||
    manifest.bytes !== executableMetadata.size ||
    manifest.sha256 !== executableDigest ||
    manifest.schemaFileName !== basename(coreRuntimeAssets[3]) ||
    manifest.schemaSha256 !== schemaDigest
  ) {
    throw new Error(
      'Runtime manifest, schema, executable, and release version are inconsistent.',
    );
  }
  JSON.parse(await readFile(coreRuntimeAssets[3], 'utf8'));
  const sizeReport = JSON.parse(await readFile(sizeReportPath, 'utf8'));
  if (
    !isCanonicalSizeReport(sizeReport) ||
    sizeReport.runtimeExecutable.fileName !== basename(executable) ||
    sizeReport.runtimeExecutable.bytes !== executableMetadata.size ||
    sizeReport.runtimeExecutable.sha256 !== executableDigest ||
    sizeReport.nsisInstaller.fileName !== basename(input.installerPath) ||
    sizeReport.nsisInstaller.bytes !== installerMetadata.size ||
    sizeReport.nsisInstaller.sha256 !==
      (await hashFile(input.installerPath, 'sha256'))
  ) {
    throw new Error(
      'Runtime size report does not match the exact release candidate.',
    );
  }
  const assets = [...runtimeAssets, input.installerPath];
  // GitHub normalizes some asset names. Reject candidates which cannot make an
  // exact inventory round trip before any release or package mutation.
  assertGitHubStableAssetNames(
    assets.map((asset) => basename(asset)),
    'Local release candidate',
  );
  const packagePaths =
    input.packagePaths ?? (input.packagePath ? [input.packagePath] : []);
  if (packagePaths.length !== releasePackageNames.length) {
    throw new Error(
      `Release candidate must contain exactly one tarball for each of: ${releasePackageNames.join(', ')}.`,
    );
  }
  const packagePlans = await Promise.all(
    packagePaths.map((path) => inspectPackage(input.version, path, runCommand)),
  );
  const packagePlanNames = packagePlans.map((plan) => plan.name);
  if (
    new Set(packagePlanNames).size !== packagePlanNames.length ||
    releasePackageNames.some((name) => !packagePlanNames.includes(name))
  ) {
    throw new Error(
      `Release candidate must contain exactly one tarball for each of: ${releasePackageNames.join(', ')}.`,
    );
  }
  return Object.freeze({
    assets,
    packagePlans,
  });
}

function releaseState(tag, runCommand) {
  const result = runCommand(
    'gh',
    ['release', 'view', tag, '--json', 'isDraft'],
    { allowFailure: true },
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
      `Unable to inspect release ${tag}: ${(result.stderr || result.stdout || '').slice(-1000)}`,
    );
  }
  return JSON.parse(result.stdout).isDraft ? 'draft' : 'public';
}

function remoteAssetNames(tag, runCommand) {
  const result = runCommand('gh', ['release', 'view', tag, '--json', 'assets']);
  const payload = JSON.parse(result.stdout);
  if (
    !Array.isArray(payload?.assets) ||
    payload.assets.some(
      (asset) =>
        typeof asset?.name !== 'string' ||
        asset.name.length === 0 ||
        asset.name !== basename(asset.name),
    )
  ) {
    throw new Error('Release returned an invalid remote asset-name set.');
  }
  const names = payload.assets.map((asset) => asset.name);
  assertGitHubStableAssetNames(names, 'Release remote inventory');
  return names;
}

function assertRemoteAssetNames(tag, assets, runCommand, { allowMissing }) {
  const expected = assets.map((asset) => basename(asset)).sort();
  assertGitHubStableAssetNames(expected, 'Expected release assets');
  const actual = remoteAssetNames(tag, runCommand);
  if (new Set(actual).size !== actual.length) {
    throw new Error('Release contains duplicate remote asset names.');
  }
  const expectedSet = new Set(expected);
  const extras = actual.filter((name) => !expectedSet.has(name)).sort();
  if (extras.length > 0) {
    throw new Error(
      `Release contains unexpected remote assets: ${extras.join(', ')}.`,
    );
  }
  const actualSet = new Set(actual);
  const missing = expected.filter((name) => !actualSet.has(name));
  if (!allowMissing && missing.length > 0) {
    throw new Error(`Release assets are missing: ${missing.join(', ')}.`);
  }
  return actualSet;
}

function existingPackageIntegrity(name, version, runCommand) {
  const result = runCommand(
    'npm',
    [
      'view',
      `${name}@${version}`,
      'dist.integrity',
      '--json',
      '--registry',
      registry,
    ],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    if (/E404|404 Not Found/iu.test(result.stderr || result.stdout || '')) {
      return undefined;
    }
    throw new Error(
      `Unable to inspect package version: ${(result.stderr || result.stdout || '').slice(-1000)}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed !== 'string' || !parsed.startsWith('sha512-')) {
    throw new Error('Registry returned an invalid package integrity value.');
  }
  return parsed;
}

async function assertSameFile(left, right) {
  const [leftStat, rightStat, leftDigest, rightDigest] = await Promise.all([
    stat(left),
    stat(right),
    hashFile(left, 'sha256'),
    hashFile(right, 'sha256'),
  ]);
  if (leftStat.size !== rightStat.size || leftDigest !== rightDigest) {
    throw new Error(
      `Published release asset differs from local bytes: ${basename(left)}`,
    );
  }
}

async function remoteAssetStatus(tag, asset, runCommand) {
  const temporary = await mkdtemp(join(tmpdir(), 'capture-release-asset-'));
  try {
    const result = runCommand(
      'gh',
      [
        'release',
        'download',
        tag,
        '--pattern',
        basename(asset),
        '--dir',
        temporary,
      ],
      { allowFailure: true },
    );
    if (result.status !== 0) {
      if (
        /no assets matched|not found|HTTP 404/iu.test(
          result.stderr || result.stdout || '',
        )
      ) {
        return 'missing';
      }
      throw new Error(
        `Unable to download release asset ${basename(asset)}: ${(
          result.stderr ||
          result.stdout ||
          ''
        ).slice(-1000)}`,
      );
    }
    await assertSameFile(asset, join(temporary, basename(asset)));
    return 'same';
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyAllAssets(tag, assets, runCommand) {
  assertRemoteAssetNames(tag, assets, runCommand, { allowMissing: false });
  for (const asset of assets) {
    const status = await remoteAssetStatus(tag, asset, runCommand);
    if (status !== 'same') {
      throw new Error(
        `Release asset is missing after publication step: ${basename(asset)}`,
      );
    }
  }
}

async function ensureDraftAssets(tag, assets, runCommand) {
  const remoteNames = assertRemoteAssetNames(tag, assets, runCommand, {
    allowMissing: true,
  });
  for (const asset of assets) {
    if (!remoteNames.has(basename(asset))) {
      runCommand('gh', ['release', 'upload', tag, asset]);
      continue;
    }
    const status = await remoteAssetStatus(tag, asset, runCommand);
    if (status !== 'same') {
      throw new Error(
        `Release asset disappeared after inventory validation: ${basename(asset)}.`,
      );
    }
  }
  await verifyAllAssets(tag, assets, runCommand);
}

function publishPackage(packagePlan, runCommand) {
  const existing = existingPackageIntegrity(
    packagePlan.name,
    packagePlan.version,
    runCommand,
  );
  const decision = packagePublicationDecision(
    existing,
    packagePlan.localIntegrity,
  );
  if (decision === 'publish') {
    runCommand('npm', [
      'publish',
      packagePlan.packagePath,
      '--registry',
      registry,
      '--access',
      'public',
    ]);
  }
  const published = existingPackageIntegrity(
    packagePlan.name,
    packagePlan.version,
    runCommand,
  );
  if (published === undefined) {
    throw new Error(
      'Package registry did not expose the version after publish.',
    );
  }
  packagePublicationDecision(published, packagePlan.localIntegrity);
}

async function publishReleaseAsync(input, runCommand) {
  // No release/package mutations are allowed before every local check succeeds.
  const candidate = await preflightCandidate(input, runCommand);
  let state = releaseState(input.tag, runCommand);
  const packagePublicationPlans = candidate.packagePlans.map((packagePlan) => ({
    packagePlan,
    existingIntegrity: existingPackageIntegrity(
      packagePlan.name,
      input.version,
      runCommand,
    ),
  }));
  if (state === 'public') {
    for (const { packagePlan, existingIntegrity } of packagePublicationPlans) {
      if (existingIntegrity === undefined) {
        throw new Error(
          `Public release exists but synchronized package ${packagePlan.name}@${input.version} is missing.`,
        );
      }
      packagePublicationDecision(existingIntegrity, packagePlan.localIntegrity);
    }
    await verifyAllAssets(input.tag, candidate.assets, runCommand);
    return;
  }
  for (const { packagePlan, existingIntegrity } of packagePublicationPlans) {
    packagePublicationDecision(existingIntegrity, packagePlan.localIntegrity);
  }
  if (state === 'missing') {
    runCommand('gh', [
      'release',
      'create',
      input.tag,
      '--verify-tag',
      '--draft',
      '--generate-notes',
      '--notes',
      feasibilityReleaseNotes(input.version),
    ]);
    state = 'draft';
  }
  if (state !== 'draft')
    throw new Error('Release must remain draft during publication.');

  await ensureDraftAssets(input.tag, candidate.assets, runCommand);
  assertRemoteAssetNames(input.tag, candidate.assets, runCommand, {
    allowMissing: false,
  });
  for (const packagePlan of candidate.packagePlans) {
    publishPackage(packagePlan, runCommand);
  }
  await verifyAllAssets(input.tag, candidate.assets, runCommand);
  runCommand('gh', [
    'release',
    'edit',
    input.tag,
    '--verify-tag',
    '--draft=false',
  ]);
  if (releaseState(input.tag, runCommand) !== 'public') {
    throw new Error('Release did not become public.');
  }
}

export function publishRelease(input, { runCommand = run } = {}) {
  return defer(() => from(publishReleaseAsync(input, runCommand)));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    publishRelease(parseArguments(process.argv.slice(2))).subscribe({
      error: (error) => {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      },
    });
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
