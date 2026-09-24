import { randomUUID } from 'node:crypto';
import {
  mkdir as mkdirFs,
  open as openFs,
  readFile as readFileFs,
  rename as renameFs,
  unlink as unlinkFs,
  writeFile as writeFileFs,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  assertWindowsAcceptanceScopeSnapshot,
  createWindowsAcceptanceScopeProbe,
} from './windows-acceptance-scope-probe.ts';
import type {
  AcceptanceScopeListenerObservation,
  AcceptanceScopeProbe,
  AcceptanceScopeProcessObservation,
  AcceptanceScopeSnapshot,
} from './windows-acceptance-scope-probe.ts';

export type {
  AcceptanceScopeListenerObservation,
  AcceptanceScopeProbe,
  AcceptanceScopeProbeAdapter,
  AcceptanceScopeProbeFileAdapter,
  AcceptanceScopeProbeFileStat,
  AcceptanceScopeProbeOptions,
  AcceptanceScopeProcessObservation,
  AcceptanceScopeSnapshot,
  AcceptanceScopeProbeSpawnOptions,
  AcceptanceScopeProbeSpawnResult,
  WindowsAcceptanceScopeProbeAdapter,
  WindowsAcceptanceScopeProbeFileAdapter,
  WindowsAcceptanceScopeProbeFileStat,
  WindowsAcceptanceScopeProbeOptions,
  WindowsAcceptanceScopeProbeSpawnOptions,
  WindowsAcceptanceScopeProbeSpawnResult,
} from './windows-acceptance-scope-probe.ts';

export {
  assertWindowsAcceptanceScopeSnapshot,
  createWindowsAcceptanceScopeProbe,
};

// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance scope is a workspace-level evidence contract.
import {
  acceptanceScopeContractFor,
  computeAcceptanceArtifactBindingHash,
  stableAcceptanceArtifactId,
  type AcceptanceChildScope,
  type AcceptanceOwnedListenerRecord,
  type AcceptanceOwnedProcessRecord,
  type AcceptanceProcessIdentity,
  type AcceptanceScopeExpectation,
} from '../../../tools/three-project-acceptance.ts';

export interface AcceptanceScopePaths {
  readonly modelPaths: readonly string[];
  readonly appDataPaths: readonly string[];
  readonly sessionPaths: readonly string[];
}

export interface AcceptanceScopeFileAdapter {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  /** Creates a file only when it does not already exist (the lock seam). */
  readonly writeFileExclusive: (
    path: string,
    contents: string,
  ) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly processAlive?: (
    pid: number,
  ) => Promise<'alive' | 'dead' | 'unknown'>;
}

export interface CaptureAcceptanceScopeOwnerOptions {
  readonly scopePath: string;
  readonly runId: string;
  readonly artifactId?: string;
  readonly rootPid: number;
  readonly paths: AcceptanceScopePaths;
  readonly pathsReady?: boolean;
  readonly probe?: AcceptanceScopeProbe;
  readonly files?: Partial<AcceptanceScopeFileAdapter>;
}

