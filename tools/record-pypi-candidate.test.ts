import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseProjects,
  projectArtifacts,
  preflightPypiCandidate,
  recordPypiCandidate,
  type PypiCandidateInput,
} from './record-pypi-candidate.ts';
import { verifyRegistryLedger } from './verify-registry-ledgers.ts';

const version = '0.4.2';
const sourceCommit = 'a'.repeat(40);
const contractSetSha256 = 'c'.repeat(64);
const names = [
  'capture_runtime_client-0.4.2-py3-none-any.whl',
  'capture_runtime_client-0.4.2.tar.gz',
];
const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

async function packageFixture(
  kind: PypiCandidateInput['candidateKind'] = 'package',
) {
  const root = await mkdtemp(join(tmpdir(), 'pypi-preflight-'));
  const candidate = join(root, 'candidate');
  const pythonDirectory = join(root, 'staged');
  await mkdir(join(candidate, 'python'), { recursive: true });
  await mkdir(pythonDirectory);
  const artifacts = [];
  for (const name of names) {
    const bytes = Buffer.from(`approved ${name}`);
    await writeFile(join(candidate, 'python', name), bytes);
    await writeFile(join(pythonDirectory, name), bytes);
    artifacts.push({
      path: `python/${name}`,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  }
  const commonFiles = [
    'contracts/contract-set.json',
    'contracts/contract-set.sha256',
    'contracts/contract-snapshot.json',
  ];
  const packageFiles = [
    'package/gx-capture-capture-workbench-ui-0.4.2.tgz',
    'package/gx-capture-capture-runtime-client-0.4.2.tgz',
    'package-manifest.json',
    'java-candidate-manifest.json',
    'maven/capture-runtime-client-0.4.2.jar',
    'maven/capture-runtime-client-0.4.2-sources.jar',
    'maven/pom.xml',
    'maven/capture-runtime-contract-set.sha256',
  ];
  const runtimeFiles = [
    'runtime/capture-runtime.exe',
    'runtime/capture-runtime-manifest.json',
    'runtime/capture-engine-catalog.json',
    'runtime/capture-document-v2.schema.json',
    'crate/capture-sidecar-launcher-0.4.2.crate',
  ];
  for (const path of [
    ...commonFiles,
    ...(kind === 'package' ? packageFiles : runtimeFiles),
  ]) {
    const bytes = Buffer.from(`fixture ${path}`);
    await mkdir(join(candidate, path, '..'), { recursive: true });
    await writeFile(join(candidate, path), bytes);
    artifacts.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  const base =
    kind === 'package'
      ? {
          schemaVersion: '1',
          candidateKind: 'npm-package-set',
          sourceCommit,
          releaseVersion: version,
          producerRunId: 42,
          packageManifestSha256: hash(
            await readFile(join(candidate, 'package-manifest.json')),
          ),
          contractSetSha256,
          artifacts,
          toolchains: { node: 'v24.0.0', python: '3.12' },
        }
      : {
          schemaVersion: '1',
          candidateKind: 'runtime',
          sourceCommit,
          releaseVersion: version,
          releaseMode: 'core-only',
          producerRunId: 43,
          packageCandidateId: 'b'.repeat(64),
          contractSetSha256,
          artifacts,
          toolchains: {
            node: 'v24.0.0',
            python: '3.12',
            runtime: 'capture-runtime',
          },
        };
  const candidateId = hash(JSON.stringify(base));
  let bytes = `${JSON.stringify({ ...base, candidateId }, null, 2)}\n`;
  const sourceDigest = hash(bytes);
  let releaseCandidateId = candidateId;
  if (kind === 'full-release') {
    await writeFile(join(candidate, 'runtime-candidate-manifest.json'), bytes);
    const full = {
      schemaVersion: '1',
      sourceCommit,
      releaseVersion: version,
      releaseMode: 'core-only',
      runtimeApiVersion: '2.0',
      documentSchemaVersion: '2',
      contractSetSha256,
      artifacts: [
        ...artifacts,
        { path: 'bundle/product.exe', bytes: 7, sha256: hash('desktop') },
      ],
      toolchains: { node: 'v24.0.0' },
      contractImpact: null,
      packageCandidateId: 'b'.repeat(64),
      runtimeCandidateId: candidateId,
    };
    await mkdir(join(candidate, 'bundle'));
    await writeFile(join(candidate, 'bundle/product.exe'), 'desktop');
    releaseCandidateId = hash(JSON.stringify(full));
    bytes = `${JSON.stringify({ ...full, candidateId: releaseCandidateId }, null, 2)}\n`;
  }
  await writeFile(join(candidate, 'candidate-manifest.json'), bytes);
  return {
    root,
    input: {
      candidate,
      pythonDirectory,
      candidateKind: kind,
      version,
      sourceCommit,
      candidateId,
      releaseCandidateId,
      packageCandidateId: kind === 'package' ? candidateId : 'b'.repeat(64),
      candidateManifestSha256: hash(bytes),
      sourceCandidateManifestSha256: sourceDigest,
      contractSetSha256,
    } satisfies PypiCandidateInput,
  };
}

function cliArguments(
  input: Awaited<ReturnType<typeof packageFixture>>['input'],
) {
  return Object.entries(input).flatMap(([name, value]) => [
    `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
    value,
  ]);
}

test('preflight CLI accepts an exact package candidate on definite PyPI 404 without writing a published ledger', async () => {
  const fixture = await packageFixture();
  try {
    const bindingPath = join(fixture.root, 'binding.json');
    const mock = `globalThis.fetch = async () => new Response(null, { status: 404 });`;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(mock)}`,
        join(import.meta.dirname, 'record-pypi-candidate.ts'),
        '--mode',
        'preflight',
        ...cliArguments(fixture.input),
        '--binding',
        bindingPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    assert.equal(binding.candidateId, fixture.input.candidateId);
    assert.equal(
      binding.sourceCandidateManifestSha256,
      fixture.input.candidateManifestSha256,
    );
    assert.equal(binding.status, undefined);
    assert.equal(binding.artifacts.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

const absent: typeof fetch = async () => new Response(null, { status: 404 });
const remoteItems = names.map((filename) => ({
  filename,
  digests: { sha256: hash(`approved ${filename}`) },
}));
function remote(
  urls: unknown = remoteItems,
  info: unknown = { name: 'capture-runtime-client', version },
): typeof fetch {
  return async (url) => {
    assert.equal(
      String(url),
      'https://pypi.org/pypi/capture-runtime-client/0.4.2/json',
    );
    return Response.json({ info, urls });
  };
}

for (const kind of ['package', 'runtime', 'full-release'] as const) {
  test(`${kind} preflight and record retain exact source/release IDs and raw manifest digests`, async () => {
    const fixture = await packageFixture(kind);
    try {
      const binding = await preflightPypiCandidate(fixture.input, absent);
      const ledger = await recordPypiCandidate(
        fixture.input,
        binding,
        remote(),
      );
      verifyRegistryLedger(
        ledger,
        'pypi',
        fixture.input.releaseCandidateId,
        version,
        {
          sourceCandidateId: fixture.input.candidateId,
          releaseCandidateId: fixture.input.releaseCandidateId,
          sourceCandidateManifestSha256:
            fixture.input.sourceCandidateManifestSha256,
          contractSetSha256,
        },
      );
      assert.deepEqual(
        ledger.artifacts,
        remoteItems.map((item) => ({
          name: item.filename,
          sha256: item.digests.sha256,
        })),
      );
      if (kind === 'full-release')
        assert.notEqual(
          ledger.sourceCandidateManifestSha256,
          fixture.input.candidateManifestSha256,
        );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test('preflight permits exact wheel-only, sdist-only and complete retries but record requires the complete pair', async () => {
  const fixture = await packageFixture();
  try {
    for (const urls of [[remoteItems[0]], [remoteItems[1]], remoteItems]) {
      const binding = await preflightPypiCandidate(fixture.input, remote(urls));
      if (urls.length === 1)
        await assert.rejects(
          recordPypiCandidate(fixture.input, binding, remote(urls)),
          /incomplete/u,
        );
      else await recordPypiCandidate(fixture.input, binding, remote(urls));
    }
    const binding = await preflightPypiCandidate(fixture.input, absent);
    await assert.rejects(
      recordPypiCandidate(fixture.input, binding, absent),
      /HTTP 404/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('remote conflicting, extra, duplicate and malformed data fail both preflight and readback', async () => {
  const fixture = await packageFixture();
  try {
    const binding = await preflightPypiCandidate(fixture.input, absent);
    const invalid = [
      remote([{ ...remoteItems[0], digests: { sha256: 'f'.repeat(64) } }]),
      remote([
        ...remoteItems,
        { filename: 'unexpected.whl', digests: { sha256: 'f'.repeat(64) } },
      ]),
      remote([...remoteItems, remoteItems[0]]),
      remote([{ ...remoteItems[0], digests: { sha256: 'bad' } }]),
      remote([null]),
      remote([]),
      remote(null),
      remote({}, undefined),
      remote(remoteItems, { name: 'another-project', version }),
      remote(remoteItems, { name: 'capture-runtime-client', version: '0.4.1' }),
      async () => new Response('{', { status: 200 }),
      async () =>
        Response.json({ info: { name: 'capture-runtime-client', version } }),
      ...[401, 403, 429, 500, 503].map(
        (status) => async () => new Response(null, { status }),
      ),
      async () => {
        throw new Error('network unavailable');
      },
    ];
    for (const fetch of invalid) {
      await assert.rejects(preflightPypiCandidate(fixture.input, fetch));
      await assert.rejects(recordPypiCandidate(fixture.input, binding, fetch));
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('every missing or conflicting expected identity fails before any registry request', async () => {
  const fixture = await packageFixture('runtime');
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => {
    requests++;
    return new Response(null, { status: 404 });
  };
  try {
    for (const name of Object.keys(fixture.input)) {
      await assert.rejects(
        preflightPypiCandidate(
          {
            ...fixture.input,
            [name]: undefined,
          } as unknown as PypiCandidateInput,
          fetch,
        ),
        `missing ${name}`,
      );
    }
    for (const [name, value] of Object.entries({
      candidateKind: 'guess',
      version: '0.4.3',
      sourceCommit: 'f'.repeat(40),
      candidateId: 'f'.repeat(64),
      releaseCandidateId: 'f'.repeat(64),
      packageCandidateId: 'f'.repeat(64),
      candidateManifestSha256: 'f'.repeat(64),
      sourceCandidateManifestSha256: 'f'.repeat(64),
      contractSetSha256: 'f'.repeat(64),
    })) {
      await assert.rejects(
        preflightPypiCandidate(
          { ...fixture.input, [name]: value } as PypiCandidateInput,
          fetch,
        ),
        `conflicting ${name}`,
      );
    }
    assert.equal(requests, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

type MutableManifest = Record<string, unknown> & {
  artifacts: Array<{ path: string; bytes: number; sha256: string }>;
};

function artifact(manifest: MutableManifest, suffix: string) {
  const value = manifest.artifacts.find((item) => item.path.endsWith(suffix));
  assert(value, `Fixture artifact ${suffix} is missing.`);
  return value;
}

async function rewriteMain(
  fixture: Awaited<ReturnType<typeof packageFixture>>,
  mutate: (value: MutableManifest) => void,
) {
  const path = join(fixture.input.candidate, 'candidate-manifest.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  mutate(value);
  delete value.candidateId;
  const candidateId = hash(JSON.stringify(value));
  const bytes = `${JSON.stringify({ ...value, candidateId }, null, 2)}\n`;
  await writeFile(path, bytes);
  fixture.input.releaseCandidateId = candidateId;
  fixture.input.candidateManifestSha256 = hash(bytes);
  if (fixture.input.candidateKind !== 'full-release') {
    fixture.input.candidateId = candidateId;
    fixture.input.sourceCandidateManifestSha256 = hash(bytes);
    if (fixture.input.candidateKind === 'package')
      fixture.input.packageCandidateId = candidateId;
  }
}

test('resealed manifests cannot hide duplicate/aliased paths, wrong pair or full runtime relationship conflicts', async () => {
  const cases: Array<
    [PypiCandidateInput['candidateKind'], (manifest: MutableManifest) => void]
  > = [
    ['package', (m) => m.artifacts.push(m.artifacts[0])],
    [
      'package',
      (m) =>
        m.artifacts.push({
          ...m.artifacts[0],
          path: m.artifacts[0].path.toUpperCase(),
        }),
    ],
    [
      'package',
      (m) => {
        m.artifacts[0].path = 'python/../escaped.whl';
      },
    ],
    [
      'package',
      (m) => {
        artifact(m, '.tar.gz').path =
          'python/capture_runtime_client-0.4.2-cp312-none-any.whl';
      },
    ],
    [
      'full-release',
      (m) => {
        m.runtimeCandidateId = 'f'.repeat(64);
      },
    ],
    [
      'full-release',
      (m) => {
        m.packageCandidateId = 'f'.repeat(64);
      },
    ],
    [
      'full-release',
      (m) => {
        m.releaseMode = 'model-enabled';
      },
    ],
    [
      'full-release',
      (m) => {
        artifact(m, '.whl').sha256 = 'f'.repeat(64);
      },
    ],
    [
      'full-release',
      (m) => {
        m.candidateKind = 'runtime';
      },
    ],
  ];
  for (const [kind, mutate] of cases) {
    const fixture = await packageFixture(kind);
    let requests = 0;
    try {
      await rewriteMain(fixture, mutate);
      await assert.rejects(
        preflightPypiCandidate(fixture.input, async () => {
          requests++;
          return new Response(null, { status: 404 });
        }),
      );
      assert.equal(requests, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('source, staging, main, alias and saved-binding substitutions cannot produce a passing ledger', async () => {
  for (const target of [
    'source',
    'staged',
    'main',
    'alias',
    'binding',
    'extra',
    'missing-alias',
    'ambiguous-alias',
  ]) {
    const fixture = await packageFixture(
      target === 'ambiguous-alias' ? 'runtime' : 'full-release',
    );
    let requests = 0;
    try {
      const binding = await preflightPypiCandidate(fixture.input, absent);
      if (target === 'binding') binding.candidateId = 'f'.repeat(64);
      else if (target === 'missing-alias')
        await rm(
          join(fixture.input.candidate, 'runtime-candidate-manifest.json'),
        );
      else if (target === 'ambiguous-alias')
        await writeFile(
          join(fixture.input.candidate, 'runtime-candidate-manifest.json'),
          '{}',
        );
      else {
        const path =
          target === 'source'
            ? join(fixture.input.candidate, 'python', names[0])
            : target === 'staged'
              ? join(fixture.input.pythonDirectory, names[0])
              : target === 'extra'
                ? join(fixture.input.pythonDirectory, 'unexpected.txt')
                : join(
                    fixture.input.candidate,
                    target === 'main'
                      ? 'candidate-manifest.json'
                      : 'runtime-candidate-manifest.json',
                  );
        await writeFile(
          path,
          target === 'main' || target === 'alias'
            ? `${await readFile(path, 'utf8')} `
            : 'changed',
        );
      }
      await assert.rejects(
        recordPypiCandidate(fixture.input, binding, async () => {
          requests++;
          return remote()('unused');
        }),
      );
      assert.equal(requests, 0, target);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('mutation during remote reconciliation or readback fails without returning passing evidence', async () => {
  for (const mode of ['preflight', 'record']) {
    const fixture = await packageFixture();
    try {
      const binding = await preflightPypiCandidate(fixture.input, absent);
      const fetch: typeof globalThis.fetch = async () => {
        await writeFile(
          join(fixture.input.pythonDirectory, names[0]),
          'substituted during fetch',
        );
        return Response.json({
          info: { name: 'capture-runtime-client', version },
          urls: remoteItems,
        });
      };
      await assert.rejects(
        mode === 'preflight'
          ? preflightPypiCandidate(fixture.input, fetch)
          : recordPypiCandidate(fixture.input, binding, fetch),
        /artifact (size|digest) differs/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('CLI record requires an unchanged preflight binding and writes the complete ledger only after readback', async () => {
  const fixture = await packageFixture('runtime');
  try {
    const binding = join(fixture.root, 'binding.json');
    const output = join(fixture.root, 'ledger.json');
    const invoke = (mode: string, mock: string, extra: string[] = []) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          `data:text/javascript,${encodeURIComponent(mock)}`,
          join(import.meta.dirname, 'record-pypi-candidate.ts'),
          '--mode',
          mode,
          ...cliArguments(fixture.input),
          '--binding',
          binding,
          ...extra,
        ],
        { encoding: 'utf8' },
      );
    const before = invoke(
      'preflight',
      'globalThis.fetch=async()=>new Response(null,{status:404});',
    );
    assert.equal(before.status, 0, before.stderr);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    const saved = await readFile(binding);
    const changed = JSON.parse(saved.toString('utf8'));
    changed.releaseCandidateId = 'f'.repeat(64);
    await writeFile(binding, JSON.stringify(changed));
    const mock = `globalThis.fetch=async()=>Response.json(${JSON.stringify({ info: { name: 'capture-runtime-client', version }, urls: remoteItems })});`;
    const rejected = invoke('record', mock, ['--output', output]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /preflight binding differs/u);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    await writeFile(binding, saved);
    const recorded = invoke('record', mock, ['--output', output]);
    assert.equal(recorded.status, 0, recorded.stderr);
    verifyRegistryLedger(
      JSON.parse(await readFile(output, 'utf8')),
      'pypi',
      fixture.input.candidateId,
      version,
      {
        releaseCandidateId: fixture.input.releaseCandidateId,
        contractSetSha256,
        sourceCandidateManifestSha256:
          fixture.input.sourceCandidateManifestSha256,
      },
    );
    for (const mode of ['', 'guess']) {
      const rejected = invoke(
        mode,
        'globalThis.fetch=async()=>{throw new Error("UNEXPECTED NETWORK")};',
      );
      assert.notEqual(rejected.status, 0);
      assert.doesNotMatch(rejected.stderr, /UNEXPECTED NETWORK/u);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('full runtime aliases are independently validated even when both candidate IDs and digests are resealed', async () => {
  const changes: Array<(manifest: MutableManifest) => void> = [
    (m) => {
      m.sourceCommit = 'f'.repeat(40);
    },
    (m) => {
      m.releaseVersion = '0.4.3';
    },
    (m) => {
      m.contractSetSha256 = 'f'.repeat(64);
    },
    (m) => {
      m.packageCandidateId = 'f'.repeat(64);
    },
    (m) => {
      m.candidateKind = 'npm-package-set';
    },
    (m) => {
      m.artifacts.push(m.artifacts[0]);
    },
    (m) => {
      artifact(m, '.whl').sha256 = 'f'.repeat(64);
    },
  ];
  for (const change of changes) {
    const fixture = await packageFixture('full-release');
    let requests = 0;
    try {
      const path = join(
        fixture.input.candidate,
        'runtime-candidate-manifest.json',
      );
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      change(manifest);
      delete manifest.candidateId;
      const candidateId = hash(JSON.stringify(manifest));
      const bytes = JSON.stringify({ ...manifest, candidateId });
      await writeFile(path, bytes);
      fixture.input.candidateId = candidateId;
      fixture.input.sourceCandidateManifestSha256 = hash(bytes);
      await rewriteMain(fixture, (m) => {
        m.runtimeCandidateId = candidateId;
      });
      await assert.rejects(
        preflightPypiCandidate(fixture.input, async () => {
          requests++;
          return new Response(null, { status: 404 });
        }),
      );
      assert.equal(requests, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('preflight rejects substituted local bytes, extra staging files and directory aliases before remote access', async () => {
  for (const target of ['source', 'staged', 'extra', 'directory-alias']) {
    const fixture = await packageFixture();
    let requests = 0;
    try {
      if (target === 'directory-alias') {
        await rename(
          fixture.input.pythonDirectory,
          join(fixture.root, 'old-staged'),
        );
        await symlink(
          join(fixture.input.candidate, 'python'),
          fixture.input.pythonDirectory,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } else {
        const path =
          target === 'source'
            ? join(fixture.input.candidate, 'python', names[0])
            : join(
                fixture.input.pythonDirectory,
                target === 'extra' ? 'extra.txt' : names[0],
              );
        await writeFile(path, 'substituted');
      }
      await assert.rejects(
        preflightPypiCandidate(fixture.input, async () => {
          requests++;
          return new Response(null, { status: 404 });
        }),
      );
      assert.equal(requests, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('PyPI record lane can select one project without accepting the other package', () => {
  assert.deepEqual(parseProjects('capture-runtime-client'), [
    'capture-runtime-client',
  ]);
  assert.deepEqual(
    projectArtifacts(
      [
        'capture_runtime_client-0.4.2-py3-none-any.whl',
        'capture_runtime_client-0.4.2.tar.gz',
      ],
      'capture-runtime-client',
    ),
    [
      'capture_runtime_client-0.4.2-py3-none-any.whl',
      'capture_runtime_client-0.4.2.tar.gz',
    ],
  );
  assert.throws(
    () => parseProjects('capture-runtime-client,capture-runtime-client'),
    /invalid/u,
  );
});
