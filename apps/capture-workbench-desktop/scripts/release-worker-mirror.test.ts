// The test-scripts target preloads tools/test-temp-root.ts with `node --import`
// (an import here would cross the Nx project boundary); these tests also remove
// their own directories, so a direct `node --test` run leaves nothing behind.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import {
  catalogWorkerFiles,
  readReviewRelease,
  startReleaseWorkerMirror,
} from './release-worker-mirror.ts';

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryRoots.map((directory) => rm(directory, { recursive: true, force: true })));
});

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const ocrArchive = Buffer.from('synthetic ocr worker');
const speechPartOne = Buffer.from('synthetic speech worker, first part');
const speechPartTwo = Buffer.from('synthetic speech worker, second part');
const speechCpuArchive = Buffer.from('synthetic speech cpu worker');

function worker(fileName: string, bytes: Buffer): Record<string, unknown> {
  return { role: 'worker', fileName, bytes: bytes.length, sha256: sha256(bytes), url: `https://example.invalid/${fileName}` };
}

const catalog = {
  catalogVersion: '2',
  requirements: [
    {
      requirementId: 'text-recognition',
      artifacts: [worker('engine-ocr-synthetic.zip', ocrArchive)],
    },
    {
      requirementId: 'speech-recognition',
      contents: [
        {
          id: 'cuda',
          artifacts: [{
            ...worker('engine-speech-synthetic.zip', Buffer.concat([speechPartOne, speechPartTwo])),
            parts: [worker('engine-speech-synthetic.zip.001', speechPartOne), worker('engine-speech-synthetic.zip.002', speechPartTwo)],
          }],
        },
        { id: 'cpu', artifacts: [worker('engine-speech-cpu-synthetic.zip', speechCpuArchive)] },
      ],
    },
  ],
};

async function releaseDirectory(overrides: Readonly<Record<string, Buffer>> = {}): Promise<string> {
  const directory = await temporaryDirectory('release-');
  const files: Record<string, Buffer | string> = {
    'capture-engine-catalog.json': JSON.stringify(catalog),
    'engine-ocr-synthetic.zip': ocrArchive,
    'engine-speech-synthetic.zip.001': speechPartOne,
    'engine-speech-synthetic.zip.002': speechPartTwo,
    'engine-speech-cpu-synthetic.zip': speechCpuArchive,
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  return directory;
}

test('a requirement with contents serves every content\'s worker, each part of a split archive on its own', () => {
  assert.deepEqual(
    catalogWorkerFiles(catalog, ['speech-recognition']).map((file) => file.fileName),
    ['engine-speech-synthetic.zip.001', 'engine-speech-synthetic.zip.002', 'engine-speech-cpu-synthetic.zip'],
  );
  assert.deepEqual(catalogWorkerFiles(catalog, ['text-recognition']).map((file) => file.fileName), ['engine-ocr-synthetic.zip']);
  assert.throws(() => catalogWorkerFiles(catalog, ['speaker-diarization']), /exactly one speaker-diarization requirement/u);
});

test('the mirror serves only the catalogued worker files of the requirements it was started for', async () => {
  const mirror = await startReleaseWorkerMirror({ releaseDirectory: await releaseDirectory(), requirementIds: ['speech-recognition'] });
  try {
    const part = await fetch(`${mirror.baseUrl}/engine-speech-synthetic.zip.002`);
    assert.equal(part.status, 200);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), speechPartTwo);
    assert.equal((await fetch(`${mirror.baseUrl}/engine-ocr-synthetic.zip`)).status, 404);
    assert.equal((await fetch(`${mirror.baseUrl}/capture-engine-catalog.json`)).status, 404);
    assert.equal((await fetch(`${mirror.baseUrl}/engine-speech-cpu-synthetic.zip?x=1`)).status, 404);
    assert.equal(mirror.requests, 1);
    assert.equal(mirror.catalogSha256, sha256(JSON.stringify(catalog)));
  } finally {
    await mirror.close();
  }
});

test('the mirror refuses to start when a worker file or the catalog is not the expected one', async () => {
  await assert.rejects(
    startReleaseWorkerMirror({
      releaseDirectory: await releaseDirectory({ 'engine-speech-synthetic.zip.001': Buffer.from('changed bytes, same idea') }),
      requirementIds: ['speech-recognition'],
    }),
    /engine-speech-synthetic\.zip\.001 does not match the engine catalog/u,
  );
  await assert.rejects(
    startReleaseWorkerMirror({ releaseDirectory: await releaseDirectory(), requirementIds: ['speech-recognition'], catalogSha256: '0'.repeat(64) }),
    /not the verified one/u,
  );
});

test('a review runs only a packaged build whose runtime is the local release\'s', async () => {
  const release = await releaseDirectory();
  const build = await temporaryDirectory('build-');
  await mkdir(join(build, 'resources'));
  const runtimeSha256 = sha256('synthetic runtime');
  await writeFile(join(release, 'capture-runtime-manifest.json'), JSON.stringify({ sha256: runtimeSha256 }));
  await writeFile(join(build, 'resources', 'capture-runtime-manifest.json'), JSON.stringify({ sha256: runtimeSha256 }));
  const executable = join(build, 'capture-workbench-desktop.exe');
  assert.deepEqual(await readReviewRelease(executable, release), { directory: release, runtimeSha256 });
  await writeFile(join(build, 'resources', 'capture-runtime-manifest.json'), JSON.stringify({ sha256: sha256('another runtime') }));
  await assert.rejects(readReviewRelease(executable, release), /does not start the local release's runtime/u);
});
