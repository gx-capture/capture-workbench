import { spawnSync } from 'node:child_process';
// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance scope is a workspace-level evidence contract.
import type { AcceptanceProcessIdentity } from '../../../tools/three-project-acceptance.ts';
// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance scope is a workspace-level evidence contract.
import {
  resolveWindowsBuiltInPowerShell,
  type WindowsBuiltInProcessFileAdapter,
  type WindowsBuiltInProcessFileStat,
} from '../../../tools/windows-built-in-process-resolver.ts';

/**
 * Windows acceptance-harness observation. The production adapter is the
 * process environment supplied by the OS acceptance parent, never app input.
 * Tests may replace the whole adapter; ordinary callers should use the
 * zero-argument factory and must not supply an arbitrary shell path.
 */
export interface AcceptanceScopeProcessObservation
  extends AcceptanceProcessIdentity {
  readonly parentPid?: number;
  readonly name: string;
  readonly commandLine?: string;
}

export interface AcceptanceScopeListenerObservation {
  readonly host: string;
  readonly port: number;
  readonly protocol: 'tcp';
  readonly owningPid: number;
}

export interface AcceptanceScopeSnapshot {
  readonly processes: readonly AcceptanceScopeProcessObservation[];
  readonly listeners: readonly AcceptanceScopeListenerObservation[];
}

export interface AcceptanceScopeProbe {
  snapshot(): Promise<AcceptanceScopeSnapshot>;
}

export type WindowsAcceptanceScopeProbeFileStat = WindowsBuiltInProcessFileStat;
export type WindowsAcceptanceScopeProbeFileAdapter =
  WindowsBuiltInProcessFileAdapter;

export interface WindowsAcceptanceScopeProbeSpawnResult {
  readonly status: number | null;
  readonly stdout?: string | Buffer;
  readonly error?: unknown;
}

export interface WindowsAcceptanceScopeProbeSpawnOptions {
  readonly encoding: 'utf8';
  readonly shell: false;
  readonly windowsHide: true;
}

export interface WindowsAcceptanceScopeProbeAdapter {
  readonly platform?: NodeJS.Platform;
  readonly expectedRootPid?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly files?: Partial<WindowsAcceptanceScopeProbeFileAdapter>;
  readonly spawnSync?: (
    command: string,
    args: readonly string[],
    options: WindowsAcceptanceScopeProbeSpawnOptions,
  ) => WindowsAcceptanceScopeProbeSpawnResult;
}

export interface WindowsAcceptanceScopeProbeOptions {
  /**
   * Controlled adapter seam for tests; production callers must omit it. The
   * zero-argument factory reads only process.env's SystemRoot/WINDIR values,
   * which are the trusted parent/OS acceptance-harness boundary, not app or
   * user input. No caller-provided shell path is accepted.
   */
  readonly adapter?: Partial<WindowsAcceptanceScopeProbeAdapter>;
}

const WINDOWS_SCOPE_PROBE_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
] as const;
const WINDOWS_SCOPE_PROBE_SCRIPT = [
  '$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate, CommandLine)',
  '$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess)',
  '[ordered]@{ processes = @($processes); listeners = @($listeners) } | ConvertTo-Json -Compress -Depth 4',
].join('; ');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const DMTF_CREATION_PATTERN = /^\d{8,20}(?:\.\d+)?[+-]\d{3,4}$/u;
const ISO_CREATION_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/u;
const WINDOWS_DATE_CREATION_PATTERN = /^\/Date\(([0-9]+)\)\/$/u;

const defaultAdapter: Required<
  Pick<
    WindowsAcceptanceScopeProbeAdapter,
    'platform' | 'expectedRootPid' | 'environment' | 'spawnSync'
  >
> = {
  platform: process.platform,
  expectedRootPid: process.pid,
  environment: process.env,
  spawnSync: (command, args, options) =>
    spawnSync(command, args, options) as WindowsAcceptanceScopeProbeSpawnResult,
};

type ResolvedWindowsAcceptanceScopeProbeAdapter = typeof defaultAdapter & {
  readonly files: Partial<WindowsAcceptanceScopeProbeFileAdapter>;
};

function mergeAdapter(
  adapter: Partial<WindowsAcceptanceScopeProbeAdapter> | undefined,
): ResolvedWindowsAcceptanceScopeProbeAdapter {
  return {
    ...defaultAdapter,
    platform: adapter?.platform ?? defaultAdapter.platform,
    expectedRootPid: adapter?.expectedRootPid ?? defaultAdapter.expectedRootPid,
    environment: adapter?.environment ?? defaultAdapter.environment,
    spawnSync: adapter?.spawnSync ?? defaultAdapter.spawnSync,
    files: adapter?.files ?? {},
  };
}

