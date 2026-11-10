import '../test-temp-root.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import {
  isPublishedRuntimeReleaseFile,
  parseReleaseArguments,
  parseRemoteReleaseInventory,
  run,
  sha256,
} from './github-release-support.ts';

const toolsRoot = resolve(import.meta.dirname, '..');
const CLIS = ['create-github-release.ts', 'create-runtime-github-release.ts'];
const USAGE =
  'Use --candidate <directory> --tag <tag> --source-commit <sha> --output <file>.';
const sourceCommit = 'a'.repeat(40);
const candidateId = 'b'.repeat(64);

let root = '';
let fakeBin = '';

// A copy of node named `gh` whose preload prints a canned reply, so the CLIs'
// real command execution and inventory parsing run without any network access.
// The preload only acts in the copy; the CLI's own node process ignores it.
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'capture-release-support-'));
  fakeBin = join(root, 'bin');
  await mkdir(fakeBin);
  await copyFile(
    process.execPath,
    join(fakeBin, process.platform === 'win32' ? 'gh.exe' : 'gh'),
  );
  await writeFile(
    join(root, 'fake-gh.cjs'),
    [
      "if (/^gh(\\.exe)?$/u.test(require('node:path').basename(process.execPath))) {",
      "  process.stdout.write(process.env.FAKE_GH_STDOUT || '');",
      "  process.stderr.write(process.env.FAKE_GH_STDERR || '');",
      "  process.exit(Number(process.env.FAKE_GH_STATUS || '0'));",
      '}',
      '',
    ].join('\n'),
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function candidateDirectory(cli: string): Promise<string> {
  const dir = await mkdtemp(join(root, 'candidate-'));
  await mkdir(join(dir, 'runtime'));
  await writeFile(join(dir, 'runtime', 'runtime.zip'), 'runtime');
  await writeFile(
    join(dir, 'candidate-manifest.json'),
    JSON.stringify({
      candidateId,
      candidateKind: 'runtime',
      sourceCommit,
      releaseVersion: '1.2.3',
    }),
  );
  if (cli === 'create-github-release.ts') {
    await mkdir(join(dir, 'desktop'));
    await writeFile(join(dir, 'desktop', 'setup.exe'), 'installer');
    for (const name of [
      'capture-contract-snapshot.json',
      'capture-release-manifest-v1.json',
      'capture-release-manifest-v1.json.sha256',
    ])
      await writeFile(join(dir, name), name);
  }
  return dir;
}

function runCli(
  cli: string,
  args: readonly string[],
  fake: Record<string, string> = {},
) {
  const result = spawnSync(process.execPath, [join(toolsRoot, cli), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...fake,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `--require ${join(root, 'fake-gh.cjs').replaceAll('\\', '/')}`,
    },
  });
  assert.equal(result.error, undefined);
  return result;
}

function releaseArguments(dir: string, tag = 'v1.2.3'): string[] {
  return [
    '--candidate',
    dir,
    '--tag',
    tag,
    '--source-commit',
    sourceCommit,
    '--output',
    join(dir, 'ledger.json'),
  ];
}

