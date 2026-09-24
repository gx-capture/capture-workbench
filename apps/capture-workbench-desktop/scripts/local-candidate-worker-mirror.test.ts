import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  startLocalCandidateWorkerMirror,
  type StartLocalCandidateWorkerMirrorOptions,
} from './local-candidate-worker-mirror.ts';

const ARCHIVE_NAME = 'capture-engine-ocr-0.4.2-windows-x64.zip';
const FILES_MANIFEST_NAME = 'capture-engine-ocr-0.4.2-windows-x64-files.json';

interface CandidateFixture {
  readonly root: string;
  readonly candidateRoot: string;
  readonly sourceDist: string;
  readonly archiveName: string;
  readonly filesManifestName: string;
  readonly archivePath: string;
  readonly filesManifestPath: string;
  readonly catalogPath: string;
  readonly candidateManifestPath: string;
  readonly candidateArchive: Buffer;
  readonly filesManifest: Buffer;
  readonly physicalRoot?: string;
  readonly aliasRoot?: string;
  candidateId: string;
}

interface FileDigest {
  readonly bytes: number;
  readonly sha256: string;
}

interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const EMPTY_FILE_SHA256 = sha256(Buffer.alloc(0));
const CANONICAL_MEMBER_PATHS = [
  '_internal/_tcl_data/tzdata/Etc/GMT+0',
  '_internal/setuptools/_vendor/jaraco/text/Lorem ipsum.txt',
] as const;

function digestFile(path: string): Promise<FileDigest> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => resolvePromise({ bytes, sha256: hash.digest('hex') }));
  });
}

function requestBytes(url: string, method = 'GET'): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    const client = request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolvePromise({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('worker archive response was aborted')));
    });
    client.once('error', reject);
    client.end();
  });
}

function createCatalog(
  archive: Buffer,
  filesManifest: Buffer,
): Record<string, unknown> {
  return {
    catalogVersion: '2',
    runtimeVersion: '0.4.2',
    requirements: [{
      requirementId: 'windowsml-ocr',
      artifacts: [{
        arch: 'x86_64',
        artifactVersion: '0.4.2',
        bytes: archive.length,
        entryPoint: 'capture-engine-ocr.exe',
        extractedBytes: 19,
        fileName: ARCHIVE_NAME,
        filesManifestSha256: sha256(filesManifest),
        platform: 'windows',
        requirementId: 'windowsml-ocr',
        role: 'worker',
        sha256: sha256(archive),
        url: 'https://example.invalid/capture-engine-ocr.zip',
        workerProtocolVersion: '1',
      }],
    }],
  };
}