const PROCESS_ROLES = ['root', 'app', 'session', 'sidecar', 'model'] as const;
const LISTENER_ROLES = ['cdp', 'runtime', 'model'] as const;
const PATH_KINDS = ['modelPaths', 'appDataPaths', 'sessionPaths'] as const;
const BASELINE_PROCESS_NAMES = new Set([
  'ollama.exe',
  'ollama_llama_server.exe',
  'capture-runtime.exe',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

const defaultFiles: AcceptanceScopeFileAdapter = {
  mkdir: async (path) =>
    mkdirFs(path, { recursive: true }).then(() => undefined),
  readFile: async (path) => readFileFs(path, 'utf8'),
  writeFile: async (path, contents) => writeFileFs(path, contents, 'utf8'),
  writeFileExclusive: async (path, contents) => {
    const handle = await openFs(path, 'wx');
    try {
      await handle.writeFile(contents, 'utf8');
    } catch (error) {
      await unlinkFs(path).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
  },
  rename: async (from, to) => renameFs(from, to),
  unlink: async (path) => unlinkFs(path),
};

const SCOPE_LOCK_SUFFIX = '.lock';
const SCOPE_LOCK_RECONCILE_SUFFIX = '.reconcile';
const SCOPE_LOCK_STALE_AFTER_MS = 30_000;
const SCOPE_LOCK_WAIT_TIMEOUT_MS = 15_000;
const SCOPE_LOCK_POLL_MS = 10;

export type AcceptanceScopeStorageErrorCode =
  | 'capture_acceptance_scope_storage_read_failed'
  | 'capture_acceptance_scope_storage_parse_failed'
  | 'capture_acceptance_scope_storage_mkdir_failed'
  | 'capture_acceptance_scope_storage_write_failed'
  | 'capture_acceptance_scope_storage_rename_failed'
  | 'capture_acceptance_scope_storage_temp_cleanup_failed'
  | 'capture_acceptance_scope_storage_lock_create_failed'
  | 'capture_acceptance_scope_storage_lock_busy'
  | 'capture_acceptance_scope_storage_lock_read_failed'
  | 'capture_acceptance_scope_storage_lock_invalid'
  | 'capture_acceptance_scope_storage_lock_owner_unknown'
  | 'capture_acceptance_scope_storage_lock_reconcile_failed'
  | 'capture_acceptance_scope_storage_lock_reconcile_busy'
  | 'capture_acceptance_scope_storage_lock_release_failed';

export class AcceptanceScopeStorageError extends Error {
  public readonly code: AcceptanceScopeStorageErrorCode;

  public constructor(code: AcceptanceScopeStorageErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = 'AcceptanceScopeStorageError';
    this.code = code;
  }
}

function mergeFiles(
  files: Partial<AcceptanceScopeFileAdapter> | undefined,
): AcceptanceScopeFileAdapter {
  return { ...defaultFiles, ...(files ?? {}) };
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

async function defaultProcessAlive(
  pid: number,
): Promise<'alive' | 'dead' | 'unknown'> {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function lockPathFor(scopePath: string): string {
  return `${scopePath}${SCOPE_LOCK_SUFFIX}`;
}

interface AcceptanceScopeLockRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly createdAtEpochMs: number;
  readonly token: string;
}

function validLockRecord(value: unknown): value is AcceptanceScopeLockRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    asPositivePid(value.pid) !== undefined &&
    Number.isSafeInteger(value.createdAtEpochMs) &&
    Number(value.createdAtEpochMs) > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0
  );
}

function storageError(
  code: AcceptanceScopeStorageErrorCode,
  cause?: unknown,
): AcceptanceScopeStorageError {
  return cause instanceof AcceptanceScopeStorageError
    ? cause
    : new AcceptanceScopeStorageError(code, cause);
}

async function readScopeValue(
  scopePath: string,
  files: AcceptanceScopeFileAdapter,
): Promise<unknown> {
  let raw: string;
  try {
    raw = await files.readFile(scopePath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw storageError('capture_acceptance_scope_storage_read_failed', error);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw storageError('capture_acceptance_scope_storage_parse_failed', error);
  }
}

async function releaseScopeLock(
  lockPath: string,
  files: AcceptanceScopeFileAdapter,
): Promise<void> {
  try {
    await files.unlink(lockPath);
  } catch (error) {
    if (isNotFound(error)) return;
    throw storageError(
      'capture_acceptance_scope_storage_lock_release_failed',
      error,
    );
  }
}

async function acquireReconcileGate(
  lockPath: string,
  files: AcceptanceScopeFileAdapter,
  now: () => number,
): Promise<string> {
  const gatePath = `${lockPath}${SCOPE_LOCK_RECONCILE_SUFFIX}`;
  const deadline = now() + SCOPE_LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      await files.writeFileExclusive(
        gatePath,
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: randomUUID() })}\n`,
      );
      return gatePath;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw storageError(
          'capture_acceptance_scope_storage_lock_reconcile_failed',
          error,
        );
      }
      if (now() >= deadline) {
        throw new AcceptanceScopeStorageError(
          'capture_acceptance_scope_storage_lock_reconcile_busy',
        );
      }
      await (
        files.delay ??
        ((milliseconds: number) =>
          new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, milliseconds);
          }))
      )(SCOPE_LOCK_POLL_MS);
    }
  }
}

async function withReconcileGate<T>(
  lockPath: string,
  files: AcceptanceScopeFileAdapter,
  now: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  const gatePath = await acquireReconcileGate(lockPath, files, now);
  let operationFailed = false;
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseScopeLock(gatePath, files);
    } catch (error) {
      if (operationFailed) {
        const releaseError = new AcceptanceScopeStorageError(
          'capture_acceptance_scope_storage_lock_release_failed',
          operationError,
        );
        Object.defineProperty(releaseError, 'releaseCause', {
          configurable: true,
          value: error,
        });
        // Preserve the original operation/release error precedence.
        // eslint-disable-next-line no-unsafe-finally
        throw releaseError;
      }
      // Preserve the original operation/release error precedence.
      // eslint-disable-next-line no-unsafe-finally
      throw error;
    }
  }
}

async function reconcileStaleScopeLock(
  lockPath: string,
  files: AcceptanceScopeFileAdapter,
  now: () => number,
): Promise<'removed' | 'held'> {
  return withReconcileGate(lockPath, files, now, async () => {
    let raw: string;
    try {
      raw = await files.readFile(lockPath);
    } catch (error) {
      if (isNotFound(error)) return 'removed';
      throw storageError(
        'capture_acceptance_scope_storage_lock_read_failed',
        error,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw storageError(
        'capture_acceptance_scope_storage_lock_invalid',
        error,
      );
    }
    if (!validLockRecord(value)) {
      throw new AcceptanceScopeStorageError(
        'capture_acceptance_scope_storage_lock_invalid',
      );
    }
    if (now() - value.createdAtEpochMs < SCOPE_LOCK_STALE_AFTER_MS) {
      return 'held';
    }
    const alive = await (files.processAlive ?? defaultProcessAlive)(value.pid);
    if (alive === 'alive') return 'held';
    if (alive === 'unknown') {
      throw new AcceptanceScopeStorageError(
        'capture_acceptance_scope_storage_lock_owner_unknown',
      );
    }
    // The reconcile gate serializes the observation, claim, and cleanup. A
    // second reconciler must re-read the lock after the first has released the
    // gate, so it cannot apply an old observation to replacement ownership.
    const quarantinePath = `${lockPath}.${randomUUID()}.stale`;
    try {
      await files.rename(lockPath, quarantinePath);
    } catch (error) {
      if (isNotFound(error)) return 'removed';
      throw storageError(
        'capture_acceptance_scope_storage_lock_reconcile_failed',
        error,
      );
    }
    await releaseScopeLock(quarantinePath, files);
    return 'removed';
  });
}

async function acquireScopeLock(
  scopePath: string,
  files: AcceptanceScopeFileAdapter,
): Promise<string> {
  const lockPath = lockPathFor(scopePath);
  const now = files.now ?? Date.now;
  const record: AcceptanceScopeLockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    createdAtEpochMs: now(),
    token: randomUUID(),
  };
  const contents = `${JSON.stringify(record)}\n`;
  const deadline = now() + SCOPE_LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      await files.writeFileExclusive(lockPath, contents);
      return lockPath;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw storageError(
          'capture_acceptance_scope_storage_lock_create_failed',
          error,
        );
      }
      const lockState = await reconcileStaleScopeLock(lockPath, files, now);
      if (lockState === 'removed') continue;
      if (now() >= deadline) {
        throw new AcceptanceScopeStorageError(
          'capture_acceptance_scope_storage_lock_busy',
        );
      }
      await (
        files.delay ??
        ((milliseconds: number) =>
          new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, milliseconds);
          }))
      )(SCOPE_LOCK_POLL_MS);
    }
  }
}

async function withScopeLock<T>(
  scopePath: string,
  files: AcceptanceScopeFileAdapter,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = await acquireScopeLock(scopePath, files);
  let operationFailed = false;
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseScopeLock(lockPath, files);
    } catch (error) {
      if (operationFailed) {
        const releaseError = new AcceptanceScopeStorageError(
          'capture_acceptance_scope_storage_lock_release_failed',
          operationError,
        );
        Object.defineProperty(releaseError, 'releaseCause', {
          configurable: true,
          value: error,
        });
        // Preserve the original operation/release error precedence.
        // eslint-disable-next-line no-unsafe-finally
        throw releaseError;
      }
      // Preserve the original operation/release error precedence.
      // eslint-disable-next-line no-unsafe-finally
      throw error;
    }
  }
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').toLowerCase();
}

function identityKey(identity: AcceptanceProcessIdentity): string {
  return [
    String(identity.pid),
    identity.creationTimeUtc.trim(),
    normalizePath(identity.executable),
  ].join('|');
}

function asPositivePid(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

function isAbsoluteExecutable(value: string): boolean {
  const normalized = normalizePath(value);
  return Boolean(normalized) && /^(?:[a-z]:\/|\/|\/\/)/u.test(normalized);
}

function isLoopbackHost(value: string): boolean {
  return LOOPBACK_HOSTS.has(value.trim().toLowerCase());
}

function isWebViewProcess(
  process_: AcceptanceScopeProcessObservation,
): boolean {
  const name = process_.name.toLowerCase();
  const executable = basename(process_.executable).toLowerCase();
  return name === 'msedgewebview2.exe' || executable === 'msedgewebview2.exe';
}

function isRuntimeProcess(
  process_: AcceptanceScopeProcessObservation,
): boolean {
  const name = process_.name.toLowerCase();
  const executable = process_.executable.toLowerCase();
  const commandLine = process_.commandLine?.toLowerCase() ?? '';
  return (
    name.includes('capture-runtime') ||
    executable.includes('capture-runtime') ||
    commandLine.includes('capture-runtime')
  );
}

function isDesktopProcess(
  process_: AcceptanceScopeProcessObservation,
): boolean {
  const name = process_.name.toLowerCase();
  const executable = basename(process_.executable).toLowerCase();
  return (
    name === 'capture-workbench-desktop.exe' ||
    executable === 'capture-workbench-desktop.exe'
  );
}

function isModelProcess(process_: AcceptanceScopeProcessObservation): boolean {
  const name = process_.name.toLowerCase();
  const executable = process_.executable.toLowerCase();
  return (
    name === 'ollama.exe' ||
    name === 'ollama_llama_server.exe' ||
    executable.endsWith('/ollama.exe') ||
    executable.endsWith('/ollama_llama_server.exe')
  );
}

function isBaselineProcess(
  process_: AcceptanceScopeProcessObservation,
): boolean {
  const name = process_.name.toLowerCase();
  const executable = basename(process_.executable).toLowerCase();
  return (
    BASELINE_PROCESS_NAMES.has(name) || BASELINE_PROCESS_NAMES.has(executable)
  );
}

function descendantsOf(
  processes: readonly AcceptanceScopeProcessObservation[],
  rootPid: number,
): AcceptanceScopeProcessObservation[] {
  const byParent = new Map<number, AcceptanceScopeProcessObservation[]>();
  for (const process_ of processes) {
    if (process_.parentPid === undefined) continue;
    const siblings = byParent.get(process_.parentPid) ?? [];
    siblings.push(process_);
    byParent.set(process_.parentPid, siblings);
  }
  const found: AcceptanceScopeProcessObservation[] = [];
  const seen = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parentPid = pending.shift();
    if (parentPid === undefined) continue;
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found.sort((left, right) => left.pid - right.pid);
}

function processIdentity(
  process_: AcceptanceScopeProcessObservation | undefined,
): AcceptanceProcessIdentity | undefined {
  if (!process_) return undefined;
  if (
    asPositivePid(process_.pid) === undefined ||
    !process_.creationTimeUtc.trim() ||
    !isAbsoluteExecutable(process_.executable)
  )
    return undefined;
  return {
    pid: process_.pid,
    creationTimeUtc: process_.creationTimeUtc,
    executable: process_.executable,
  };
}

function sameExpectation(
  actual: AcceptanceScopeExpectation,
  expected: AcceptanceScopeExpectation,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPreparedScope(
  value: unknown,
  runId: string,
  artifactId: string,
  allowLaunched = false,
): value is AcceptanceChildScope {
  if (!isRecord(value)) return false;
  const expected = acceptanceScopeContractFor('capture-workbench');
  return (
    value.schemaVersion === 2 &&
    value.project === 'capture-workbench' &&
    value.runId === runId &&
    value.artifactId === artifactId &&
    value.artifactSha256 === null &&
    value.status === 'prepared' &&
    value.evidenceComplete === false &&
    (allowLaunched || value.launchAttempted === false) &&
    isRecord(value.expected) &&
    sameExpectation(
      value.expected as unknown as AcceptanceScopeExpectation,
      expected,
    ) &&
    Array.isArray(value.processRecords) &&
    Array.isArray(value.baselineProcessRecords) &&
    Array.isArray(value.listenerRecords) &&
    Array.isArray(value.modelPaths) &&
    Array.isArray(value.appDataPaths) &&
    Array.isArray(value.sessionPaths)
  );
}

function stableArtifactId(
  runId: string,
  artifactId: string | undefined,
): string {
  return artifactId ?? stableAcceptanceArtifactId('capture-workbench', runId);
}

function sanitizePaths(paths: AcceptanceScopePaths): AcceptanceScopePaths {
  return {
    modelPaths: paths.modelPaths
      .filter((path) => typeof path === 'string' && Boolean(path.trim()))
      .map((path) => resolve(path)),
    appDataPaths: paths.appDataPaths
      .filter((path) => typeof path === 'string' && Boolean(path.trim()))
      .map((path) => resolve(path)),
    sessionPaths: paths.sessionPaths
      .filter((path) => typeof path === 'string' && Boolean(path.trim()))
      .map((path) => resolve(path)),
  };
}

function ownedProcessRecord(
  role: (typeof PROCESS_ROLES)[number],
  identity: AcceptanceProcessIdentity,
  runId: string,
  artifactId: string,
): AcceptanceOwnedProcessRecord {
  return { ...identity, role, runId, artifactId };
}

function ownedListenerRecord(
  role: (typeof LISTENER_ROLES)[number],
  listener: AcceptanceScopeListenerObservation,
  owner: AcceptanceProcessIdentity,
  runId: string,
  artifactId: string,
): AcceptanceOwnedListenerRecord {
  return {
    host: listener.host.trim().toLowerCase(),
    port: listener.port,
    protocol: 'tcp',
    role,
    runId,
    artifactId,
    owner,
  };
}

function appendIdentity<T extends AcceptanceProcessIdentity>(
  records: T[],
  next: T,
): void {
  if (!records.some((record) => identityKey(record) === identityKey(next))) {
    records.push(next);
  }
}

function appendListener(
  records: AcceptanceOwnedListenerRecord[],
  next: AcceptanceOwnedListenerRecord,
): void {
  if (
    !records.some(
      (record) =>
        record.role === next.role &&
        record.host === next.host &&
        record.port === next.port &&
        identityKey(record.owner) === identityKey(next.owner),
    )
  )
    records.push(next);
}

export class CaptureAcceptanceScopeOwner {
  private readonly files: AcceptanceScopeFileAdapter;
  private readonly probe: AcceptanceScopeProbe;
  private readonly artifactId: string;
  private readonly rootPid: number;
  private readonly scopePath: string;
  private readonly runId: string;
  private paths: AcceptanceScopePaths;
  private pathsReady: boolean;
  private launchPid: number | undefined;
  private appPid: number | undefined;
  private launchAttempted = false;
  private baselineProcessRecords: AcceptanceProcessIdentity[] = [];
  private processRecords = new Map<
    (typeof PROCESS_ROLES)[number],
    AcceptanceOwnedProcessRecord[]
  >();
  private listenerRecords = new Map<
    (typeof LISTENER_ROLES)[number],
    AcceptanceOwnedListenerRecord[]
  >();
  private prepared = false;
  private observationAvailable = true;

  public constructor(options: CaptureAcceptanceScopeOwnerOptions) {
    this.files = mergeFiles(options.files);
    this.probe =
      options.probe ??
      createWindowsAcceptanceScopeProbe({
        adapter: { expectedRootPid: options.rootPid },
      });
    this.artifactId = stableArtifactId(options.runId, options.artifactId);
    this.rootPid = options.rootPid;
    this.scopePath = options.scopePath;
    this.runId = options.runId;
    this.paths = sanitizePaths(options.paths);
    this.pathsReady = options.pathsReady !== false && this.hasPaths(this.paths);
  }

  public async prepare(): Promise<void> {
    await withScopeLock(this.scopePath, this.files, async () => {
      const current = await this.readScope();
      if (!isPreparedScope(current, this.runId, this.artifactId)) {
        throw new Error('capture_acceptance_scope_prepared_binding_invalid');
      }
      this.prepared = true;
      this.launchAttempted = current.launchAttempted;
      this.paths = this.pathsFromCurrent(current) ?? this.paths;
      this.pathsReady = this.pathsReady || this.hasPaths(this.paths);
      const snapshot = await this.probe.snapshot();
      assertWindowsAcceptanceScopeSnapshot(snapshot, this.rootPid);
      this.baselineProcessRecords = this.baselineFrom(snapshot, current);
      await this.writeScopeLocked(
        this.buildScope('prepared', false, current.artifactSha256),
        current,
      );
    });
  }

  public async setPaths(paths: AcceptanceScopePaths): Promise<void> {
    this.requirePrepared();
    const sanitized = sanitizePaths(paths);
    if (!this.hasPaths(sanitized)) {
      throw new Error('capture_acceptance_scope_paths_invalid');
    }
    this.paths = sanitized;
    this.pathsReady = true;
    await this.writeScope(this.buildScope('prepared', false, null), false);
  }

  public async recordLaunch(appPid: number): Promise<void> {
    this.requirePrepared();
    if (asPositivePid(appPid) === undefined) {
      throw new Error('capture_acceptance_scope_app_pid_invalid');
    }
    this.launchPid = appPid;
    this.appPid = appPid;
    this.launchAttempted = true;
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    this.requirePrepared();
    await withScopeLock(this.scopePath, this.files, async () => {
      const snapshot = await this.probe.snapshot();
      assertWindowsAcceptanceScopeSnapshot(snapshot, this.rootPid);
      this.observationAvailable = true;
      this.derive(snapshot);
      const current = await this.readScope();
      this.paths = this.pathsFromCurrent(current) ?? this.paths;
      this.pathsReady = this.pathsReady || this.hasPaths(this.paths);
      await this.writeScopeLocked(
        this.buildScope('prepared', false, null),
        current,
      );
    });
  }

  public async finalizeFromManifest(manifestPath: string): Promise<void> {
    this.requirePrepared();
    try {
      await this.refresh();
    } catch {
      // The last atomically written snapshot remains the truthful evidence
      // when the final OS query is unavailable.
      this.observationAvailable = false;
    }
    let artifactSha256: string | null = null;
    try {
      const manifest = JSON.parse(
        await this.files.readFile(manifestPath),
      ) as Record<string, unknown>;
      artifactSha256 = computeAcceptanceArtifactBindingHash(manifest) ?? null;
    } catch {
      artifactSha256 = null;
    }
    await this.writeScope(
      this.buildScope(
        'terminal',
        this.pathsReady && this.observationAvailable,
        artifactSha256,
      ),
    );
  }

  private requirePrepared(): void {
    if (!this.prepared)
      throw new Error('capture_acceptance_scope_owner_not_prepared');
  }

  private hasPaths(paths: AcceptanceScopePaths): boolean {
    return PATH_KINDS.every((kind) => paths[kind].length > 0);
  }

  private pathsFromCurrent(value: unknown): AcceptanceScopePaths | undefined {
    if (!isRecord(value)) return undefined;
    if (!PATH_KINDS.every((kind) => Array.isArray(value[kind])))
      return undefined;
    const paths = {
      modelPaths: value.modelPaths,
      appDataPaths: value.appDataPaths,
      sessionPaths: value.sessionPaths,
    } as AcceptanceScopePaths;
    if (
      !PATH_KINDS.every((kind) =>
        paths[kind].every((path) => typeof path === 'string'),
      )
    )
      return undefined;
    return sanitizePaths(paths);
  }

  private baselineFrom(
    snapshot: AcceptanceScopeSnapshot,
    current: unknown,
  ): AcceptanceProcessIdentity[] {
    const records: AcceptanceProcessIdentity[] = [];
    const ownedBeforeLaunch = new Set([
      this.rootPid,
      ...descendantsOf(snapshot.processes, this.rootPid).map(
        (process_) => process_.pid,
      ),
    ]);
    for (const process_ of snapshot.processes) {
      const identity = processIdentity(process_);
      if (
        identity &&
        isBaselineProcess(process_) &&
        !ownedBeforeLaunch.has(process_.pid)
      )
        appendIdentity(records, identity);
    }
    if (records.length > 0) return records;
    if (!isRecord(current) || !Array.isArray(current.baselineProcessRecords))
      return records;
    for (const value of current.baselineProcessRecords) {
      if (!isRecord(value)) continue;
      const identity = processIdentity(
        value as unknown as AcceptanceScopeProcessObservation,
      );
      if (identity) appendIdentity(records, identity);
    }
    return records;
  }

  private derive(snapshot: AcceptanceScopeSnapshot): void {
    const byPid = new Map(
      snapshot.processes.map((process_) => [process_.pid, process_]),
    );
    const launchDescendants =
      this.launchPid === undefined
        ? []
        : descendantsOf(snapshot.processes, this.launchPid);
    const appCandidate =
      this.appPid === undefined ? undefined : byPid.get(this.appPid);
    const discoveredApp =
      appCandidate && isDesktopProcess(appCandidate)
        ? appCandidate
        : launchDescendants.find(isDesktopProcess);
    if (discoveredApp) this.appPid = discoveredApp.pid;
    const descendants =
      this.appPid === undefined
        ? []
        : descendantsOf(snapshot.processes, this.appPid);
    const root = processIdentity(byPid.get(this.rootPid));
    const app = processIdentity(byPid.get(this.appPid ?? -1));
    this.rememberProcess('root', root);
    this.rememberProcess('app', app);
    for (const process_ of descendants.filter(isWebViewProcess))
      this.rememberProcess('session', processIdentity(process_));
    for (const process_ of descendants.filter(isRuntimeProcess))
      this.rememberProcess('sidecar', processIdentity(process_));
    for (const process_ of descendants.filter(isModelProcess))
      this.rememberProcess('model', processIdentity(process_));
    const listenerCandidates = snapshot.listeners
      .filter(
        (listener) =>
          isLoopbackHost(listener.host) &&
          listener.port > 0 &&
          listener.port <= 65_535,
      )
      .sort((left, right) => left.port - right.port);
    const sessionPids = new Set(
      descendants.filter(isWebViewProcess).map((process_) => process_.pid),
    );
    const cdp = listenerCandidates.find(
      (listener) =>
        sessionPids.has(listener.owningPid) &&
        (process.env.CAPTURE_ACCEPTANCE_CDP_PORT === undefined ||
          listener.port === Number(process.env.CAPTURE_ACCEPTANCE_CDP_PORT)),
    );
    const ownerFor = (
      role: (typeof PROCESS_ROLES)[number],
      owningPid: number,
    ): AcceptanceProcessIdentity | undefined => {
      const observed = processIdentity(byPid.get(owningPid));
      if (!observed) return undefined;
      return this.processRecords
        .get(role)
        ?.find((record) => identityKey(record) === identityKey(observed));
    };
    const cdpOwner = cdp ? ownerFor('session', cdp.owningPid) : undefined;
    const runtime = listenerCandidates.find((listener) =>
      ownerFor('sidecar', listener.owningPid),
    );
    const runtimeOwner = runtime
      ? ownerFor('sidecar', runtime.owningPid)
      : undefined;
    const modelListener = listenerCandidates.find((listener) =>
      ownerFor('model', listener.owningPid),
    );
    const modelOwner = modelListener
      ? ownerFor('model', modelListener.owningPid)
      : undefined;
    this.rememberListener('cdp', cdp, cdpOwner);
    this.rememberListener('runtime', runtime, runtimeOwner);
    this.rememberListener('model', modelListener, modelOwner);
  }

  private rememberProcess(
    role: (typeof PROCESS_ROLES)[number],
    identity: AcceptanceProcessIdentity | undefined,
  ): void {
    if (!identity) return;
    const record = ownedProcessRecord(
      role,
      identity,
      this.runId,
      this.artifactId,
    );
    const records = this.processRecords.get(role) ?? [];
    appendIdentity(records, record);
    this.processRecords.set(role, records);
  }

  private rememberListener(
    role: (typeof LISTENER_ROLES)[number],
    listener: AcceptanceScopeListenerObservation | undefined,
    owner: AcceptanceProcessIdentity | undefined,
  ): void {
    if (!listener || !owner) return;
    const record = ownedListenerRecord(
      role,
      listener,
      owner,
      this.runId,
      this.artifactId,
    );
    const records = this.listenerRecords.get(role) ?? [];
    appendListener(records, record);
    this.listenerRecords.set(role, records);
  }

  private buildScope(
    status: 'prepared' | 'terminal',
    evidenceComplete: boolean,
    artifactSha256: string | null,
  ): AcceptanceChildScope {
    return {
      schemaVersion: 2,
      project: 'capture-workbench',
      runId: this.runId,
      artifactId: this.artifactId,
      artifactSha256,
      expected: acceptanceScopeContractFor('capture-workbench'),
      status,
      evidenceComplete,
      launchAttempted: this.launchAttempted,
      processRecords: PROCESS_ROLES.flatMap(
        (role) => this.processRecords.get(role) ?? [],
      ),
      baselineProcessRecords: this.baselineProcessRecords.map((identity) => ({
        ...identity,
        role: 'baseline' as const,
      })),
      listenerRecords: LISTENER_ROLES.flatMap(
        (role) => this.listenerRecords.get(role) ?? [],
      ),
      modelPaths: this.paths.modelPaths,
      appDataPaths: this.paths.appDataPaths,
      sessionPaths: this.paths.sessionPaths,
    };
  }

  private async readScope(): Promise<unknown> {
    return readScopeValue(this.scopePath, this.files);
  }

  private async writeScopeLocked(
    scope: AcceptanceChildScope,
    current: unknown,
    preserveCurrentPaths = true,
  ): Promise<void> {
    // Terminal evidence is monotonic. An interval refresh may already be
    // waiting for this lease when finalization commits; it must not be able to
    // turn the committed terminal record back into a prepared record.
    if (isRecord(current) && current.status === 'terminal') return;
    const currentPaths = this.pathsFromCurrent(current);
    const output =
      preserveCurrentPaths && currentPaths
        ? { ...scope, ...currentPaths }
        : scope;
    await atomicWriteJson(this.scopePath, output, this.files);
  }

  private async writeScope(
    scope: AcceptanceChildScope,
    preserveCurrentPaths = true,
  ): Promise<void> {
    await withScopeLock(this.scopePath, this.files, async () => {
      await this.writeScopeLocked(
        scope,
        await this.readScope(),
        preserveCurrentPaths,
      );
    });
  }
}

export async function patchCaptureAcceptanceScopePaths(
  scopePath: string,
  runId: string,
  paths: AcceptanceScopePaths,
  files?: Partial<AcceptanceScopeFileAdapter>,
): Promise<void> {
  const adapter = mergeFiles(files);
  await withScopeLock(scopePath, adapter, async () => {
    const current = await readScopeValue(scopePath, adapter);
    const artifactId = stableAcceptanceArtifactId('capture-workbench', runId);
    if (!isPreparedScope(current, runId, artifactId, true)) {
      throw new Error('capture_acceptance_scope_prepared_binding_invalid');
    }
    const sanitized = sanitizePaths(paths);
    if (!PATH_KINDS.every((kind) => sanitized[kind].length > 0)) {
      throw new Error('capture_acceptance_scope_paths_invalid');
    }
    await atomicWriteJson(
      scopePath,
      {
        ...current,
        ...sanitized,
      },
      adapter,
    );
  });
}

async function atomicWriteJson(
  path: string,
  value: unknown,
  files: AcceptanceScopeFileAdapter,
): Promise<void> {
  try {
    await files.mkdir(dirname(path));
  } catch (error) {
    throw storageError('capture_acceptance_scope_storage_mkdir_failed', error);
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let primaryError: AcceptanceScopeStorageError | undefined;
  try {
    await files.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    primaryError = storageError(
      'capture_acceptance_scope_storage_write_failed',
      error,
    );
  }
  if (!primaryError) {
    try {
      await files.rename(temporary, path);
    } catch (error) {
      primaryError = storageError(
        'capture_acceptance_scope_storage_rename_failed',
        error,
      );
    }
  }
  let cleanupError: AcceptanceScopeStorageError | undefined;
  try {
    await files.unlink(temporary);
  } catch (error) {
    if (!isNotFound(error)) {
      cleanupError = storageError(
        'capture_acceptance_scope_storage_temp_cleanup_failed',
        error,
      );
    }
  }
  if (cleanupError) {
    if (primaryError) {
      Object.defineProperty(cleanupError, 'cause', {
        configurable: true,
        value: primaryError,
      });
    }
    throw cleanupError;
  }
  if (primaryError) {
    throw primaryError;
  }
}
