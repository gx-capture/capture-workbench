import {
  copyFile,
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
  parseReleaseArguments,
  parseRemoteReleaseInventory,
  run,
  sha256,
} from './release/github-release-support.ts';

async function assertRemoteAssetMatches(
  tag: string,
  asset: string,
  temporary: string,
): Promise<void> {
  const remoteTemporary = await mkdtemp(join(temporary, 'remote-'));
  try {
    const download = run(
      'gh',
      [
        'release',
        'download',
        tag,
        '--pattern',
        basename(asset),
        '--dir',
        remoteTemporary,
      ],
      true,
    );
    if (download.status !== 0)
      throw new Error(
        `Unable to inspect GitHub Release asset ${basename(asset)}.`,
      );
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
        `GitHub Release asset differs from the approved runtime candidate: ${basename(asset)}.`,
      );
    }
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
    throw new Error('Runtime release tag or source commit is invalid.');
  }
  const manifestPath = join(candidate, 'candidate-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    candidateId?: unknown;
    candidateKind?: unknown;
    sourceCommit?: unknown;
    releaseVersion?: unknown;
  };
  if (
    typeof manifest.candidateId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(manifest.candidateId) ||
    manifest.candidateKind !== 'runtime' ||
    manifest.sourceCommit !== sourceCommit ||
    manifest.releaseVersion !== tag.slice(1)
  ) {
    throw new Error(
      'Runtime candidate manifest does not match the tag and source commit.',
    );
  }
  const temporary = await mkdtemp(join(tmpdir(), 'capture-runtime-release-'));
  try {
    const runtimeAssets = (await readdir(join(candidate, 'runtime'))).map(
      (name) => join(candidate, 'runtime', name),
    );
    const runtimeManifest = join(
      temporary,
      'capture-runtime-candidate-manifest.json',
    );
    await copyFile(manifestPath, runtimeManifest);
    const assets = [...runtimeAssets, runtimeManifest];
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
        '--title',
        `Capture Runtime ${tag}`,
        '--notes',
        `Immutable Capture Runtime candidate ${manifest.candidateId}. Desktop assets are promoted separately.`,
      ]);
      isDraft = false;
    }
    for (const asset of assets) {
      const name = basename(asset);
      if (remoteNames.has(name))
        await assertRemoteAssetMatches(tag, asset, temporary);
      else run('gh', ['release', 'upload', tag, asset]);
    }
    for (const asset of assets)
      await assertRemoteAssetMatches(tag, asset, temporary);
    if (isDraft) run('gh', ['release', 'edit', tag, '--draft=false']);
    await writeFile(
      output,
      `${JSON.stringify(
        {
          schemaVersion: '1',
          tag,
          sourceCommit,
          candidateId: manifest.candidateId,
          candidateManifestSha256: sha256(manifestBytes),
          assets: await Promise.all(
            assets.map(async (asset) => ({
              name: basename(asset),
              sha256: sha256(
                asset === runtimeManifest
                  ? manifestBytes
                  : await readFile(asset),
              ),
            })),
          ),
          status: 'public',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
