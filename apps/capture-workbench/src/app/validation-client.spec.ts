import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import type {
  ValidationCaptureFixture,
  ValidationClientEnvironment,
} from './contracts';
import { ValidationCaptureClientService } from './services/validation-client.service';
import { ValidationEnvironmentService } from './services/validation-environment.service';
import { ValidationCaptureFixtureService } from './services/validation-fixture.service';
import { ValidationRuntimeReadinessService } from './services/validation-runtime-readiness.service';

const backendConfig = {
  baseUrl: 'http://127.0.0.1:43119',
  token: 'memory-only-test-token',
  runtimeVersion: '0.3.0',
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

describe('ValidationCaptureClientService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('polls from starting to ready before loading the memory-only backend config', async () => {
    const statuses = [startingStatus, readyStatus];
    let statusIndex = 0;
    const loadDesktopRuntimeStatus = vi.fn(() =>
      of(statuses[Math.min(statusIndex++, statuses.length - 1)] ?? readyStatus),
    );
    const loadBackendConfig = vi.fn(() => of(backendConfig));
    const wait = vi.fn(() => of(undefined));
    const fetchMock = installReadyFetch();
    const selection = configureValidationCaptureClient(
      tauriEnvironment({ loadDesktopRuntimeStatus, loadBackendConfig, wait }),
    );

    let result: unknown;
    let error: unknown;
    selection.client.getReady().subscribe({
      next: (value) => (result = value),
      error: (value) => (error = value),
    });
    await vi.waitFor(() => expect(result).toMatchObject({ service: 'capture-runtime' }));

    expect(error).toBeUndefined();
    expect(loadDesktopRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(loadBackendConfig).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed runtime detail without requesting backend config', async () => {
    const loadBackendConfig = vi.fn(() => of(backendConfig));
    const selection = configureValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(() =>
          of({ status: 'failed', detail: 'Runtime manifest SHA-256 mismatch.' }),
        ),
        loadBackendConfig,
      }),
    );

    let error: unknown;
    selection.client.getReady().subscribe({ error: (value) => (error = value) });
    await vi.waitFor(() => expect(error).toBeInstanceOf(Error));
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Capture runtime failed: Runtime manifest SHA-256 mismatch.',
      }),
    );
    expect(loadBackendConfig).not.toHaveBeenCalled();
  });

  it('surfaces a stopped runtime detail without requesting backend config', async () => {
    const loadBackendConfig = vi.fn(() => of(backendConfig));
    const selection = configureValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(() =>
          of({
            status: 'stopped',
            detail: 'Capture runtime was stopped by the desktop harness.',
          }),
        ),
        loadBackendConfig,
      }),
    );

    let error: unknown;
    selection.client.getReady().subscribe({ error: (value) => (error = value) });
    await vi.waitFor(() => expect(error).toBeInstanceOf(Error));
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Capture runtime stopped: Capture runtime was stopped by the desktop harness.',
      }),
    );
    expect(loadBackendConfig).not.toHaveBeenCalled();
  });

  it('fails clearly after the bounded starting-status poll expires', async () => {
    const loadDesktopRuntimeStatus = vi.fn(() => of(startingStatus));
    const loadBackendConfig = vi.fn(() => of(backendConfig));
    const wait = vi.fn(() => of(undefined));
    const selection = configureValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus,
        loadBackendConfig,
        wait,
        timeoutMs: 2,
        pollIntervalMs: 1,
      }),
    );

    let error: unknown;
    selection.client.getReady().subscribe({ error: (value) => (error = value) });
    await vi.waitFor(() => expect(error).toBeInstanceOf(Error));
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Capture runtime did not become ready within 2 ms. Last status: Capture runtime is starting.',
      }),
    );
    expect(loadDesktopRuntimeStatus).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(loadBackendConfig).not.toHaveBeenCalled();
  });

  it('bounds a never-settling desktop runtime status invocation', async () => {
    const pendingStatus = new Subject<typeof readyStatus>();
    const loadBackendConfig = vi.fn(() => of(backendConfig));
    let now = 0;
    let fireDeadline: (() => void) | undefined;
    const selection = configureValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(() => pendingStatus.asObservable()),
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

    let error: unknown;
    selection.client.getReady().subscribe({ error: (value) => (error = value) });
    expect(fireDeadline).toBeTypeOf('function');
    fireDeadline?.();
    await vi.waitFor(() => expect(error).toBeInstanceOf(Error));
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Capture runtime did not become ready within 5 ms. Last status: unavailable',
      }),
    );
    expect(loadBackendConfig).not.toHaveBeenCalled();
    pendingStatus.error(new Error('late status failure'));
  });

  it('rejects a ready status that arrives after the monotonic deadline', async () => {
    let now = 0;
    const pendingStatus = new Subject<typeof readyStatus>();
    const loadBackendConfig = vi.fn(() => of(backendConfig));
    const selection = configureValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(() => pendingStatus.asObservable()),
        loadBackendConfig,
        timeoutMs: 5,
        now: () => now,
        scheduleTimeout: () => () => undefined,
      }),
    );

    let error: unknown;
    selection.client.getReady().subscribe({ error: (value) => (error = value) });
    now = 6;
    pendingStatus.next(readyStatus);
    await vi.waitFor(() => expect(error).toBeInstanceOf(Error));
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Capture runtime did not become ready within 5 ms. Last status: Capture runtime is ready.',
      }),
    );
    expect(loadBackendConfig).not.toHaveBeenCalled();
  });

  it('does not request backend config while a starting-status delay is pending', async () => {
    const delay = new Subject<void>();
    let statusIndex = 0;
    const loadDesktopRuntimeStatus = vi.fn(() =>
      of(statusIndex++ === 0 ? startingStatus : readyStatus),
    );
    const loadBackendConfig = vi.fn(() => of(backendConfig));
    const wait = vi.fn(() => delay.asObservable());
    const fetchMock = installReadyFetch();
    const selection = configureValidationCaptureClient(
      tauriEnvironment({ loadDesktopRuntimeStatus, loadBackendConfig, wait }),
    );

    let result: unknown;
    selection.client.getReady().subscribe({ next: (value) => (result = value) });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    expect(loadBackendConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    delay.next();
    delay.complete();
    await vi.waitFor(() => expect(result).toMatchObject({ service: 'capture-runtime' }));
    expect(loadBackendConfig).toHaveBeenCalledTimes(1);
  });

  it('does not expose browser fixture structuring in Tauri mode', () => {
    const fixture = {
      mode: 'deterministic-e2e',
      client: {} as ValidationCaptureFixture['client'],
      structuringProvider:
        {} as ValidationCaptureFixture['structuringProvider'],
    } satisfies ValidationCaptureFixture;
    const selection = configureValidationCaptureClient(
      tauriEnvironment({
        loadDesktopRuntimeStatus: vi.fn(() => of(readyStatus)),
        loadBackendConfig: vi.fn(() => of(backendConfig)),
      }),
      fixture,
    );

    expect(selection.client.mode).toBe('tauri-http');
    expect(selection.client.hostStructuringAvailable).toBe(false);
    expect(selection.client.structuringProvider).toBeUndefined();
  });
});

function configureValidationCaptureClient(
  environment: ValidationClientEnvironment,
  fixture?: ValidationCaptureFixture,
): {
  readonly client: ValidationCaptureClientService;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: ValidationEnvironmentService, useValue: environment },
      fixture === undefined
        ? ValidationCaptureFixtureService
        : { provide: ValidationCaptureFixtureService, useValue: { select: () => fixture } },
      ValidationRuntimeReadinessService,
      ValidationCaptureClientService,
    ],
  });
  return { client: TestBed.inject(ValidationCaptureClientService) };
}

function tauriEnvironment(options: {
  readonly loadDesktopRuntimeStatus: ValidationClientEnvironment['loadDesktopRuntimeStatus'];
  readonly loadBackendConfig: ValidationClientEnvironment['loadBackendConfig'];
  readonly wait?: (milliseconds: number) => import('rxjs').Observable<void>;
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
        ((milliseconds) => {
          elapsedMs += milliseconds;
          return of(undefined);
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
        runtimeVersion: '0.3.0',
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