async function rebindCandidate(
  fixture: CandidateFixture,
  catalog: Record<string, unknown>,
): Promise<string> {
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog)}\n`);
  const filesManifestDigest = await digestFile(fixture.filesManifestPath);
  const archiveDigest = await digestFile(fixture.archivePath);
  const candidateBaseManifest = {
    schemaVersion: '1',
    candidateKind: 'runtime',
    sourceCommit: 'a'.repeat(40),
    releaseVersion: '0.4.2',
    releaseMode: 'model-enabled',
    producerRunId: 1,
    packageCandidateId: 'b'.repeat(64),
    contractSetSha256: 'c'.repeat(64),
    artifacts: [
      {
        bytes: catalogBytes.length,
        path: 'runtime/capture-engine-catalog.json',
        sha256: sha256(catalogBytes),
      },
      {
        bytes: archiveDigest.bytes,
        path: `runtime/${fixture.archiveName}`,
        sha256: archiveDigest.sha256,
      },
      {
        bytes: filesManifestDigest.bytes,
        path: `runtime/${fixture.filesManifestName}`,
        sha256: filesManifestDigest.sha256,
      },
    ],
    toolchains: { node: 'v24.0.0', python: '3.12', runtime: 'capture-runtime' },
  };
  const candidateId = sha256(JSON.stringify(candidateBaseManifest));
  await writeFile(fixture.candidateManifestPath, `${JSON.stringify({ ...candidateBaseManifest, candidateId })}\n`);
  await writeFile(fixture.catalogPath, catalogBytes);
  fixture.candidateId = candidateId;
  return candidateId;
}

async function createFixture(options: {
  readonly includeCanonicalMemberPaths?: boolean;
  readonly ancestorAlias?: boolean;
} = {}): Promise<CandidateFixture> {
  const physicalRoot = await mkdtemp(join(tmpdir(), 'capture-local-worker-mirror-'));
  let root = physicalRoot;
  let aliasRoot: string | undefined;
  if (options.ancestorAlias) {
    aliasRoot = join(
      tmpdir(),
      `capture-local-worker-mirror-alias-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await symlink(physicalRoot, aliasRoot, 'junction');
    assert.notEqual(await realpath(aliasRoot), aliasRoot);
    root = join(aliasRoot, 'run');
    await mkdir(root, { recursive: true });
  }
  const candidateRoot = join(root, 'candidate');
  const sourceDist = join(root, 'source-dist');
  const candidateArchive = Buffer.from('candidate archive bytes');
  const files = options.includeCanonicalMemberPaths
    ? [
      ...CANONICAL_MEMBER_PATHS.map((path) => ({
        bytes: 0,
        path,
        sha256: EMPTY_FILE_SHA256,
      })),
      { bytes: 19, path: 'capture-engine-ocr.exe', sha256: 'e'.repeat(64) },
    ]
    : [{ bytes: 19, path: 'capture-engine-ocr.exe', sha256: 'e'.repeat(64) }];
  const filesManifest = Buffer.from(`${JSON.stringify({
    manifestVersion: '1',
    files,
  })}\n`);
  const fixture: CandidateFixture = {
    root,
    candidateRoot,
    sourceDist,
    archiveName: ARCHIVE_NAME,
    filesManifestName: FILES_MANIFEST_NAME,
    archivePath: join(candidateRoot, 'runtime', ARCHIVE_NAME),
    filesManifestPath: join(candidateRoot, 'runtime', FILES_MANIFEST_NAME),
    catalogPath: join(candidateRoot, 'runtime', 'capture-engine-catalog.json'),
    candidateManifestPath: join(candidateRoot, 'candidate-manifest.json'),
    candidateArchive,
    filesManifest,
    ...(options.ancestorAlias ? { physicalRoot, aliasRoot } : {}),
    candidateId: '',
  };
  await mkdir(join(candidateRoot, 'runtime'), { recursive: true });
  await mkdir(sourceDist, { recursive: true });
  await writeFile(fixture.archivePath, candidateArchive);
  await writeFile(fixture.filesManifestPath, filesManifest);
  await writeFile(join(sourceDist, ARCHIVE_NAME), 'different source-dist archive bytes');
  await rebindCandidate(fixture, createCatalog(candidateArchive, filesManifest));
  return fixture;
}

async function readCatalog(fixture: CandidateFixture): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixture.catalogPath, 'utf8')) as Record<string, unknown>;
}

function verifyCompleteBody(
  response: HttpResponse,
  expected: { readonly archiveBytes: number; readonly archiveSha256: string },
): void {
  if (
    response.status !== 200
    || Number(response.headers['content-length']) !== expected.archiveBytes
    || response.body.length !== expected.archiveBytes
    || sha256(response.body) !== expected.archiveSha256
  ) {
    throw new Error('worker archive response failed its complete-body verifier');
  }
}

async function assertMirrorStartRejects(
  options: StartLocalCandidateWorkerMirrorOptions,
  expected: RegExp,
  message?: string,
): Promise<void> {
  await assert.rejects(
    startLocalCandidateWorkerMirror(options).then(async (mirror) => {
      await mirror.close();
      throw new Error('mirror unexpectedly accepted invalid candidate');
    }),
    expected,
    message,
  );
}

