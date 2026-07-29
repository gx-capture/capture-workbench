import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  packagePublicationDecision,
  publishRelease,
  sha512Integrity,
} from './publish-release.ts';

const version = '0.3.2';
const tag = `v${version}`;
const runtimeAssetNames = [
  'capture-runtime-x86_64-pc-windows-msvc.exe',
  'capture-runtime-x86_64-pc-windows-msvc.exe.sha256',
  'capture-runtime-manifest.json',
  'capture-document-v1.schema.json',
];

function hash(bytes, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function success(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

function failure(stderr) {
  return { status: 1, stdout: '', stderr };
}

function observe(observable) {
  return new Promise((resolve, reject) => {
    observable.subscribe({ error: reject, complete: resolve });
  });
}

function createCandidate() {
  const root = mkdtempSync(join(tmpdir(), 'capture-publisher-'));
  const runtimeDirectory = join(root, 'runtime');
  mkdirSync(runtimeDirectory);
  const executableName = runtimeAssetNames[0];
  const executable = Buffer.from('runtime executable bytes');
  const executableDigest = hash(executable, 'sha256');
  const schema = Buffer.from('{"type":"object"}\n');
  const schemaDigest = hash(schema, 'sha256');
  writeFileSync(join(runtimeDirectory, executableName), executable);
  writeFileSync(
    join(runtimeDirectory, runtimeAssetNames[1]),
    `${executableDigest}  ${executableName}\n`,
  );
  writeFileSync(
    join(runtimeDirectory, runtimeAssetNames[2]),
    `${JSON.stringify({
      runtimeVersion: version,
      fileName: executableName,
      bytes: executable.length,
      sha256: executableDigest,
      schemaFileName: runtimeAssetNames[3],
      schemaSha256: schemaDigest,
    })}\n`,
  );
  writeFileSync(join(runtimeDirectory, runtimeAssetNames[3]), schema);
  const installerPath = join(root, `Capture Workbench_${version}_x64-setup.exe`);
  writeFileSync(installerPath, 'installer bytes');
  const packagePath = join(root, `gx-capture-capture-workbench-${version}.tgz`);
  const packageBytes = Buffer.from('package bytes');
  writeFileSync(packagePath, packageBytes);
  const packageIntegrity = `sha512-${hash(
    packageBytes,
    'sha512',
    'base64',
  )}`;
  return {
    root,
    input: {
      tag,
      version,
      runtimeDirectory,
      installerPath,
      packagePath,
    },
    assets: [...runtimeAssetNames, basename(installerPath)].map((name) =>
      name === basename(installerPath)
        ? installerPath
        : join(runtimeDirectory, name),
    ),
    packageIntegrity,
  };
}

function createRemote(candidate, initial = {}) {
  const calls = [];
  const assets = new Map(
    (initial.assets ?? []).map((path) => [
      basename(path),
      Buffer.from(readFileSync(path)),
    ]),
  );
  const state = {
    release: initial.release ?? 'missing',
    packageIntegrity: initial.packageIntegrity,
    fail: initial.fail,
  };
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'npm' && args[0] === 'pack') {
      return success(
        JSON.stringify([
          {
            name: '@gx-capture/capture-workbench',
            version,
            integrity: candidate.packageIntegrity,
          },
        ]),
      );
    }
    if (command === 'npm' && args[0] === 'view') {
      return state.packageIntegrity === undefined
        ? failure('E404 Not Found')
        : success(JSON.stringify(state.packageIntegrity));
    }
    if (command === 'npm' && args[0] === 'publish') {
      if (state.fail === 'publish') throw new Error('simulated npm failure');
      state.packageIntegrity = candidate.packageIntegrity;
      return success();
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'view') {
      return state.release === 'missing'
        ? failure('release not found')
        : success(JSON.stringify({ isDraft: state.release === 'draft' }));
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      state.release = 'draft';
      return success();
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1];
      const destination = args[args.indexOf('--dir') + 1];
      const bytes = assets.get(name);
      if (!bytes) return failure('no assets matched');
      writeFileSync(join(destination, name), bytes);
      return success();
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      const path = args[3];
      if (state.fail === `upload:${basename(path)}`) {
        throw new Error('simulated upload failure');
      }
      assets.set(basename(path), Buffer.from(readFileSync(path)));
      return success();
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'edit') {
      if (state.fail === 'edit') throw new Error('simulated edit failure');
      state.release = 'public';
      return success();
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { assets, calls, runCommand, state };
}

function mutations(calls) {
  return calls.filter(
    ([command, group, operation]) =>
      (command === 'gh' &&
        group === 'release' &&
        ['create', 'upload', 'edit'].includes(operation)) ||
      (command === 'npm' && group === 'publish'),
  );
}

test('package publication is idempotent only for exact integrity', () => {
  assert.equal(
    packagePublicationDecision(undefined, 'sha512-local'),
    'publish',
  );
  assert.equal(
    packagePublicationDecision('sha512-local', 'sha512-local'),
    'already-published',
  );
  assert.throws(
    () => packagePublicationDecision('sha512-remote', 'sha512-local'),
    /integrity differs/u,
  );
});

test('package integrity uses exact tarball bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capture-integrity-'));
  try {
    const path = join(root, 'package.tgz');
    writeFileSync(path, 'first');
    const first = await new Promise((resolve, reject) =>
      sha512Integrity(path).subscribe({ next: resolve, error: reject }),
    );
    writeFileSync(path, 'second');
    const second = await new Promise((resolve, reject) =>
      sha512Integrity(path).subscribe({ next: resolve, error: reject }),
    );
    assert.notEqual(first, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing state creates a draft and makes public only after assets and package verify', async () => {
  const candidate = createCandidate();
  try {
    const remote = createRemote(candidate);
    await observe(
      publishRelease(candidate.input, { runCommand: remote.runCommand }),
    );
    assert.equal(remote.state.release, 'public');
    assert.equal(remote.state.packageIntegrity, candidate.packageIntegrity);
    assert.deepEqual([...remote.assets.keys()].sort(), [
      ...runtimeAssetNames,
      basename(candidate.input.installerPath),
    ].sort());
    const mutationCalls = mutations(remote.calls);
    assert.deepEqual(mutationCalls[0].slice(0, 3), [
      'gh',
      'release',
      'create',
    ]);
    assert.deepEqual(mutationCalls.at(-1).slice(0, 3), [
      'gh',
      'release',
      'edit',
    ]);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('draft retry uploads only missing assets and skips an exact package', async () => {
  const candidate = createCandidate();
  try {
    const remote = createRemote(candidate, {
      release: 'draft',
      packageIntegrity: candidate.packageIntegrity,
      assets: candidate.assets.slice(0, 4),
    });
    await observe(
      publishRelease(candidate.input, { runCommand: remote.runCommand }),
    );
    const uploads = remote.calls.filter(
      ([command, group, operation]) =>
        command === 'gh' && group === 'release' && operation === 'upload',
    );
    assert.equal(uploads.length, 1);
    assert.equal(basename(uploads[0][4]), basename(candidate.input.installerPath));
    assert.equal(
      remote.calls.some(
        ([command, operation]) =>
          command === 'npm' && operation === 'publish',
      ),
      false,
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('exact public release retry is read-only', async () => {
  const candidate = createCandidate();
  try {
    const remote = createRemote(candidate, {
      release: 'public',
      packageIntegrity: candidate.packageIntegrity,
      assets: candidate.assets,
    });
    await observe(
      publishRelease(candidate.input, { runCommand: remote.runCommand }),
    );
    assert.deepEqual(mutations(remote.calls), []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('public release with a missing or different asset fails read-only', async () => {
  const candidate = createCandidate();
  try {
    const missing = createRemote(candidate, {
      release: 'public',
      packageIntegrity: candidate.packageIntegrity,
      assets: candidate.assets.slice(0, 4),
    });
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: missing.runCommand }),
      ),
      /missing/u,
    );
    assert.deepEqual(mutations(missing.calls), []);

    const different = createRemote(candidate, {
      release: 'public',
      packageIntegrity: candidate.packageIntegrity,
      assets: candidate.assets,
    });
    different.assets.set(runtimeAssetNames[0], Buffer.from('different'));
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: different.runCommand }),
      ),
      /differs/u,
    );
    assert.deepEqual(mutations(different.calls), []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('package conflict and malformed local candidate stop before mutations', async () => {
  const candidate = createCandidate();
  try {
    const conflict = createRemote(candidate, {
      packageIntegrity: 'sha512-different',
    });
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: conflict.runCommand }),
      ),
      /integrity differs/u,
    );
    assert.deepEqual(mutations(conflict.calls), []);

    writeFileSync(join(candidate.input.runtimeDirectory, 'unexpected.txt'), 'x');
    const invalid = createRemote(candidate);
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: invalid.runCommand }),
      ),
      /only the canonical assets/u,
    );
    assert.deepEqual(invalid.calls, []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('symlinked candidate assets are rejected during local preflight', async (t) => {
  const candidate = createCandidate();
  try {
    const asset = join(candidate.input.runtimeDirectory, runtimeAssetNames[3]);
    rmSync(asset);
    try {
      symlinkSync(candidate.input.packagePath, asset);
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('Windows symlink creation is not available.');
        return;
      }
      throw error;
    }
    const remote = createRemote(candidate);
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /non-symlink/u,
    );
    assert.deepEqual(remote.calls, []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('candidate installer must be a regular nonempty file before remote inspection', async () => {
  const candidate = createCandidate();
  try {
    rmSync(candidate.input.installerPath);
    mkdirSync(candidate.input.installerPath);
    const remote = createRemote(candidate);
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /regular non-symlink file/u,
    );
    assert.deepEqual(remote.calls, []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('upload and npm failures leave the release draft', async () => {
  for (const fail of [
    `upload:${runtimeAssetNames[0]}`,
    'publish',
  ]) {
    const candidate = createCandidate();
    try {
      const remote = createRemote(candidate, { fail });
      await assert.rejects(
        observe(
          publishRelease(candidate.input, { runCommand: remote.runCommand }),
        ),
        /simulated/u,
      );
      assert.equal(remote.state.release, 'draft');
      assert.equal(
        remote.calls.some(
          ([command, group, operation]) =>
            command === 'gh' &&
            group === 'release' &&
            operation === 'edit',
        ),
        false,
      );
    } finally {
      rmSync(candidate.root, { recursive: true, force: true });
    }
  }
});

test('failed final edit is resumable without replacing matching bytes', async () => {
  const candidate = createCandidate();
  try {
    const remote = createRemote(candidate, { fail: 'edit' });
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /simulated edit/u,
    );
    assert.equal(remote.state.release, 'draft');
    const uploadsAfterFailure = remote.calls.filter(
      ([command, group, operation]) =>
        command === 'gh' && group === 'release' && operation === 'upload',
    ).length;
    remote.state.fail = undefined;
    await observe(
      publishRelease(candidate.input, { runCommand: remote.runCommand }),
    );
    assert.equal(remote.state.release, 'public');
    assert.equal(
      remote.calls.filter(
        ([command, group, operation]) =>
          command === 'gh' && group === 'release' && operation === 'upload',
      ).length,
      uploadsAfterFailure,
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});
