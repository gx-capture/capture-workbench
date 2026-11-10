import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  assertPublishableRuntimeReleaseFile,
  parseReleaseArguments,
  parseRemoteReleaseInventory,
  run,
  sha256,
} from './release/github-release-support.ts';

async function assetPaths(candidate: string): Promise<string[]> {
  const runtime = join(candidate, 'runtime');
  const desktop = join(candidate, 'desktop');
  const runtimeNames = await readdir(runtime);
  for (const name of runtimeNames) assertPublishableRuntimeReleaseFile(name);
  const runtimeFiles = runtimeNames.map((name) => join(runtime, name));
  const desktopFiles = (await readdir(desktop))
    .filter((name) => name.endsWith('.exe'))
    .map((name) => join(desktop, name));
  const manifest = join(candidate, 'candidate-manifest.json');
  const contractSnapshot = join(candidate, 'capture-contract-snapshot.json');
  const releaseManifest = join(candidate, 'capture-release-manifest-v1.json');
  const releaseManifestSha256 = `${releaseManifest}.sha256`;
  if (desktopFiles.length !== 1)
    throw new Error('Candidate must contain exactly one desktop installer.');
  const releaseManifestFiles = [];
  try {
    await stat(contractSnapshot);
    await stat(releaseManifest);
    await stat(releaseManifestSha256);
    releaseManifestFiles.push(releaseManifest, releaseManifestSha256);
  } catch {
    throw new Error('Immutable release manifest and checksum are required.');
  }
  return [
    ...runtimeFiles,
    ...desktopFiles,
    manifest,
    contractSnapshot,
    ...releaseManifestFiles,
  ];
}

async function assertRemoteAssetMatches(
  tag: string,
  asset: string,
  temporary: string,
): Promise<'missing' | 'same'> {
  const remoteTemporary = await mkdtemp(join(temporary, 'remote-'));
  const repository =
    process.env.GITHUB_REPOSITORY ?? 'gx-capture/capture-workbench';
  const download = run(
    'gh',
    [
      'release',
      'download',
      tag,
      '--repo',
      repository,
      '--pattern',
      basename(asset),
      '--dir',
      remoteTemporary,
    ],
    true,
  );
  if (download.status !== 0) {
    try {
      if (
        /no assets matched|not found|HTTP 404/iu.test(
          download.stderr || download.stdout,
        )
      ) {
        return 'missing';
      }
      throw new Error(
        `Unable to inspect GitHub Release asset ${basename(asset)}: ${(
          download.stderr || download.stdout
        ).trim()}`,
      );
    } finally {
      await rm(remoteTemporary, { recursive: true, force: true });
    }
  }
  try {
    const remote = join(remoteTemporary, basename(asset));
    const [localBytes, remoteBytes, localStat, remoteStat] = await Promise.all([
      readFile(asset),
      readFile(remote),
      stat(asset),
      stat(remote),
    ]);
    if (
      localStat.size !== remoteStat.size ||
      sha256(localBytes) !== sha256(remoteBytes)
    ) {
      throw new Error(
        `GitHub Release asset differs from the approved candidate: ${basename(asset)}.`,
      );
    }
    return 'same';
  } finally {
    await rm(remoteTemporary, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const values = parseReleaseArguments(process.argv.slice(2));
  const candidate = resolve(values.get('--candidate')!);
  const tag = values.get('--tag')!;
  const sourceCommit = values.get('--source-commit')!;
  const output = resolve(values.get('--output')!);
  if (
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag) ||
    !/^[0-9a-f]{40}$/u.test(sourceCommit)
  ) {
    throw new Error('GitHub Release tag or source commit is invalid.');
  }
  const manifestBytes = await readFile(
    join(candidate, 'candidate-manifest.json'),
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    candidateId?: unknown;
    sourceCommit?: unknown;
    releaseVersion?: unknown;
  };
  if (
    typeof manifest.candidateId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(manifest.candidateId) ||
    manifest.sourceCommit !== sourceCommit ||
    manifest.releaseVersion !== tag.slice(1)
  ) {
    throw new Error(
      'Candidate manifest does not match the tag and source commit.',
    );
  }
  const assets = await assetPaths(candidate);
  const expectedAssetNames = new Set(assets.map((asset) => basename(asset)));
  const allowedRuntimeSeedAssets = new Set([
    'capture-runtime-candidate-manifest.json',
  ]);
  const remote = run(
    'gh',
    ['release', 'view', tag, '--json', 'isDraft,assets'],
    true,
  );
  let isDraft = false;
  let remoteNames = new Set<string>();
  if (remote.status === 0) {
    const inventory = parseRemoteReleaseInventory(remote.stdout);
    isDraft = inventory.isDraft;
    remoteNames = inventory.remoteNames;
    const unexpected = [...remoteNames].filter(
      (name) =>
        !expectedAssetNames.has(name) && !allowedRuntimeSeedAssets.has(name),
    );
    if (unexpected.length > 0) {
      throw new Error(
        `GitHub Release contains unexpected assets: ${unexpected.join(', ')}.`,
      );
    }
  } else if (
    !/release not found|HTTP 404|not found/iu.test(
      remote.stderr || remote.stdout,
    )
  ) {
    throw new Error('Unable to inspect the GitHub Release.');
  }
  if (remote.status !== 0) {
    run('gh', [
      'release',
      'create',
      tag,
      '--verify-tag',
      '--draft',
      '--title',
      `Capture Workbench ${tag}`,
      '--notes',
      `Immutable Capture Workbench candidate ${manifest.candidateId}.`,
    ]);
    isDraft = true;
  }
  const temporary = await mkdtemp(join(tmpdir(), 'capture-release-assets-'));
  try {
    for (const asset of assets) {
      if (!remoteNames.has(basename(asset))) {
        run('gh', ['release', 'upload', tag, asset]);
      } else await assertRemoteAssetMatches(tag, asset, temporary);
    }
    for (const asset of assets) {
      if ((await assertRemoteAssetMatches(tag, asset, temporary)) !== 'same') {
        throw new Error(
          `GitHub Release asset is missing after upload: ${basename(asset)}.`,
        );
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  if (isDraft) {
    run('gh', ['release', 'edit', tag, '--verify-tag', '--draft=false']);
    const finalState = run('gh', ['release', 'view', tag, '--json', 'isDraft']);
    if (
      (JSON.parse(finalState.stdout) as { isDraft?: unknown }).isDraft !== false
    ) {
      throw new Error('GitHub Release did not become public.');
    }
  }
  await writeReleaseLedger(
    output,
    tag,
    sourceCommit,
    manifest,
    manifestBytes,
    assets,
  );
}

async function writeReleaseLedger(
  output: string,
  tag: string,
  sourceCommit: string,
  manifest: { candidateId?: unknown },
  manifestBytes: Uint8Array,
  assets: readonly string[],
): Promise<void> {
  const assetRecords = await Promise.all(
    assets.map(async (asset) => ({
      name: basename(asset),
      sha256: sha256(await readFile(asset)),
    })),
  );
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: '1',
        tag,
        sourceCommit,
        candidateId: manifest.candidateId,
        candidateManifestSha256: sha256(manifestBytes),
        assets: assetRecords,
        status: 'public',
      },
      null,
      2,
    )}\n`,
    'utf8',
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
