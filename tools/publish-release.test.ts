import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import {
  packagePublicationDecision,
  parseArguments,
  publishRelease,
  sha512Integrity,
} from './publish-release.ts';

const version = '0.3.9';
const tag = `v${version}`;
const runtimeAssetNames = [
  'capture-runtime-x86_64-pc-windows-msvc.exe',
  'capture-runtime-x86_64-pc-windows-msvc.exe.sha256',
  'capture-runtime-manifest.json',
  'capture-document-v1.schema.json',
];
const engineCatalogName = 'capture-engine-catalog.json';
const runtimeSizeReportName = 'runtime-size-report.json';
const packageNames = [
  '@gx-capture/capture-contracts',
  '@gx-capture/capture-workbench',
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
  const installerPath = join(
    root,
    `Capture.Workbench_${version}_x64-setup.exe`,
  );
  const installerBytes = Buffer.from('installer bytes');
  writeFileSync(installerPath, installerBytes);
  const descriptors = [
    ['windowsml-ocr', 'worker', 'capture-engine-ocr.zip'],
    ['whisper-primary', 'worker', 'capture-engine-whisper.zip'],
  ].map(([requirementId, role, fileName]) => {
    const archive = Buffer.from(`${fileName} bytes`);
    const sidecarName = `${fileName.slice(0, -4)}-files.json`;
    const sidecar = Buffer.from(
      `${JSON.stringify({
        manifestVersion: '1',
        files: [
          {
            path: fileName,
            bytes: archive.length,
            sha256: hash(archive, 'sha256'),
          },
        ],
      })}\n`,
    );
    writeFileSync(join(runtimeDirectory, fileName), archive);
    writeFileSync(join(runtimeDirectory, sidecarName), sidecar);
    for (const [name, bytes] of [
      [fileName, archive],
      [sidecarName, sidecar],
    ]) {
      writeFileSync(
        join(runtimeDirectory, `${name}.sha256`),
        `${hash(bytes, 'sha256')}  ${name}\n`,
      );
    }
    return {
      requirementId,
      role,
      fileName,
      bytes: archive.length,
      sha256: hash(archive, 'sha256'),
      filesManifestSha256: hash(sidecar, 'sha256'),
    };
  });
  const catalog = Buffer.from(
    `${JSON.stringify({
      catalogVersion: '2',
      runtimeVersion: version,
      requirements: ['windowsml-ocr', 'whisper-primary'].map(
        (requirementId) => ({
          requirementId,
          unavailableReason: null,
          artifacts: descriptors.filter(
            (descriptor) => descriptor.requirementId === requirementId,
          ),
          modelFiles: {
            artifactVersion: version,
            entryCount: 1,
            entryPoint: 'model',
            extractedBytes: 1,
            files: [
              {
                bytes: 1,
                derivation: null,
                kind: 'source',
                licensePath: 'licenses/LICENSE.txt',
                noticePath: 'notices/NOTICE.txt',
                owner: 'test-owner',
                path: 'model/model.bin',
                redirectHosts: [],
                revision: 'a'.repeat(40),
                sha256: 'b'.repeat(64),
                spdx: 'MIT',
                url: `https://models.example.test/${'a'.repeat(40)}/model.bin`,
              },
            ],
            manifestSha256: 'c'.repeat(64),
            sourceLockSha256: 'd'.repeat(64),
          },
        }),
      ),
    })}\n`,
  );
  writeFileSync(join(runtimeDirectory, engineCatalogName), catalog);
  writeFileSync(
    join(runtimeDirectory, `${engineCatalogName}.sha256`),
    `${hash(catalog, 'sha256')}  ${engineCatalogName}\n`,
  );
  const sizeReport = Buffer.from(
    `${JSON.stringify({
      arch: 'x86_64',
      installedBytes: 12345,
      installedBytesBlocker: null,
      nsisInstaller: {
        path: installerPath,
        fileName: basename(installerPath),
        bytes: installerBytes.length,
        sha256: hash(installerBytes, 'sha256'),
      },
      platform: 'windows',
      pyinstaller: {
        blocker: null,
        categories: {
          core: 0,
          ocr: 0,
          other: 0,
          pdf: 0,
          whisper: 0,
        },
        files: [],
        topFiles: [],
      },
      pythonVersion: '3.12.12',
      reportVersion: '2',
      runtimeExecutable: {
        path: join(runtimeDirectory, executableName),
        fileName: executableName,
        bytes: executable.length,
        sha256: executableDigest,
      },
    })}\n`,
  );
  writeFileSync(join(runtimeDirectory, runtimeSizeReportName), sizeReport);
  writeFileSync(
    join(runtimeDirectory, `${runtimeSizeReportName}.sha256`),
    `${hash(sizeReport, 'sha256')}  ${runtimeSizeReportName}\n`,
  );
  const packageEntries = packageNames.map((name) => {
    const packageSlug = name.replace('@gx-capture/', '');
    const packagePath = join(root, `${packageSlug}-${version}.tgz`);
    const packageBytes = Buffer.from(`${name} package bytes`);
    writeFileSync(packagePath, packageBytes);
    return {
      name,
      packagePath,
      packageIntegrity: `sha512-${hash(packageBytes, 'sha512', 'base64')}`,
    };
  });
  const packageIntegrities = Object.fromEntries(
    packageEntries.map(({ name, packageIntegrity }) => [
      name,
      packageIntegrity,
    ]),
  );
  const workbenchPackage = packageEntries.find(
    ({ name }) => name === '@gx-capture/capture-workbench',
  );
  return {
    root,
    input: {
      tag,
      version,
      runtimeDirectory,
      installerPath,
      packagePaths: packageEntries.map(({ packagePath }) => packagePath),
      packagePath: workbenchPackage.packagePath,
    },
    assets: [
      ...readdirSync(runtimeDirectory).map((name) =>
        join(runtimeDirectory, name),
      ),
      installerPath,
    ],
    packageEntries,
    packageIntegrities,
    packageIntegrity: workbenchPackage.packageIntegrity,
  };
}

function writeCandidateCatalog(candidate, payload) {
  const catalog = Buffer.from(`${JSON.stringify(payload)}\n`);
  writeFileSync(
    join(candidate.input.runtimeDirectory, engineCatalogName),
    catalog,
  );
  writeFileSync(
    join(candidate.input.runtimeDirectory, `${engineCatalogName}.sha256`),
    `${hash(catalog, 'sha256')}  ${engineCatalogName}\n`,
  );
}

function writeCandidateSizeReport(candidate, payload) {
  const report = Buffer.from(`${JSON.stringify(payload)}\n`);
  writeFileSync(
    join(candidate.input.runtimeDirectory, runtimeSizeReportName),
    report,
  );
  writeFileSync(
    join(candidate.input.runtimeDirectory, `${runtimeSizeReportName}.sha256`),
    `${hash(report, 'sha256')}  ${runtimeSizeReportName}\n`,
  );
}

function makeCoreOnly(candidate) {
  for (const name of readdirSync(candidate.input.runtimeDirectory)) {
    if (
      name.startsWith('capture-engine-ocr') ||
      name.startsWith('capture-engine-whisper')
    ) {
      rmSync(join(candidate.input.runtimeDirectory, name), { force: true });
    }
  }
  writeCandidateCatalog(candidate, {
    catalogVersion: '2',
    requirements: [],
    runtimeVersion: version,
  });
}

function createRemote(candidate, initial = {}) {
  const calls = [];
  const assets = new Map(
    (initial.assets ?? []).map((path) => [
      basename(path),
      Buffer.from(readFileSync(path)),
    ]),
  );
  const hasInitialPackageIntegrity = Object.hasOwn(initial, 'packageIntegrity');
  const state = {
    release: initial.release ?? 'missing',
    packageIntegrities: {
      ...(hasInitialPackageIntegrity ? candidate.packageIntegrities : {}),
      ...(hasInitialPackageIntegrity
        ? { '@gx-capture/capture-workbench': initial.packageIntegrity }
        : {}),
      ...(initial.packageIntegrities ?? {}),
    },
    packageIntegrity: hasInitialPackageIntegrity
      ? initial.packageIntegrity
      : undefined,
    fail: initial.fail,
    reportedAssetNames: initial.reportedAssetNames,
  };
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'npm' && args[0] === 'pack') {
      const packagePath = args.at(-1);
      const packageEntry = candidate.packageEntries.find(
        ({ packagePath: candidatePackagePath }) =>
          candidatePackagePath === packagePath,
      );
      if (!packageEntry)
        throw new Error(`Unknown package path: ${packagePath}`);
      return success(
        JSON.stringify([
          {
            name: packageEntry.name,
            version,
            integrity: packageEntry.packageIntegrity,
          },
        ]),
      );
    }
    if (command === 'npm' && args[0] === 'view') {
      const packageSpecifier = args[1];
      const packageName = packageSpecifier.slice(
        0,
        packageSpecifier.lastIndexOf('@'),
      );
      const packageIntegrity = state.packageIntegrities[packageName];
      return packageIntegrity === undefined
        ? failure('E404 Not Found')
        : success(JSON.stringify(packageIntegrity));
    }
    if (command === 'npm' && args[0] === 'publish') {
      if (state.fail === 'publish') throw new Error('simulated npm failure');
      const packageEntry = candidate.packageEntries.find(
        ({ packagePath }) => packagePath === args[1],
      );
      if (!packageEntry) throw new Error(`Unknown package path: ${args[1]}`);
      state.packageIntegrities[packageEntry.name] =
        packageEntry.packageIntegrity;
      state.packageIntegrity =
        state.packageIntegrities['@gx-capture/capture-workbench'];
      return success();
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'view') {
      return state.release === 'missing'
        ? failure('release not found')
        : success(
            JSON.stringify({
              assets: (state.reportedAssetNames ?? [...assets.keys()]).map(
                (name) => ({ name }),
              ),
              isDraft: state.release === 'draft',
            }),
          );
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      state.release = 'draft';
      return success();
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1];
      const destination = args[args.indexOf('--dir') + 1];
      const bytes = assets.get(name);
      if (!bytes) {
        return failure(
          assets.size === 0
            ? 'no assets to download'
            : 'no assets match the file pattern',
        );
      }
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

test('release argument parser accepts the complete package set', () => {
  const parsed = parseArguments([
    '--tag',
    tag,
    '--runtime-dir',
    'runtime',
    '--installer',
    'installer.exe',
    '--package',
    'capture-workbench.tgz',
    '--package',
    'capture-contracts.tgz',
  ]);
  assert.deepEqual(
    parsed.packagePaths.map((path) => basename(path)),
    ['capture-workbench.tgz', 'capture-contracts.tgz'],
  );
  assert.throws(
    () =>
      parseArguments([
        '--tag',
        tag,
        '--runtime-dir',
        'runtime',
        '--installer',
        'installer.exe',
      ]),
    /one or more --package/u,
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

test('zero-asset draft uploads from inventory before readback, package, and public edit', async () => {
  const candidate = createCandidate();
  try {
    const remote = createRemote(candidate);
    await observe(
      publishRelease(candidate.input, { runCommand: remote.runCommand }),
    );
    assert.equal(remote.state.release, 'public');
    assert.equal(remote.state.packageIntegrity, candidate.packageIntegrity);
    assert.equal(
      remote.state.packageIntegrities['@gx-capture/capture-contracts'],
      candidate.packageIntegrities['@gx-capture/capture-contracts'],
    );
    assert.deepEqual(
      [...remote.assets.keys()].sort(),
      candidate.assets.map((path) => basename(path)).sort(),
    );
    const mutationCalls = mutations(remote.calls);
    assert.deepEqual(mutationCalls[0].slice(0, 3), ['gh', 'release', 'create']);
    assert.deepEqual(mutationCalls.at(-1).slice(0, 3), [
      'gh',
      'release',
      'edit',
    ]);
    const createIndex = remote.calls.findIndex(
      ([command, group, operation]) =>
        command === 'gh' && group === 'release' && operation === 'create',
    );
    const createCall = remote.calls[createIndex];
    const releaseNotes = createCall[createCall.indexOf('--notes') + 1];
    assert.ok(createCall.includes('--generate-notes'));
    assert.match(releaseNotes, /unsigned feasibility release/u);
    assert.match(releaseNotes, /Unknown publisher or SmartScreen/u);
    assert.match(releaseNotes, /SHA-256/u);
    assert.match(
      releaseNotes,
      /@gx-capture\/capture-workbench@0\.3\.9.*GitHub Packages.*never a GitHub Release asset/su,
    );
    const firstUploadIndex = remote.calls.findIndex(
      ([command, group, operation]) =>
        command === 'gh' && group === 'release' && operation === 'upload',
    );
    const packagePublishIndex = remote.calls.findIndex(
      ([command, operation]) => command === 'npm' && operation === 'publish',
    );
    const publicEditIndex = remote.calls.findIndex(
      ([command, group, operation]) =>
        command === 'gh' && group === 'release' && operation === 'edit',
    );
    assert.ok(createIndex < firstUploadIndex);
    assert.ok(firstUploadIndex < packagePublishIndex);
    assert.ok(packagePublishIndex < publicEditIndex);
    assert.equal(
      remote.calls.filter(
        ([command, operation]) => command === 'npm' && operation === 'publish',
      ).length,
      2,
    );
    assert.equal(
      remote.calls
        .slice(createIndex + 1, firstUploadIndex)
        .some(
          ([command, group, operation]) =>
            command === 'gh' && group === 'release' && operation === 'download',
        ),
      false,
    );
    assert.equal(
      mutationCalls.filter(
        ([command, group, operation]) =>
          command === 'gh' && group === 'release' && operation === 'upload',
      ).length,
      candidate.assets.length,
    );
    assert.equal(
      remote.calls.some(
        ([command, group, operation, , , flag]) =>
          command === 'gh' &&
          group === 'release' &&
          operation === 'upload' &&
          flag === '--clobber',
      ),
      false,
    );
    assert.equal(
      remote.calls.filter(
        ([command, group, operation]) =>
          command === 'gh' && group === 'release' && operation === 'download',
      ).length,
      candidate.assets.length * 2,
    );
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
      assets: candidate.assets.slice(0, -1),
    });
    await observe(
      publishRelease(candidate.input, { runCommand: remote.runCommand }),
    );
    const uploads = remote.calls.filter(
      ([command, group, operation]) =>
        command === 'gh' && group === 'release' && operation === 'upload',
    );
    assert.equal(uploads.length, 1);
    assert.equal(
      basename(uploads[0][4]),
      basename(candidate.input.installerPath),
    );
    const installerName = basename(candidate.input.installerPath);
    const installerUploadIndex = remote.calls.findIndex(
      ([command, group, operation, , path]) =>
        command === 'gh' &&
        group === 'release' &&
        operation === 'upload' &&
        basename(path) === installerName,
    );
    assert.equal(
      remote.calls
        .slice(0, installerUploadIndex)
        .some(
          ([command, group, operation, , flag, name]) =>
            command === 'gh' &&
            group === 'release' &&
            operation === 'download' &&
            flag === '--pattern' &&
            name === installerName,
        ),
      false,
    );
    assert.equal(
      remote.calls.filter(
        ([command, group, operation, , flag, name]) =>
          command === 'gh' &&
          group === 'release' &&
          operation === 'download' &&
          flag === '--pattern' &&
          name === installerName,
      ).length,
      2,
    );
    assert.equal(
      remote.calls.some(
        ([command, operation]) => command === 'npm' && operation === 'publish',
      ),
      false,
    );
    assert.equal(remote.state.release, 'public');
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
      assets: candidate.assets.slice(0, -1),
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

test('draft retries reject extra or duplicate remote asset names before mutation', async () => {
  const candidate = createCandidate();
  try {
    for (const reportedAssetNames of [
      [
        ...candidate.assets.map((path) => basename(path)),
        'unexpected-remote.bin',
      ],
      [
        ...candidate.assets.map((path) => basename(path)),
        basename(candidate.assets[0]),
      ],
    ]) {
      const remote = createRemote(candidate, {
        release: 'draft',
        packageIntegrity: candidate.packageIntegrity,
        assets: candidate.assets,
        reportedAssetNames,
      });
      await assert.rejects(
        observe(
          publishRelease(candidate.input, { runCommand: remote.runCommand }),
        ),
        /unexpected remote assets|duplicate (remote asset names|asset basenames)/u,
      );
      assert.deepEqual(mutations(remote.calls), []);
    }
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('draft retries reject an existing asset with different bytes before mutation', async () => {
  const candidate = createCandidate();
  try {
    const remote = createRemote(candidate, {
      release: 'draft',
      assets: candidate.assets,
    });
    remote.assets.set(runtimeAssetNames[0], Buffer.from('different'));

    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /differs/u,
    );
    assert.deepEqual(mutations(remote.calls), []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('space-bearing candidate assets are rejected before the first GitHub mutation', async () => {
  const candidate = createCandidate();
  try {
    const unstableInstallerPath = join(
      candidate.root,
      `Capture Workbench_${version}_x64-setup.exe`,
    );
    writeFileSync(unstableInstallerPath, 'installer bytes');
    candidate.input.installerPath = unstableInstallerPath;
    const reportPath = join(
      candidate.input.runtimeDirectory,
      runtimeSizeReportName,
    );
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.nsisInstaller.path = unstableInstallerPath;
    report.nsisInstaller.fileName = basename(unstableInstallerPath);
    writeCandidateSizeReport(candidate, report);
    const remote = createRemote(candidate);

    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /GitHub-unstable asset basenames/u,
    );
    assert.deepEqual(mutations(remote.calls), []);
    assert.equal(
      remote.calls.some(([command]) => command === 'gh'),
      false,
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('public retries reject an extra remote asset and stay read-only', async () => {
  const candidate = createCandidate();
  try {
    const remote = createRemote(candidate, {
      release: 'public',
      packageIntegrity: candidate.packageIntegrity,
      assets: candidate.assets,
      reportedAssetNames: [
        ...candidate.assets.map((path) => basename(path)),
        'unexpected-remote.bin',
      ],
    });
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /unexpected remote assets/u,
    );
    assert.deepEqual(mutations(remote.calls), []);
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

    writeFileSync(
      join(candidate.input.runtimeDirectory, 'unexpected.txt'),
      'x',
    );
    const invalid = createRemote(candidate);
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: invalid.runCommand }),
      ),
      /only .*canonical assets/u,
    );
    assert.deepEqual(invalid.calls, []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('size report must identify the exact installer before publication', async () => {
  const candidate = createCandidate();
  try {
    const reportPath = join(
      candidate.input.runtimeDirectory,
      runtimeSizeReportName,
    );
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.nsisInstaller.fileName = 'other-installer.exe';
    writeCandidateSizeReport(candidate, report);
    const remote = createRemote(candidate);

    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /size report does not match the exact release candidate/u,
    );
    assert.deepEqual(remote.calls, []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('size report must identify the exact runtime filename before publication', async () => {
  const candidate = createCandidate();
  try {
    const reportPath = join(
      candidate.input.runtimeDirectory,
      runtimeSizeReportName,
    );
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.runtimeExecutable.path = join(
      dirname(report.runtimeExecutable.path),
      'capture-runtime.exe',
    );
    report.runtimeExecutable.fileName = 'capture-runtime.exe';
    writeCandidateSizeReport(candidate, report);
    const remote = createRemote(candidate);

    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /size report does not match the exact release candidate/u,
    );
    assert.deepEqual(remote.calls, []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('publisher rejects noncanonical size report v2 before mutation', async () => {
  for (const mutate of [
    (report) => (report.reportVersion = '1'),
    (report) => (report.startup = { blocker: null }),
    (report) => delete report.runtimeExecutable.sha256,
  ]) {
    const candidate = createCandidate();
    try {
      const reportPath = join(
        candidate.input.runtimeDirectory,
        runtimeSizeReportName,
      );
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      mutate(report);
      writeCandidateSizeReport(candidate, report);
      const remote = createRemote(candidate);

      await assert.rejects(
        observe(
          publishRelease(candidate.input, { runCommand: remote.runCommand }),
        ),
        /size report does not match the exact release candidate/u,
      );
      assert.deepEqual(remote.calls, []);
    } finally {
      rmSync(candidate.root, { recursive: true, force: true });
    }
  }
});

test('model ZIPs are rejected from the local release asset set', async () => {
  const candidate = createCandidate();
  try {
    writeFileSync(
      join(
        candidate.input.runtimeDirectory,
        'capture-model-whisper-primary-0.3.9.zip',
      ),
      'forbidden model archive',
    );
    const remote = createRemote(candidate);
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /only .*canonical assets/u,
    );
    assert.deepEqual(remote.calls, []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('core-only publication accepts only core assets and excludes QA fixtures', async () => {
  const candidate = createCandidate();
  try {
    makeCoreOnly(candidate);
    const remote = createRemote(candidate);
    await observe(
      publishRelease(candidate.input, { runCommand: remote.runCommand }),
    );
    assert.equal(remote.state.release, 'public');
    assert.deepEqual(
      [...remote.assets.keys()].sort(),
      [
        ...runtimeAssetNames,
        engineCatalogName,
        `${engineCatalogName}.sha256`,
        runtimeSizeReportName,
        `${runtimeSizeReportName}.sha256`,
        basename(candidate.input.installerPath),
      ].sort(),
    );
    assert.equal(remote.assets.size, 9);
    assert.ok(
      [...remote.assets.keys()].every((name) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(name),
      ),
    );
    assert.deepEqual(
      remote.calls
        .filter(
          ([command, group, operation]) =>
            command === 'gh' && group === 'release' && operation === 'upload',
        )
        .map(([, , , , path]) => basename(path))
        .sort(),
      [...remote.assets.keys()].sort(),
    );
    assert.ok(
      [...remote.assets.keys()].every(
        (name) =>
          !name.startsWith('capture-engine-ocr') &&
          !name.startsWith('capture-engine-whisper') &&
          !name.startsWith('capture-model-') &&
          !name.includes('fixture'),
      ),
    );

    writeFileSync(
      join(candidate.input.runtimeDirectory, 'real-ocr-fixture.png'),
      'qa-only',
    );
    const invalid = createRemote(candidate);
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: invalid.runCommand }),
      ),
      /only .*canonical assets/u,
    );
    assert.deepEqual(invalid.calls, []);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test('malformed or partial catalog requirements never select core-only', async () => {
  for (const payload of [
    { catalogVersion: '2', runtimeVersion: version },
    { catalogVersion: '2', requirements: null, runtimeVersion: version },
    {
      catalogVersion: '2',
      requirements: [{ requirementId: 'windowsml-ocr' }],
      runtimeVersion: version,
    },
    {
      catalogVersion: '2',
      requirements: [],
      runtimeVersion: version,
      unexpected: true,
    },
  ]) {
    const candidate = createCandidate();
    try {
      makeCoreOnly(candidate);
      writeCandidateCatalog(candidate, payload);
      const remote = createRemote(candidate);
      await assert.rejects(
        observe(
          publishRelease(candidate.input, { runCommand: remote.runCommand }),
        ),
        /catalog identity, version, or requirement set is invalid/u,
      );
      assert.deepEqual(remote.calls, []);
    } finally {
      rmSync(candidate.root, { recursive: true, force: true });
    }
  }
});

test('worker archive names cannot escape or alias the release directory', async () => {
  const candidate = createCandidate();
  try {
    const catalogPath = join(
      candidate.input.runtimeDirectory,
      engineCatalogName,
    );
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    catalog.requirements[0].artifacts[0].fileName = '../escape.zip';
    writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
    const remote = createRemote(candidate);
    await assert.rejects(
      observe(
        publishRelease(candidate.input, { runCommand: remote.runCommand }),
      ),
      /artifact descriptor is invalid/u,
    );
    assert.deepEqual(remote.calls, []);
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
  for (const fail of [`upload:${runtimeAssetNames[0]}`, 'publish']) {
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
            command === 'gh' && group === 'release' && operation === 'edit',
        ),
        false,
      );
    } finally {
      rmSync(candidate.root, { recursive: true, force: true });
    }
  }
});

test('draft retry byte-compares existing matching assets without replacing bytes', async () => {
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
    const retryStart = remote.calls.length;
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
    const retryCalls = remote.calls.slice(retryStart);
    assert.equal(
      retryCalls.filter(
        ([command, group, operation]) =>
          command === 'gh' && group === 'release' && operation === 'download',
      ).length,
      candidate.assets.length * 3,
    );
    assert.equal(
      retryCalls.some(
        ([command, group, operation]) =>
          command === 'gh' && group === 'release' && operation === 'upload',
      ),
      false,
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});
