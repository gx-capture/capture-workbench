import {
  selectValidationCaptureClient,
  type ValidationClientEnvironment,
} from './validation-client';

const backendConfig = {
  baseUrl: 'http://127.0.0.1:43119',
  token: 'memory-only-test-token',
  runtimeVersion: '0.1.0',
  apiVersion: '1.0',
  captureDocumentSchemaVersion: '1',
};

const startingStatus = {
  status: 'starting',
  detail: 'Capture runtime is starting.',
};

const readyStatus = {
  status: 'ready',
  detail: 'Capture runtime is ready.',
};

describe('selectValidationCaptureClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('polls from starting to ready before loading the memory-only backend config', async () => {
    const statuses = [startingStatus, readyStatus];
    let statusIndex = 0;
    const loadDesktopRuntimeStatus = vi.fn(
      async () => statuses[Math.min(statusIndex++, statuses.length - 1)] ?? readyStatus,
    );
    const loadBackendConfig = vi.fn(async () => backendConfig);
    const wait = vi.fn(async () => undefined);
    const fetchMock = installReadyFetch();
    const selection = selectValidationCaptureClient(
      tauriEnvironment({ loadDesktopRuntimeStatus, loadBackendConfig, wait }),
    );

    await expect(selection.client.getReady()).resolves.toMatchObject({
      service: 'capture-runtime',
    });

    expect(loadDesktopRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(loadBackendConfig).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed runtime detail without requesting backend config', async () => {
    const loadBackendConfig = vi.fn(async () => backendConfig);
    const selection = selectValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(async () => ({
          status: 'failed',
          detail: 'Runtime manifest SHA-256 mismatch.',
        })),
        loadBackendConfig,
      }),
    );

    await expect(selection.client.getReady()).rejects.toThrow(
      'Capture runtime failed: Runtime manifest SHA-256 mismatch.',
    );
    expect(loadBackendConfig).not.toHaveBeenCalled();
  });

  it('surfaces a stopped runtime detail without requesting backend config', async () => {
    const loadBackendConfig = vi.fn(async () => backendConfig);
    const selection = selectValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(async () => ({
          status: 'stopped',
          detail: 'Capture runtime was stopped by the desktop harness.',
        })),
        loadBackendConfig,
      }),
    );

    await expect(selection.client.getReady()).rejects.toThrow(
      'Capture runtime stopped: Capture runtime was stopped by the desktop harness.',
    );
    expect(loadBackendConfig).not.toHaveBeenCalled();
  });

  it('fails clearly after the bounded starting-status poll expires', async () => {
    const loadDesktopRuntimeStatus = vi.fn(async () => startingStatus);
    const loadBackendConfig = vi.fn(async () => backendConfig);
    const wait = vi.fn(async () => undefined);
    const selection = selectValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus,
        loadBackendConfig,
        wait,
        timeoutMs: 2,
        pollIntervalMs: 1,
      }),
    );

    await expect(selection.client.getReady()).rejects.toThrow(
      'Capture runtime did not become ready within 2 ms. Last status: Capture runtime is starting.',
    );
    expect(loadDesktopRuntimeStatus).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(loadBackendConfig).not.toHaveBeenCalled();
  });

  it('bounds a never-settling desktop runtime status invocation', async () => {
    const pendingStatus = deferred<typeof readyStatus>();
    const loadBackendConfig = vi.fn(async () => backendConfig);
    let now = 0;
    let fireDeadline: (() => void) | undefined;
    const selection = selectValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(() => pendingStatus.promise),
        loadBackendConfig,
        timeoutMs: 5,
        now: () => now,
        scheduleTimeout: (callback, milliseconds) => {
          let cancelled = false;
          fireDeadline = () => {
            if (cancelled) return;
            now += milliseconds;
            callback();
          };
          return () => {
            cancelled = true;
          };
        },
      }),
    );

    const readiness = selection.client.getReady();
    const rejection = expect(readiness).rejects.toThrow(
      'Capture runtime did not become ready within 5 ms. Last status: unavailable',
    );
    expect(fireDeadline).toBeTypeOf('function');
    fireDeadline?.();
    await rejection;
    expect(loadBackendConfig).not.toHaveBeenCalled();

    // The timed-out invocation can still reject later without becoming unhandled.
    pendingStatus.reject(new Error('late status failure'));
    await Promise.resolve();
  });

  it('rejects a ready status that arrives after the monotonic deadline', async () => {
    let now = 0;
    const pendingStatus = deferred<typeof readyStatus>();
    const loadBackendConfig = vi.fn(async () => backendConfig);
    const selection = selectValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(() => pendingStatus.promise),
        loadBackendConfig,
        timeoutMs: 5,
        now: () => now,
        scheduleTimeout: () => () => undefined,
      }),
    );

    const readiness = selection.client.getReady();
    const rejection = expect(readiness).rejects.toThrow(
      'Capture runtime did not become ready within 5 ms. Last status: Capture runtime is ready.',
    );
    now = 6;
    pendingStatus.resolve(readyStatus);
    await rejection;
    expect(loadBackendConfig).not.toHaveBeenCalled();
  });

  it('does not request backend config while a starting-status delay is pending', async () => {
    const delay = deferred<void>();
    let statusIndex = 0;
    const loadDesktopRuntimeStatus = vi.fn(async () => {
      const status = statusIndex === 0 ? startingStatus : readyStatus;
      statusIndex += 1;
      return status;
    });
    const loadBackendConfig = vi.fn(async () => backendConfig);
    const wait = vi.fn(() => delay.promise);
    const fetchMock = installReadyFetch();
    const selection = selectValidationCaptureClient(
      tauriEnvironment({ loadDesktopRuntimeStatus, loadBackendConfig, wait }),
    );

    const ready = selection.client.getReady();
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    expect(loadBackendConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    delay.resolve(undefined);
    await expect(ready).resolves.toMatchObject({ service: 'capture-runtime' });
    expect(loadBackendConfig).toHaveBeenCalledTimes(1);
  });
});

function tauriEnvironment(options: {
  readonly loadDesktopRuntimeStatus: ValidationClientEnvironment['loadDesktopRuntimeStatus'];
  readonly loadBackendConfig: ValidationClientEnvironment['loadBackendConfig'];
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly scheduleTimeout?: (
    callback: () => void,
    milliseconds: number,
  ) => () => void;
}): ValidationClientEnvironment {
  let elapsedMs = 0;
  return {
    tauri: true,
    search: '',
    loadDesktopRuntimeStatus: options.loadDesktopRuntimeStatus,
    loadBackendConfig: options.loadBackendConfig,
    runtimeReadinessPolling: {
      timeoutMs: options.timeoutMs ?? 1_000,
      pollIntervalMs: options.pollIntervalMs ?? 1,
      now: options.now ?? (() => elapsedMs),
      wait:
        options.wait ??
        (async (milliseconds) => {
          elapsedMs += milliseconds;
        }),
      scheduleTimeout:
        options.scheduleTimeout ??
        ((callback, milliseconds) => {
          const handle = globalThis.setTimeout(callback, milliseconds);
          return () => globalThis.clearTimeout(handle);
        }),
    },
  };
}

function installReadyFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        ready: true,
        service: 'capture-runtime',
        runtimeVersion: '0.1.0',
        apiVersion: '1.0',
        captureDocumentSchemaVersion: '1',
        capabilities: {
          captureKinds: ['pdf', 'image', 'audio'],
          structuringModes: ['runtime'],
          supportsCancellation: true,
          supportsRawDiagnostics: true,
          maxUploadBytes: 25_000_000,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
