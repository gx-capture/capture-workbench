import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const NPM_PACKAGES = [
  '@gx-capture/capture-workbench-ui',
  '@gx-capture/capture-contracts',
  '@gx-capture/capture-structuring',
];

function run(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed with status ${String(result.status)}.`);
  return result.stdout;
}

function parseArguments(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--tag', '--repository'].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error('Use --tag <tag> --repository <owner/name>.');
    }
    values.set(name, value);
  }
  return values;
}

async function assertPublished(url: string, label: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'gx-capture-release-audit',
    },
  });
  if (!response.ok)
    throw new Error(`${label} is not available from its registry.`);
}

async function main(): Promise<void> {
  const values = parseArguments(process.argv.slice(2));
  const tag = values.get('--tag')!;
  const repository = values.get('--repository')!;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag))
    throw new Error('Release tag is invalid.');
  const version = tag.slice(1);
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const tagged = run('git', ['rev-list', '-n', '1', `${tag}^{}`]).trim();
  if (head !== tagged)
    throw new Error('Checked-out tag does not resolve to HEAD.');
  const main = run('git', ['rev-parse', 'refs/remotes/origin/main']).trim();
  const ancestry = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', tagged, main],
    {
      encoding: 'utf8',
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (ancestry.status !== 0)
    throw new Error('Release tag commit is not reachable from origin/main.');
  const release = JSON.parse(
    run('gh', [
      'release',
      'view',
      tag,
      '--repo',
      repository,
      '--json',
      'isDraft,assets',
    ]),
  ) as {
    isDraft?: unknown;
    assets?: Array<{ name?: unknown }>;
  };
  if (release.isDraft !== false || !Array.isArray(release.assets))
    throw new Error('Public GitHub Release audit failed.');
  if (
    !release.assets.some(
      (asset) => asset.name === 'capture-release-manifest-v1.json',
    ) ||
    !release.assets.some(
      (asset) => asset.name === 'capture-contract-snapshot.json',
    )
  ) {
    throw new Error(
      'Public GitHub Release is missing the immutable manifest or contract snapshot.',
    );
  }
  const temporary = await mkdtemp(join(tmpdir(), 'capture-release-audit-'));
  try {
    run('gh', [
      'release',
      'download',
      tag,
      '--repo',
      repository,
      '--pattern',
      'capture-release-manifest-v1.json',
      '--dir',
      temporary,
    ]);
    run('gh', [
      'attestation',
      'verify',
      join(temporary, 'capture-release-manifest-v1.json'),
      '--repo',
      repository,
      '--signer-workflow',
      `${repository}/.github/workflows/_publish-github-release.yml`,
    ]);
    const manifest = JSON.parse(
      await readFile(
        join(temporary, 'capture-release-manifest-v1.json'),
        'utf8',
      ),
    ) as {
      candidateId?: unknown;
      sourceCommit?: unknown;
      releaseVersion?: unknown;
    };
    if (
      typeof manifest.candidateId !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(manifest.candidateId) ||
      manifest.sourceCommit !== tagged ||
      manifest.releaseVersion !== version
    ) {
      throw new Error(
        'Release manifest identity does not match the audited tag.',
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  for (const name of NPM_PACKAGES) {
    run('npm', [
      'view',
      `${name}@${version}`,
      'version',
      '--registry',
      'https://npm.pkg.github.com',
    ]);
  }
  await assertPublished(
    `https://pypi.org/pypi/capture-contracts/${version}/json`,
    `PyPI capture-contracts ${version}`,
  );
  await assertPublished(
    `https://pypi.org/pypi/capture-structuring/${version}/json`,
    `PyPI capture-structuring ${version}`,
  );
  await assertPublished(
    `https://crates.io/api/v1/crates/capture-sidecar-launcher/${version}`,
    `crates.io capture-sidecar-launcher ${version}`,
  );
  process.stdout.write(`Release tag audit passed for ${tag}.\n`);
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