test('local candidate mirror serves the verified candidate archive when source dist differs', async () => {
  const fixture = await createFixture();
  try {
    const mirror = await startLocalCandidateWorkerMirror({
      candidateRoot: fixture.candidateRoot,
      candidateId: fixture.candidateId,
      requirementId: 'windowsml-ocr',
    });
    try {
      const response = await requestBytes(`${mirror.baseUrl}/${encodeURIComponent(fixture.archiveName)}`);

      assert.equal(response.status, 200);
      assert.equal(Number(response.headers['content-length']), fixture.candidateArchive.length);
      assert.deepEqual(response.body, fixture.candidateArchive);
      verifyCompleteBody(response, mirror.identity);
      assert.equal(mirror.identity.archiveSha256, sha256(fixture.candidateArchive));
      assert.equal(mirror.requests, 1);

      for (const invalidUrl of [
        `${mirror.baseUrl}/${encodeURIComponent(fixture.archiveName)}?unexpected=1`,
        `${mirror.baseUrl}/nested/${encodeURIComponent(fixture.archiveName)}`,
        `${mirror.baseUrl}/other.zip`,
      ]) {
        const invalid = await requestBytes(invalidUrl);
        assert.equal(invalid.status, 404);
      }
      assert.equal((await requestBytes(`${mirror.baseUrl}/${encodeURIComponent(fixture.archiveName)}`, 'POST')).status, 405);
      assert.equal(mirror.requests, 1);
    } finally {
      await mirror.close();
    }
    await assert.rejects(requestBytes(`${mirror.baseUrl}/${encodeURIComponent(fixture.archiveName)}`));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('local candidate mirror accepts a candidate catalog under an ancestor junction alias', async () => {
  const fixture = await createFixture({ ancestorAlias: true });
  try {
    const mirror = await startLocalCandidateWorkerMirror({
      candidateRoot: fixture.candidateRoot,
      candidateId: fixture.candidateId,
      requirementId: 'windowsml-ocr',
    });
    try {
      assert.equal(mirror.identity.candidateId, fixture.candidateId);
      assert.equal(mirror.identity.archiveSha256, sha256(fixture.candidateArchive));
    } finally {
      await mirror.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    if (fixture.aliasRoot) await rm(fixture.aliasRoot, { force: true });
    if (fixture.physicalRoot) await rm(fixture.physicalRoot, { recursive: true, force: true });
  }
});

test('local candidate mirror accepts canonical member paths with plus signs and internal spaces', async () => {
  const fixture = await createFixture({ includeCanonicalMemberPaths: true });
  try {
    // Unreferenced member path safety remains the runtime installer's seam;
    // the mirror only binds the digest-bound entry-point evidence record.
    const mirror = await startLocalCandidateWorkerMirror({
      candidateRoot: fixture.candidateRoot,
      candidateId: fixture.candidateId,
      requirementId: 'windowsml-ocr',
    });
    try {
      assert.equal(mirror.identity.workerExecutableFileName, 'capture-engine-ocr.exe');
      assert.equal(mirror.identity.workerExecutableBytes, 19);
      assert.equal(mirror.identity.workerExecutableSha256, 'e'.repeat(64));
    } finally {
      await mirror.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('local candidate mirror rejects malformed, missing, and duplicate entryPoint records', async () => {
  const cases = [
    {
      name: 'malformed entryPoint record',
      mutate: async (fixture: CandidateFixture) => {
        const manifest = JSON.parse(await readFile(fixture.filesManifestPath, 'utf8')) as {
          files: Array<Record<string, unknown>>;
        };
        manifest.files[0].bytes = '19';
        await writeFile(fixture.filesManifestPath, `${JSON.stringify(manifest)}\n`);
      },
      message: /files manifest entry is invalid/u,
    },
    {
      name: 'missing entryPoint record',
      mutate: async (fixture: CandidateFixture) => {
        const manifest = JSON.parse(await readFile(fixture.filesManifestPath, 'utf8')) as {
          files: Array<Record<string, unknown>>;
        };
        manifest.files = [];
        await writeFile(fixture.filesManifestPath, `${JSON.stringify(manifest)}\n`);
      },
      message: /exactly one executable entry/u,
    },
    {
      name: 'duplicate entryPoint record',
      mutate: async (fixture: CandidateFixture) => {
        const manifest = JSON.parse(await readFile(fixture.filesManifestPath, 'utf8')) as {
          files: Array<Record<string, unknown>>;
        };
        manifest.files.push({ ...manifest.files[0] });
        await writeFile(fixture.filesManifestPath, `${JSON.stringify(manifest)}\n`);
      },
      message: /contains duplicate entries/u,
    },
  ] as const;

  for (const testCase of cases) {
    const fixture = await createFixture();
    try {
      await testCase.mutate(fixture);
      const catalog = await readCatalog(fixture);
      const requirements = catalog.requirements as Array<Record<string, unknown>>;
      const descriptor = (requirements[0].artifacts as Array<Record<string, unknown>>)[0];
      descriptor.filesManifestSha256 = (await digestFile(fixture.filesManifestPath)).sha256;
      const candidateId = await rebindCandidate(fixture, catalog);
      await assertMirrorStartRejects(
        {
          candidateRoot: fixture.candidateRoot,
          candidateId,
          requirementId: 'windowsml-ocr',
        },
        testCase.message,
        testCase.name,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('local candidate mirror rejects wrong candidate IDs and self-binding drift', async () => {
  const fixture = await createFixture();
  try {
    await assertMirrorStartRejects(
      {
        candidateRoot: fixture.candidateRoot,
        candidateId: 'f'.repeat(64),
        requirementId: 'windowsml-ocr',
      },
      /manifest identity is invalid/,
    );

    const manifest = JSON.parse(await readFile(fixture.candidateManifestPath, 'utf8')) as Record<string, unknown>;
    manifest.sourceCommit = 'd'.repeat(40);
    await writeFile(fixture.candidateManifestPath, `${JSON.stringify(manifest)}\n`);
    await assertMirrorStartRejects(
      {
        candidateRoot: fixture.candidateRoot,
        candidateId: fixture.candidateId,
        requirementId: 'windowsml-ocr',
      },
      /candidate ID is not bound/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('local candidate mirror rejects duplicate requirements and descriptors', async () => {
  const cases = [
    {
      name: 'duplicate requirement',
      mutate: (catalog: Record<string, unknown>) => {
        const requirements = catalog.requirements as Array<Record<string, unknown>>;
        catalog.requirements = [...requirements, { ...requirements[0] }];
      },
      message: /exactly one windowsml-ocr requirement/,
    },
    {
      name: 'duplicate worker descriptor',
      mutate: (catalog: Record<string, unknown>) => {
        const requirements = catalog.requirements as Array<Record<string, unknown>>;
        const requirement = requirements[0];
        const artifacts = requirement.artifacts as Array<Record<string, unknown>>;
        requirement.artifacts = [...artifacts, { ...artifacts[0] }];
      },
      message: /exactly one OCR worker descriptor/,
    },
  ] as const;

  for (const testCase of cases) {
    const fixture = await createFixture();
    try {
      const catalog = await readCatalog(fixture);
      testCase.mutate(catalog);
      const candidateId = await rebindCandidate(fixture, catalog);
      await assertMirrorStartRejects(
        {
          candidateRoot: fixture.candidateRoot,
          candidateId,
          requirementId: 'windowsml-ocr',
        },
        testCase.message,
        testCase.name,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('local candidate mirror rejects catalog, archive, and files-manifest identity drift', async () => {
  const catalogDrift = await createFixture();
  try {
    const catalog = await readCatalog(catalogDrift);
    catalog.runtimeVersion = '0.4.1';
    const candidateId = await rebindCandidate(catalogDrift, catalog);
    await assertMirrorStartRejects(
      {
        candidateRoot: catalogDrift.candidateRoot,
        candidateId,
        requirementId: 'windowsml-ocr',
      },
      /catalog version is invalid/,
    );
  } finally {
    await rm(catalogDrift.root, { recursive: true, force: true });
  }

  for (const drift of ['archive', 'files manifest'] as const) {
    const fixture = await createFixture();
    try {
      if (drift === 'archive') {
        await writeFile(fixture.archivePath, Buffer.from('different archive bytes'));
      } else {
        await writeFile(fixture.filesManifestPath, Buffer.from(`${JSON.stringify({ manifestVersion: '1', files: [] })}\n`));
      }
      await assertMirrorStartRejects(
        {
          candidateRoot: fixture.candidateRoot,
          candidateId: fixture.candidateId,
          requirementId: 'windowsml-ocr',
        },
        /bytes do not match the candidate manifest/,
        `${drift} drift`,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('local candidate mirror rejects cross-layer descriptor drift after candidate rebinding', async () => {
  const cases = [
    {
      name: 'archive descriptor SHA',
      mutate: (catalog: Record<string, unknown>) => {
        const requirements = catalog.requirements as Array<Record<string, unknown>>;
        const descriptor = (requirements[0].artifacts as Array<Record<string, unknown>>)[0];
        descriptor.sha256 = '0'.repeat(64);
      },
      message: /archive does not match its catalog descriptor/,
    },
    {
      name: 'files manifest descriptor SHA',
      mutate: (catalog: Record<string, unknown>) => {
        const requirements = catalog.requirements as Array<Record<string, unknown>>;
        const descriptor = (requirements[0].artifacts as Array<Record<string, unknown>>)[0];
        descriptor.filesManifestSha256 = '0'.repeat(64);
      },
      message: /files manifest does not match its catalog descriptor/,
    },
  ] as const;

  for (const testCase of cases) {
    const fixture = await createFixture();
    try {
      const catalog = await readCatalog(fixture);
      testCase.mutate(catalog);
      // Rebinding preserves the actual candidate artifact bytes/SHA while
      // leaving the catalog descriptor intentionally inconsistent.
      const candidateId = await rebindCandidate(fixture, catalog);
      await assertMirrorStartRejects(
        {
          candidateRoot: fixture.candidateRoot,
          candidateId,
          requirementId: 'windowsml-ocr',
        },
        testCase.message,
        testCase.name,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('local candidate mirror rejects a referenced runtime junction escaping the candidate root', async (t) => {
  const fixture = await createFixture();
  try {
    const escapedRuntime = join(fixture.root, 'escaped-runtime');
    await mkdir(escapedRuntime);
    for (const fileName of [
      fixture.archiveName,
      fixture.filesManifestName,
      'capture-engine-catalog.json',
    ]) {
      await writeFile(
        join(escapedRuntime, fileName),
        await readFile(join(fixture.candidateRoot, 'runtime', fileName)),
      );
    }
    await rm(join(fixture.candidateRoot, 'runtime'), { recursive: true, force: true });
    try {
      await symlink(escapedRuntime, join(fixture.candidateRoot, 'runtime'), 'junction');
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : '';
      if (code === 'EACCES' || code === 'EPERM') {
        t.skip(`symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    await assertMirrorStartRejects(
      {
        candidateRoot: fixture.candidateRoot,
        candidateId: fixture.candidateId,
        requirementId: 'windowsml-ocr',
      },
      /must be a regular file|must not resolve through a link|escaped the runtime candidate root/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('complete-body verifier rejects post-start truncation and same-length replacement', async () => {
  for (const mutation of [
    {
      name: 'truncate',
      apply: async (fixture: CandidateFixture) => truncate(fixture.archivePath, 1),
    },
    {
      name: 'same-length replacement',
      apply: async (fixture: CandidateFixture) => writeFile(
        fixture.archivePath,
        Buffer.alloc(fixture.candidateArchive.length, 0x5a),
      ),
    },
  ] as const) {
    const fixture = await createFixture();
    try {
      const mirror = await startLocalCandidateWorkerMirror({
        candidateRoot: fixture.candidateRoot,
        candidateId: fixture.candidateId,
        requirementId: 'windowsml-ocr',
      });
      try {
        await mutation.apply(fixture);
        await assert.rejects(
          requestBytes(`${mirror.baseUrl}/${encodeURIComponent(fixture.archiveName)}`)
            .then((response) => verifyCompleteBody(response, mirror.identity)),
          /complete-body verifier|aborted|socket hang up/,
          mutation.name,
        );
      } finally {
        await mirror.close();
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('streaming candidate archive verification has bounded external memory', async () => {
  const fixture = await createFixture();
  const archiveBytes = 151_979_169;
  try {
    await truncate(fixture.archivePath, archiveBytes);
    const catalog = await readCatalog(fixture);
    const requirements = catalog.requirements as Array<Record<string, unknown>>;
    const descriptor = (requirements[0].artifacts as Array<Record<string, unknown>>)[0];
    const archiveDigest = await digestFile(fixture.archivePath);
    descriptor.bytes = archiveDigest.bytes;
    descriptor.sha256 = archiveDigest.sha256;
    const candidateId = await rebindCandidate(fixture, catalog);
    const modulePath = fileURLToPath(new URL('./local-candidate-worker-mirror.ts', import.meta.url));
    const childScript = `
      import { pathToFileURL } from 'node:url';
      const module = await import(pathToFileURL(process.env.MIRROR_MODULE).href);
      if (global.gc) global.gc();
      const before = process.memoryUsage();
      const mirror = await module.startLocalCandidateWorkerMirror({
        candidateRoot: process.env.CANDIDATE_ROOT,
        candidateId: process.env.CANDIDATE_ID,
        requirementId: 'windowsml-ocr',
      });
      if (global.gc) global.gc();
      const after = process.memoryUsage();
      console.log(JSON.stringify({ before, after }));
      await mirror.close();
    `;
    const child = await new Promise<{ readonly code: number; readonly output: string }>((resolvePromise, reject) => {
      const childProcess = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', childScript], {
        env: {
          ...process.env,
          MIRROR_MODULE: modulePath,
          CANDIDATE_ROOT: fixture.candidateRoot,
          CANDIDATE_ID: candidateId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      childProcess.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      childProcess.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      childProcess.once('error', reject);
      childProcess.once('exit', (code) => resolvePromise({ code: code ?? -1, output }));
    });
    assert.equal(child.code, 0, child.output);
    const memory = JSON.parse(child.output.trim().split(/\r?\n/u).at(-1) ?? '') as {
      before: { readonly arrayBuffers: number; readonly external: number; readonly rss: number };
      after: { readonly arrayBuffers: number; readonly external: number; readonly rss: number };
    };
    const arrayBuffersDelta = memory.after.arrayBuffers - memory.before.arrayBuffers;
    const externalDelta = memory.after.external - memory.before.external;
    const rssDelta = memory.after.rss - memory.before.rss;
    const externalThreshold = 33_554_432;
    const rssThreshold = 64 * 1024 * 1024;
    console.log(`memory evidence: archiveBytes=${archiveBytes}, arrayBuffersDelta=${arrayBuffersDelta}, externalDelta=${externalDelta}, rssDelta=${rssDelta}, thresholdExternal=${externalThreshold}, thresholdRss=${rssThreshold}`);
    assert.ok(arrayBuffersDelta < externalThreshold, `archive-sized ArrayBuffer delta: ${arrayBuffersDelta}`);
    assert.ok(externalDelta < externalThreshold, `archive-sized external memory delta: ${externalDelta}`);
    assert.ok(rssDelta < rssThreshold, `archive-sized RSS delta: ${rssDelta}`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
