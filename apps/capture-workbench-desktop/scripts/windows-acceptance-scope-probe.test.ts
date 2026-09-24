import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWindowsAcceptanceScopeProbe,
  type WindowsAcceptanceScopeProbeAdapter,
  type WindowsAcceptanceScopeProbeSpawnOptions,
  type WindowsAcceptanceScopeProbeSpawnResult,
} from './windows-acceptance-scope-probe.ts';

const ROOT = 'C:\\Windows';
const BUILT_IN_SHELL = `${ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const ATTACKER_SHELL = 'C:\\attacker\\PowerShell\\7\\pwsh.exe';
const WINDOWS_DATE_MILLISECONDS = 1_788_037_350_802;
const WINDOWS_DATE_ISO = new Date(WINDOWS_DATE_MILLISECONDS).toISOString();

const validRootRow = {
  ProcessId: 100,
  ParentProcessId: 1,
  Name: 'node.exe',
  ExecutablePath: 'C:\\Windows\\System32\\node.exe',
  CreationDate: '2026-08-30T00:00:00.000Z',
};

function validPayload(
  overrides: {
    readonly processes?: readonly unknown[];
    readonly listeners?: readonly unknown[];
  } = {},
): Record<string, unknown> {
  return {
    processes: overrides.processes ?? [validRootRow],
    listeners: overrides.listeners ?? [],
  };
}

interface FixtureOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly expectedRootPid?: number;
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
  readonly spawnSync?: (
    command: string,
    args: readonly string[],
    options: WindowsAcceptanceScopeProbeSpawnOptions,
  ) => WindowsAcceptanceScopeProbeSpawnResult;
}

function fixture(
  options: FixtureOptions = {},
): WindowsAcceptanceScopeProbeAdapter {
  const directories = new Set([
    ROOT,
    `${ROOT}\\System32`,
    `${ROOT}\\System32\\WindowsPowerShell`,
    `${ROOT}\\System32\\WindowsPowerShell\\v1.0`,
    'C:\\OtherWindows',
  ]);
  const files = new Set([BUILT_IN_SHELL, ATTACKER_SHELL]);
  const environment = options.environment ?? {
    Path: 'C:\\Windows\\System32',
    SystemRoot: ROOT,
  };
  return {
    platform: 'win32',
    expectedRootPid: options.expectedRootPid ?? 100,
    environment,
    files: {
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
    },
    spawnSync: (command, args, spawnOptions) => {
      if (options.spawnSync) {
        return options.spawnSync(command, args, spawnOptions);
      }
      return {
        status: 0,
        stdout: JSON.stringify(validPayload()),
      };
    },
  };
}

async function assertUnavailable(
  probe: ReturnType<typeof createWindowsAcceptanceScopeProbe>,
): Promise<void> {
  await assert.rejects(
    probe.snapshot(),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'capture_acceptance_scope_probe_unavailable',
  );
}

test('uses only the verified built-in shell when PATH and ProgramFiles are attacker-controlled', async () => {
  const calls: string[] = [];
  const probe = createWindowsAcceptanceScopeProbe({
    adapter: fixture({
      environment: {
        Path: 'C:\\attacker\\bin',
        ProgramFiles: 'C:\\attacker',
        CAPTURE_POWERSHELL: ATTACKER_SHELL,
        SystemRoot: ROOT,
      },
      spawnSync: (command, args, options) => {
        calls.push(command);
        assert.equal(options.shell, false);
        assert.deepEqual(args.slice(0, 3), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
        ]);
        return { status: 0, stdout: JSON.stringify(validPayload()) };
      },
    }),
  });

  const snapshot = await probe.snapshot();
  assert.equal(snapshot.processes[0]?.pid, 100);
  assert.deepEqual(calls, [BUILT_IN_SHELL]);
  assert.equal(calls.includes(ATTACKER_SHELL), false);
});

test('accepts either trusted OS root spelling and requires equal canonical roots', async () => {
  for (const environment of [
    { WINDIR: ROOT },
    { SystemRoot: ROOT, WINDIR: ROOT },
  ]) {
    const probe = createWindowsAcceptanceScopeProbe({
      adapter: fixture({ environment }),
    });
    assert.equal((await probe.snapshot()).processes[0]?.pid, 100);
  }
});

test('canonicalizes PowerShell date wrappers for root, baseline, and listener-owner identities', async () => {
  const probe = createWindowsAcceptanceScopeProbe({
    adapter: fixture({
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify(
          validPayload({
            processes: [
              {
                ...validRootRow,
                CreationDate: `/Date(${WINDOWS_DATE_MILLISECONDS})/`,
              },
              {
                ProcessId: 200,
                ParentProcessId: 1,
                Name: 'baseline.exe',
                ExecutablePath: 'C:\\Windows\\System32\\baseline.exe',
                CreationDate: `/Date(${WINDOWS_DATE_MILLISECONDS + 1_000})/`,
              },
              {
                ProcessId: 300,
                ParentProcessId: 100,
                Name: 'listener-owner.exe',
                ExecutablePath: 'C:\\Windows\\System32\\listener-owner.exe',
                CreationDate: `/Date(${WINDOWS_DATE_MILLISECONDS + 2_000})/`,
              },
            ],
            listeners: [
              {
                LocalAddress: '127.0.0.1',
                LocalPort: 45_001,
                OwningProcess: 300,
              },
            ],
          }),
        ),
      }),
    }),
  });

  const snapshot = await probe.snapshot();
  assert.deepEqual(
    snapshot.processes.map(({ pid, creationTimeUtc }) => [
      pid,
      creationTimeUtc,
    ]),
    [
      [100, WINDOWS_DATE_ISO],
      [200, new Date(WINDOWS_DATE_MILLISECONDS + 1_000).toISOString()],
      [300, new Date(WINDOWS_DATE_MILLISECONDS + 2_000).toISOString()],
    ],
  );
  assert.deepEqual(snapshot.listeners, [
    {
      host: '127.0.0.1',
      port: 45_001,
      protocol: 'tcp',
      owningPid: 300,
    },
  ]);
});

test('preserves the existing canonical ISO and DMTF identity forms', async () => {
  const dmtfCreation = '20260830000000.000000+000';
  const probe = createWindowsAcceptanceScopeProbe({
    adapter: fixture({
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify(
          validPayload({
            processes: [
              validRootRow,
              {
                ProcessId: 200,
                ParentProcessId: 1,
                Name: 'dmtf-process.exe',
                ExecutablePath: 'C:\\Windows\\System32\\dmtf-process.exe',
                CreationDate: dmtfCreation,
              },
            ],
          }),
        ),
      }),
    }),
  });

  const snapshot = await probe.snapshot();
  assert.equal(snapshot.processes[0]?.creationTimeUtc, validRootRow.CreationDate);
  assert.equal(snapshot.processes[1]?.creationTimeUtc, dmtfCreation);
});

test('fails closed when the built-in trusted root is missing, unsafe, or disagrees', async () => {
  const cases: readonly FixtureOptions[] = [
    { environment: { Path: 'C:\\Windows\\System32' } },
    { environment: { SystemRoot: 'relative-root' } },
    { environment: { SystemRoot: `${ROOT}\0unsafe` } },
    { environment: { SystemRoot: `${ROOT}\runsafe` } },
    {
      environment: { SystemRoot: ROOT, WINDIR: 'C:\\OtherWindows' },
    },
    {
      environment: { SystemRoot: ROOT },
      statOverrides: new Map([[ROOT, { symbolicLink: true }]]),
    },
    {
      environment: { SystemRoot: ROOT },
      realpathOverrides: new Map([[ROOT, `${ROOT}\\System32`]]),
    },
  ];

  for (const options of cases) {
    const calls: string[] = [];
    const probe = createWindowsAcceptanceScopeProbe({
      adapter: fixture({
        ...options,
        spawnSync: (command) => {
          calls.push(command);
          return { status: 0, stdout: JSON.stringify(validPayload()) };
        },
      }),
    });
    await assertUnavailable(probe);
    assert.deepEqual(calls, []);
  }
});

test('rejects missing, non-regular, linked, or escaped built-in candidates before spawn', async () => {
  const cases: readonly FixtureOptions[] = [
    { missingPaths: new Set([BUILT_IN_SHELL]) },
    {
      statOverrides: new Map([[BUILT_IN_SHELL, { file: false }]]),
    },
    {
      statOverrides: new Map([[BUILT_IN_SHELL, { symbolicLink: true }]]),
    },
    {
      statOverrides: new Map([[BUILT_IN_SHELL, { reparsePoint: true }]]),
    },
    {
      statOverrides: new Map([[`${ROOT}\\System32`, { reparsePoint: true }]]),
    },
    {
      realpathOverrides: new Map([
        [`${ROOT}\\System32`, 'C:\\attacker\\System32'],
      ]),
    },
    {
      realpathOverrides: new Map([
        [BUILT_IN_SHELL, 'C:\\attacker\\powershell.exe'],
      ]),
    },
  ];

  for (const options of cases) {
    let spawnCount = 0;
    const probe = createWindowsAcceptanceScopeProbe({
      adapter: fixture({
        ...options,
        spawnSync: () => {
          spawnCount += 1;
          return { status: 0, stdout: JSON.stringify(validPayload()) };
        },
      }),
    });
    await assertUnavailable(probe);
    assert.equal(spawnCount, 0);
  }
});

test('requires explicit arrays, a valid root identity, and zero-loss listener integrity', async () => {
  const malformedPayloads: readonly unknown[] = [
    {},
    { processes: [], listeners: [] },
    {
      processes: [{ ...validRootRow, ExecutablePath: undefined }],
      listeners: [],
    },
    {
      processes: [validRootRow],
      listeners: [{ LocalAddress: '127.0.0.1', LocalPort: 45_001 }],
    },
    {
      processes: [validRootRow],
      listeners: [{ LocalAddress: '0.0.0.0', LocalPort: 45_001 }],
    },
  ];

  for (const payload of malformedPayloads) {
    const probe = createWindowsAcceptanceScopeProbe({
      adapter: fixture({
        spawnSync: () => ({ status: 0, stdout: JSON.stringify(payload) }),
      }),
    });
    await assertUnavailable(probe);
  }

  const validWithProtectedRow = createWindowsAcceptanceScopeProbe({
    adapter: fixture({
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify(
          validPayload({
            processes: [
              validRootRow,
              {
                ProcessId: 999,
                Name: 'protected',
                CreationDate: validRootRow.CreationDate,
              },
            ],
          }),
        ),
      }),
    }),
  });
  const snapshot = await validWithProtectedRow.snapshot();
  assert.deepEqual(snapshot.listeners, []);
  assert.deepEqual(
    snapshot.processes.map(({ pid }) => pid),
    [100],
  );
});

test('fails closed for malformed Windows date wrappers, including non-root rows', async () => {
  const malformedCreationDates = [
    '/Date(x)/',
    `Date(${WINDOWS_DATE_MILLISECONDS})/`,
    `/Date(${WINDOWS_DATE_MILLISECONDS})`,
    `/Date(${WINDOWS_DATE_MILLISECONDS})/extra`,
    `/Date(1e3)/`,
    '/Date(-1)/',
    '/Date(9007199254740992)/',
    '/Date(8640000000000001)/',
    `/Date(${WINDOWS_DATE_MILLISECONDS}+0800)/`,
    undefined,
  ] as const;

  for (const creationDate of malformedCreationDates) {
    const payloads = [
      validPayload({
        processes: [{ ...validRootRow, CreationDate: creationDate }],
      }),
      validPayload({
        processes: [
          validRootRow,
          {
            ...validRootRow,
            ProcessId: 999,
            ParentProcessId: 1,
            CreationDate: creationDate,
          },
        ],
      }),
    ];
    for (const payload of payloads) {
      const probe = createWindowsAcceptanceScopeProbe({
        adapter: fixture({
          spawnSync: () => ({ status: 0, stdout: JSON.stringify(payload) }),
        }),
      });
      await assertUnavailable(probe);
    }
  }
});

test('uses the injected root PID only as a test seam and keeps probe failures stable', async () => {
  const rootPid = 321;
  const probe = createWindowsAcceptanceScopeProbe({
    adapter: fixture({
      expectedRootPid: rootPid,
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify({
          processes: [{ ...validRootRow, ProcessId: rootPid }],
          listeners: [],
        }),
      }),
    }),
  });
  assert.equal((await probe.snapshot()).processes[0]?.pid, rootPid);

  const failures: readonly WindowsAcceptanceScopeProbeSpawnResult[] = [
    { status: 0, stdout: '{not-json' },
    { status: 7, stdout: '{}' },
    { status: null, error: new Error('spawn failed') },
  ];
  for (const failure of failures) {
    const failureProbe = createWindowsAcceptanceScopeProbe({
      adapter: fixture({ spawnSync: () => failure }),
    });
    await assertUnavailable(failureProbe);
  }
});
