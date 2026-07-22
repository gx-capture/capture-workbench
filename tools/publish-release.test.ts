import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  packagePublicationDecision,
  publishRelease,
  sha512Integrity,
} from './publish-release.ts';

const runtimeAssetNames = [
  'capture-runtime-x86_64-pc-windows-msvc.exe',
  'capture-runtime-x86_64-pc-windows-msvc.exe.sha256',
  'capture-runtime-manifest.json',
  'capture-document-v1.schema.json',
];

function success(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

function npmInspection(version, integrity) {
  return JSON.stringify([
    {
      name: '@gx/capture-angular',
      version,
      integrity,
    },
  ]);
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
  const directory = await mkdtemp(join(tmpdir(), 'capture-package-integrity-'));
  try {
    const path = join(directory, 'package.tgz');
    await writeFile(path, 'first', 'utf8');
    const first = await sha512Integrity(path);
    await writeFile(path, 'second', 'utf8');
    const second = await sha512Integrity(path);
    assert.match(first, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    assert.notEqual(first, second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('registry integrity conflict stops before every GitHub release mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capture-publish-conflict-'));
  try {
    const packagePath = join(directory, 'capture-angular-0.1.0.tgz');
    await writeFile(packagePath, 'local package bytes', 'utf8');
    const localIntegrity = await sha512Integrity(packagePath);
    const calls = [];
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'npm' && args[0] === 'pack') {
        return success(npmInspection('0.1.0', localIntegrity));
      }
      if (command === 'npm' && args[0] === 'view') {
        return success(JSON.stringify('sha512-conflicting'));
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    await assert.rejects(
      publishRelease(
        {
          tag: 'v0.1.0',
          version: '0.1.0',
          runtimeDirectory: join(directory, 'runtime-not-needed'),
          packagePath,
        },
        { runCommand },
      ),
      /integrity differs/u,
    );
    assert.equal(
      calls.filter(
        ([command, group, operation]) =>
          command === 'gh' &&
          group === 'release' &&
          ['create', 'upload', 'edit'].includes(operation),
      ).length,
      0,
    );
    assert.equal(
      calls.some(([command]) => command === 'gh'),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('exact existing package and public runtime remain mutation-free on retries', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'capture-publish-idempotent-'),
  );
  try {
    const runtimeDirectory = join(directory, 'runtime');
    const packagePath = join(directory, 'capture-angular-0.1.0.tgz');
    await mkdir(runtimeDirectory);
    await writeFile(packagePath, 'exact package bytes', 'utf8');
    await Promise.all(
      runtimeAssetNames.map((name) =>
        writeFile(join(runtimeDirectory, name), `asset:${name}`, 'utf8'),
      ),
    );
    const localIntegrity = await sha512Integrity(packagePath);
    const calls = [];
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'npm' && args[0] === 'pack') {
        return success(npmInspection('0.1.0', localIntegrity));
      }
      if (command === 'npm' && args[0] === 'view') {
        return success(JSON.stringify(localIntegrity));
      }
      if (command === 'gh' && args[0] === 'release' && args[1] === 'view') {
        return success(JSON.stringify({ isDraft: false }));
      }
      if (command === 'gh' && args[0] === 'release' && args[1] === 'download') {
        const pattern = args[args.indexOf('--pattern') + 1];
        const destination = args[args.indexOf('--dir') + 1];
        copyFileSync(
          join(runtimeDirectory, pattern),
          join(destination, pattern),
        );
        return success();
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };
    const input = {
      tag: 'v0.1.0',
      version: '0.1.0',
      runtimeDirectory,
      packagePath,
    };

    await publishRelease(input, { runCommand });
    await publishRelease(input, { runCommand });

    assert.equal(
      calls.filter(
        ([command, group, operation]) =>
          command === 'gh' &&
          group === 'release' &&
          ['create', 'upload', 'edit'].includes(operation),
      ).length,
      0,
    );
    assert.equal(
      calls.filter(
        ([command, operation]) => command === 'npm' && operation === 'publish',
      ).length,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