function asPositivePid(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

function isAbsoluteExecutable(value: string): boolean {
  const normalized = value.trim().replaceAll('\\', '/').toLowerCase();
  return Boolean(normalized) && /^(?:[a-z]:\/|\/|\/\/)/u.test(normalized);
}

function isLoopbackHost(value: string): boolean {
  return LOOPBACK_HOSTS.has(value.trim().toLowerCase());
}

function canonicalCreationTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();

  const windowsDate = WINDOWS_DATE_CREATION_PATTERN.exec(trimmed);
  if (windowsDate) {
    const milliseconds = Number(windowsDate[1]);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      return undefined;
    }
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) return undefined;
    try {
      return date.toISOString();
    } catch {
      return undefined;
    }
  }

  const iso = ISO_CREATION_PATTERN.exec(trimmed);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const hour = Number(iso[4]);
    const minute = Number(iso[5]);
    const second = Number(iso[6]);
    const milliseconds = Number(
      (iso[7] ?? '').slice(0, 3).padEnd(3, '0'),
    );
    const localDate = new Date(0);
    localDate.setUTCFullYear(year, month - 1, day);
    localDate.setUTCHours(hour, minute, second, milliseconds);
    if (
      localDate.getUTCFullYear() !== year ||
      localDate.getUTCMonth() !== month - 1 ||
      localDate.getUTCDate() !== day ||
      localDate.getUTCHours() !== hour ||
      localDate.getUTCMinutes() !== minute ||
      localDate.getUTCSeconds() !== second ||
      localDate.getUTCMilliseconds() !== milliseconds
    ) {
      return undefined;
    }
    const timezone = iso[8];
    if (!timezone) return undefined;
    let offsetMilliseconds = 0;
    if (timezone !== 'Z') {
      const sign = timezone[0] === '+' ? 1 : -1;
      const offsetHours = Number(timezone.slice(1, 3));
      const offsetMinutes = Number(
        timezone.slice(timezone[3] === ':' ? 4 : 3),
      );
      offsetMilliseconds =
        sign * (offsetHours * 60 + offsetMinutes) * 60 * 1_000;
    }
    const canonical = new Date(localDate.getTime() - offsetMilliseconds);
    if (!Number.isFinite(canonical.getTime())) return undefined;
    try {
      return canonical.toISOString();
    } catch {
      return undefined;
    }
  }

  // Keep the pre-existing DMTF identity form supported by the downstream
  // acceptance contract; unlike ISO and /Date(...)/ it is already canonical
  // in the verifier's provider-independent representation.
  return DMTF_CREATION_PATTERN.test(trimmed) ? trimmed : undefined;
}

function isCanonicalCreationTime(value: unknown): value is string {
  return typeof value === 'string' && canonicalCreationTime(value) === value;
}

function invalidProbeSnapshot(): never {
  throw new Error('capture_acceptance_scope_probe_invalid');
}

function hasOwnArray(value: Record<string, unknown>, key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(value, key) &&
    Array.isArray(value[key])
  );
}

function parseProcessObservation(
  item: Record<string, unknown>,
): AcceptanceScopeProcessObservation | undefined {
  const pid = asPositivePid(item.ProcessId);
  const executable =
    typeof item.ExecutablePath === 'string' ? item.ExecutablePath.trim() : '';
  const creation = canonicalCreationTime(item.CreationDate);
  const name = typeof item.Name === 'string' ? item.Name.trim() : '';
  if (
    pid === undefined ||
    !executable ||
    !creation ||
    !name ||
    !isAbsoluteExecutable(executable)
  ) {
    return undefined;
  }
  return {
    pid,
    parentPid: asPositivePid(item.ParentProcessId),
    creationTimeUtc: creation,
    executable,
    name,
    commandLine:
      typeof item.CommandLine === 'string' ? item.CommandLine : undefined,
  };
}