for (const cli of CLIS) {
  test(`${cli} rejects malformed arguments with the usage text`, () => {
    const cases: string[][] = [
      [],
      ['--unknown', 'x'],
      ['--candidate'],
      ['--candidate', 'c', '--candidate', 'd'],
      ['--candidate', 'c', '--tag', 't', '--source-commit', sourceCommit],
    ];
    for (const args of cases) {
      const result = runCli(cli, args);
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(result.stderr, `${USAGE}\n`, args.join(' '));
    }
  });

  test(`${cli} rejects an invalid tag before touching GitHub`, () => {
    const result = runCli(cli, releaseArguments('c', '1.2.3'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tag or source commit is invalid\.\n$/u);
  });

  test(`${cli} rejects an invalid remote asset inventory`, async () => {
    const args = releaseArguments(await candidateDirectory(cli));
    for (const stdout of [
      '{"isDraft":false}',
      '{"isDraft":false,"assets":[null]}',
      '{"isDraft":false,"assets":[{"name":1}]}',
    ]) {
      const result = runCli(cli, args, { FAKE_GH_STDOUT: stdout });
      assert.equal(result.status, 1, stdout);
      assert.equal(
        result.stderr,
        'GitHub Release returned an invalid asset inventory.\n',
        stdout,
      );
    }
  });

  test(`${cli} reports an uninspectable release`, async () => {
    const args = releaseArguments(await candidateDirectory(cli));
    const result = runCli(cli, args, {
      FAKE_GH_STATUS: '1',
      FAKE_GH_STDERR: 'boom',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'Unable to inspect the GitHub Release.\n');
  });
}

test('both release CLIs reject a checksum sidecar and the size report before upload', async () => {
  for (const cli of CLIS) {
    for (const name of [
      'capture-engine-catalog.json.sha256',
      'runtime-size-report.json',
    ]) {
      const dir = await candidateDirectory(cli);
      await writeFile(join(dir, 'runtime', name), 'not published');
      const result = runCli(cli, releaseArguments(dir));
      assert.equal(result.status, 1, `${cli} ${name}`);
      assert.match(
        result.stderr,
        /not a GitHub Release asset/u,
        `${cli} ${name}`,
      );
    }
  }
});

test('published runtime names keep worker files and drop checksum sidecars', () => {
  assert.equal(
    isPublishedRuntimeReleaseFile(
      'capture-engine-ocr-0.9.0-windows-x64-files.json',
    ),
    true,
  );
  assert.equal(
    isPublishedRuntimeReleaseFile('capture-engine-ocr-0.9.0-windows-x64.zip'),
    true,
  );
  assert.equal(
    isPublishedRuntimeReleaseFile('capture-runtime-manifest.json'),
    true,
  );
  assert.equal(isPublishedRuntimeReleaseFile('runtime-size-report.json'), false);
  assert.equal(
    isPublishedRuntimeReleaseFile('capture-engine-catalog.json.sha256'),
    false,
  );
});

test('the workbench CLI rejects remote assets outside the candidate', async () => {
  const args = releaseArguments(
    await candidateDirectory('create-github-release.ts'),
  );
  const result = runCli('create-github-release.ts', args, {
    FAKE_GH_STDOUT:
      '{"isDraft":true,"assets":[{"name":"runtime.zip"},{"name":"stray.bin"}]}',
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'GitHub Release contains unexpected assets: stray.bin.\n',
  );
});

test('parseReleaseArguments returns the four named values', () => {
  const values = parseReleaseArguments([
    '--output',
    'o',
    '--candidate',
    'c',
    '--tag',
    'v1.2.3',
    '--source-commit',
    sourceCommit,
  ]);
  assert.deepEqual(
    [...values.entries()].sort(),
    [
      ['--candidate', 'c'],
      ['--output', 'o'],
      ['--source-commit', sourceCommit],
      ['--tag', 'v1.2.3'],
    ].sort(),
  );
  assert.throws(() => parseReleaseArguments(['--tag']), { message: USAGE });
});

test('parseRemoteReleaseInventory reads draft state and asset names', () => {
  const inventory = parseRemoteReleaseInventory(
    '{"isDraft":true,"assets":[{"name":"a"},{"name":"b"},{"name":"a"}]}',
  );
  assert.equal(inventory.isDraft, true);
  assert.deepEqual([...inventory.remoteNames], ['a', 'b']);
  assert.equal(
    parseRemoteReleaseInventory('{"isDraft":"yes","assets":[]}').isDraft,
    false,
  );
  assert.throws(() => parseRemoteReleaseInventory('{"assets":"x"}'), {
    message: 'GitHub Release returned an invalid asset inventory.',
  });
});

test('run returns failed results only when failure is allowed', () => {
  const failing = [process.execPath, ['-e', 'process.exit(3)']] as const;
  assert.equal(run(...failing, true).status, 3);
  assert.throws(() => run(...failing), {
    message: `${process.execPath} failed with status 3.`,
  });
  assert.equal(sha256(Buffer.from('abc')).length, 64);
});
