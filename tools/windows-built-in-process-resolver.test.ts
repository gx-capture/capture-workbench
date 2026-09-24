import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveWindowsBuiltInPowerShell,
  type WindowsBuiltInProcessFileAdapter,
} from './windows-built-in-process-resolver.ts';
import {
  createAcceptanceProcessStateProbe,
  type AcceptanceProcessIdentity,
} from './three-project-acceptance.ts';

const ROOT = 'C:\\Windows';
const BUILT_IN_SHELL = `${ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const ATTACKER_SHELL = 'C:\\attacker\\PowerShell\\7\\pwsh.exe';

interface FixtureOptions {
  readonly missingPaths?: ReadonlySet<string>;
  readonly statOverrides?: ReadonlyMap<
    string,
    {
      readonly directory?: boolean;
      readonly file?: boolean;
      readonly symbolicLink?: boolean;
      readonly reparsePoint?: boolean;
    }
  >;
  readonly realpathOverrides?: ReadonlyMap<string, string>;
}

function fixture(options: FixtureOptions = {}): WindowsBuiltInProcessFileAdapter {
  const directories = new Set([
    ROOT,
    `${ROOT}\\System32`,
    `${ROOT}\\System32\\WindowsPowerShell`,
    `${ROOT}\\System32\\WindowsPowerShell\\v1.0`,
  ]);
  const files = new Set([BUILT_IN_SHELL, ATTACKER_SHELL]);
  return {
    lstat: async (path: string) => {
      const override = options.statOverrides?.get(path);
      if (
        options.missingPaths?.has(path) ||
        (!override && !directories.has(path) && !files.has(path))
      ) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return {
        isDirectory: () => override?.directory ?? directories.has(path),
        isFile: () => override?.file ?? files.has(path),
        isSymbolicLink: () => override?.symbolicLink ?? false,
        isReparsePoint: () => override?.reparsePoint ?? false,
      };
    },
    realpath: async (path: string) =>
      options.realpathOverrides?.get(path) ?? path,
  };
}

const identity: AcceptanceProcessIdentity = {
  pid: 42,
  creationTimeUtc: '2026-08-30T00:00:00.000Z',
  executable: 'C:\\Windows\\System32\\node.exe',
};

test('resolves only the verified built-in PowerShell when PATH is incomplete', async () => {
  const resolved = await resolveWindowsBuiltInPowerShell(
    {
      Path: 'C:\\Windows\\System32',
      ProgramFiles: 'C:\\attacker',
      CAPTURE_POWERSHELL: ATTACKER_SHELL,
      SystemRoot: ROOT,
    },
    fixture(),
  );
  assert.equal(resolved, BUILT_IN_SHELL);
});

test('fails closed for missing trusted root, unsafe binary, and path-bearing filesystem errors', async () => {
  assert.equal(
    await resolveWindowsBuiltInPowerShell(
      { Path: 'C:\\Windows\\System32' },
      fixture(),
    ),
    undefined,
  );
  assert.equal(
    await resolveWindowsBuiltInPowerShell(
      { SystemRoot: ROOT },
      fixture({ statOverrides: new Map([[BUILT_IN_SHELL, { reparsePoint: true }]]) }),
    ),
    undefined,
  );
  const pathLeakingFiles: WindowsBuiltInProcessFileAdapter = {
    lstat: async (path) => {
      throw new Error(`secret path ${path}`);
    },
    realpath: async (path) => path,
  };
  await assert.doesNotReject(
    resolveWindowsBuiltInPowerShell({ SystemRoot: ROOT }, pathLeakingFiles),
  );
  assert.equal(
    await resolveWindowsBuiltInPowerShell({ SystemRoot: ROOT }, pathLeakingFiles),
    undefined,
  );
});

test('parent process probe uses the absolute resolver, shell false, and preserves identity semantics', async () => {
  const calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly shell: false;
  }> = [];
  const probe = createAcceptanceProcessStateProbe({
    platform: 'win32',
    environment: { Path: 'C:\\Windows\\System32', SystemRoot: ROOT },
    files: fixture(),
    spawnSync: (command, args, options) => {
      calls.push({ command, args, shell: options.shell });
      return {
        status: 0,
        stdout: JSON.stringify({
          present: true,
          executable: identity.executable,
          creation: identity.creationTimeUtc,
        }),
      };
    },
  });

  assert.equal(await probe(identity), 'present');
  assert.deepEqual(calls.map(({ command }) => command), [BUILT_IN_SHELL]);
  assert.equal(calls[0]?.shell, false);
  assert.doesNotMatch(calls[0]?.args.join(' ') ?? '', /CAPTURE_POWERSHELL|attacker/iu);

  const mismatchProbe = createAcceptanceProcessStateProbe({
    platform: 'win32',
    environment: { SystemRoot: ROOT },
    files: fixture(),
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        present: true,
        executable: 'C:\\Windows\\System32\\other.exe',
        creation: '2026-08-30T00:00:03.000Z',
      }),
    }),
  });
  assert.equal(await mismatchProbe(identity), 'absent');

  const absentProbe = createAcceptanceProcessStateProbe({
    platform: 'win32',
    environment: { SystemRoot: ROOT },
    files: fixture(),
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({ present: false }),
    }),
  });
  assert.equal(await absentProbe(identity), 'absent');
});

test('parent process probe returns unknown without spawning on resolver failure or invalid PID', async () => {
  let spawnCount = 0;
  const probe = createAcceptanceProcessStateProbe({
    platform: 'win32',
    environment: { Path: 'C:\\Windows\\System32' },
    files: fixture(),
    spawnSync: () => {
      spawnCount += 1;
      return { status: 0, stdout: '{}' };
    },
  });
  assert.equal(await probe(identity), 'unknown');
  assert.equal(spawnCount, 0);

  const injectionProbe = createAcceptanceProcessStateProbe({
    platform: 'win32',
    environment: { SystemRoot: ROOT },
    files: fixture(),
    spawnSync: () => {
      spawnCount += 1;
      return { status: 0, stdout: '{}' };
    },
  });
  assert.equal(
    await injectionProbe({
      ...identity,
      pid: '42; Write-Output injected' as unknown as number,
    }),
    'unknown',
  );
  assert.equal(spawnCount, 0);
});