function parseWindowsSnapshot(
  value: unknown,
  expectedRootPid: number,
): AcceptanceScopeSnapshot {
  if (
    !isRecord(value) ||
    !hasOwnArray(value, 'processes') ||
    !hasOwnArray(value, 'listeners')
  ) {
    return invalidProbeSnapshot();
  }
  const processValues = value.processes as unknown[];
  const listenerValues = value.listeners as unknown[];
  const processes: AcceptanceScopeProcessObservation[] = [];
  let rootFound = false;
  for (const item of processValues) {
    if (!isRecord(item)) continue;
    if (
      Object.prototype.hasOwnProperty.call(item, 'ProcessId') &&
      item.ProcessId !== undefined &&
      item.ProcessId !== null &&
      canonicalCreationTime(item.CreationDate) === undefined
    ) {
      return invalidProbeSnapshot();
    }
    const identity = parseProcessObservation(item);
    const pid = asPositivePid(item.ProcessId);
    if (pid === expectedRootPid) {
      if (!identity) return invalidProbeSnapshot();
      rootFound = true;
    }
    if (identity) processes.push(identity);
  }
  if (!rootFound) return invalidProbeSnapshot();

  const listeners: AcceptanceScopeListenerObservation[] = [];
  for (const item of listenerValues) {
    if (!isRecord(item)) return invalidProbeSnapshot();
    const host =
      typeof item.LocalAddress === 'string' ? item.LocalAddress.trim() : '';
    if (!host) return invalidProbeSnapshot();
    const port = asPositivePid(item.LocalPort);
    const owningPid = asPositivePid(item.OwningProcess);
    if (port === undefined || port > 65_535 || owningPid === undefined) {
      return invalidProbeSnapshot();
    }
    if (!isLoopbackHost(host)) continue;
    listeners.push({ host, port, protocol: 'tcp', owningPid });
  }
  return { processes, listeners };
}

function probeStdout(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

export function assertWindowsAcceptanceScopeSnapshot(
  value: unknown,
  expectedRootPid: number,
): asserts value is AcceptanceScopeSnapshot {
  if (
    !isRecord(value) ||
    !Array.isArray(value.processes) ||
    !Array.isArray(value.listeners) ||
    !value.processes.every(
      (item) =>
        isRecord(item) &&
        asPositivePid(item.pid) !== undefined &&
        typeof item.executable === 'string' &&
        isAbsoluteExecutable(item.executable) &&
        isCanonicalCreationTime(item.creationTimeUtc) &&
        typeof item.name === 'string' &&
        item.name.trim().length > 0,
    ) ||
    !value.listeners.every(
      (item) =>
        isRecord(item) &&
        typeof item.host === 'string' &&
        isLoopbackHost(item.host) &&
        item.protocol === 'tcp' &&
        asPositivePid(item.port) !== undefined &&
        Number(item.port) <= 65_535 &&
        asPositivePid(item.owningPid) !== undefined,
    )
  ) {
    return invalidProbeSnapshot();
  }
  const root = value.processes.find(
    (item) =>
      isRecord(item) &&
      asPositivePid(item.pid) === expectedRootPid &&
      typeof item.executable === 'string' &&
      isAbsoluteExecutable(item.executable) &&
      isCanonicalCreationTime(item.creationTimeUtc) &&
      typeof item.name === 'string' &&
      item.name.trim().length > 0,
  );
  if (!root) return invalidProbeSnapshot();
}

export function createWindowsAcceptanceScopeProbe(
  options: WindowsAcceptanceScopeProbeOptions = {},
): AcceptanceScopeProbe {
  const adapter = mergeAdapter(options.adapter);
  return {
    snapshot: async () => {
      if (adapter.platform !== 'win32') {
        throw new Error('capture_acceptance_scope_windows_only');
      }
      const executable = await resolveWindowsBuiltInPowerShell(
        adapter.environment,
        adapter.files,
      );
      if (!executable) {
        throw new Error('capture_acceptance_scope_probe_unavailable');
      }
      let result: WindowsAcceptanceScopeProbeSpawnResult;
      try {
        result = adapter.spawnSync(
          executable,
          [...WINDOWS_SCOPE_PROBE_ARGS, WINDOWS_SCOPE_PROBE_SCRIPT],
          {
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
          },
        );
      } catch {
        throw new Error('capture_acceptance_scope_probe_unavailable');
      }
      if (!result || result.error || result.status !== 0) {
        throw new Error('capture_acceptance_scope_probe_unavailable');
      }
      try {
        return parseWindowsSnapshot(
          JSON.parse(probeStdout(result.stdout)) as unknown,
          adapter.expectedRootPid,
        );
      } catch {
        throw new Error('capture_acceptance_scope_probe_unavailable');
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Compatibility aliases for callers of the original acceptance-scope seam. */
export type AcceptanceScopeProbeFileStat = WindowsAcceptanceScopeProbeFileStat;
export type AcceptanceScopeProbeFileAdapter =
  WindowsAcceptanceScopeProbeFileAdapter;
export type AcceptanceScopeProbeSpawnResult =
  WindowsAcceptanceScopeProbeSpawnResult;
export type AcceptanceScopeProbeSpawnOptions =
  WindowsAcceptanceScopeProbeSpawnOptions;
export type AcceptanceScopeProbeAdapter = WindowsAcceptanceScopeProbeAdapter;
export type AcceptanceScopeProbeOptions = WindowsAcceptanceScopeProbeOptions;
