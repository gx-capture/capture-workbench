import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideCaptureWorkbenchInputs } from '../contracts';
import type {
  CaptureClient,
  RuntimeRequirement,
  StartRuntimeInstallationRequest,
} from '../contracts';
import { of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-workbench.component';
import {
  CaptureWorkbenchTestInputSource,
  RAW,
  READY,
  captureWorkbenchRoot,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
} from '../testing/capture-test-support';

describe('CaptureWorkbenchComponent', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;
  let inputSource: CaptureWorkbenchTestInputSource;

  beforeEach(async () => {
    inputSource = createCaptureWorkbenchTestInputSource();
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
      providers: [provideCaptureWorkbenchInputs(inputSource)],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  it('starts runtime installation only after explicit user action', async () => {
    const client = fakeClient({
      getReady: vi.fn(() => of({ ...READY, ready: true })),
      getRequirements: vi.fn(
        (): ReturnType<CaptureClient['getRequirements']> =>
          of([
            {
              requirementId: 'structuring-runtime',
              kind: 'structuring-runtime',
              displayName: 'Ollama',
              status: 'installable',
              requiredFor: ['runtime'],
              installStrategy: 'winget',
            },
            {
              requirementId: 'structuring-model',
              kind: 'structuring-model',
              displayName: 'Capture model',
              status: 'manual_action_required',
              requiredFor: ['runtime'],
              installStrategy: 'manual',
              detail: 'Open Ollama and pull the capture model.',
            },
            {
              requirementId: 'speech-recognition',
              kind: 'speech-recognition',
              displayName: 'Speech recognition',
              status: 'unavailable',
              requiredFor: ['recording'],
              installStrategy: 'none',
              detail: 'Speech recognition is unavailable.',
            },
          ]),
      ),
      startInstallation: vi.fn(
        (
          request: StartRuntimeInstallationRequest,
        ): ReturnType<CaptureClient['startInstallation']> =>
          of({
            installationId: 'install-1',
            requirementId: request.requirementId,
            status: 'completed',
            progress: 1,
            createdAt: RAW.createdAt,
            updatedAt: RAW.createdAt,
            completedAt: RAW.createdAt,
          }),
      ),
    });
    inputSource.client.set(client);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(client.startInstallation).not.toHaveBeenCalled();
    expect(
      Array.from(
        captureWorkbenchRoot(fixture).querySelectorAll(
          '[data-requirement-id]',
        ) as NodeListOf<HTMLElement>,
        (element) => element.dataset['requirementId'],
      ),
    ).toEqual(['structuring-runtime', 'structuring-model', 'speech-recognition']);
    const installButton = captureWorkbenchRoot(fixture).querySelector(
      '.runtime-card .primary',
    ) as HTMLButtonElement | null;
    expect(installButton).not.toBeNull();
    installButton?.click();
    await fixture.whenStable();
    expect(client.startInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementId: 'structuring-runtime',
        consent: true,
      }),
      expect.any(AbortSignal),
    );
    expect(client.startInstallation).toHaveBeenCalledTimes(1);
    fixture.detectChanges();
    expect(captureWorkbenchRoot(fixture).textContent).toContain(
      '請自行完成這個步驟',
    );
    expect(captureWorkbenchRoot(fixture).textContent).toContain(
      '這台電腦無法使用',
    );
  });

  it('presents a core-only release without offering a model install action', async () => {
    const detail =
      'No downloadable model is published for this runtime release.';
    const client = fakeClient({
      getReady: vi.fn(() => of({ ...READY, ready: false })),
      getRequirements: vi.fn(() =>
        of(
          (['text-recognition', 'speech-recognition'] as const).map(
            (requirementId): RuntimeRequirement => ({
              requirementId,
              kind: requirementId,
              displayName: requirementId,
              status: 'unavailable',
              requiredFor:
                requirementId === 'text-recognition' ? ['pdf'] : ['recording'],
              installStrategy: 'runtime-catalog',
              detail,
            }),
          ),
        ),
      ),
      startInstallation: vi.fn(),
    });
    inputSource.client.set(client);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(captureWorkbenchRoot(fixture).textContent).toContain(detail);
    expect(
      captureWorkbenchRoot(fixture).querySelector('.runtime-card .primary'),
    ).toBeNull();
    fixture.componentInstance.store.installMissingRequirements();
    await fixture.whenStable();
    expect(client.startInstallation).not.toHaveBeenCalled();
  });

  it('tells the user what the speech model is before it is installed', async () => {
    inputSource.client.set(
      fakeClient({
        getReady: vi.fn(() => of({ ...READY, ready: false })),
        getRequirements: vi.fn(() =>
          of([
            {
              requirementId: 'speech-recognition',
              kind: 'speech-recognition',
              displayName: 'Speech recognition',
              status: 'installable',
              requiredFor: ['recording'],
              installStrategy: 'runtime-catalog',
              optional: true,
            } satisfies RuntimeRequirement,
          ]),
        ),
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const row = captureWorkbenchRoot(fixture).querySelector(
      '[data-testid="capture-runtime-requirement"][data-requirement-id="speech-recognition"]',
    ) as HTMLElement;
    expect(row.querySelector('strong')?.textContent).toContain(
      '台灣語音轉文字（TEA-ASR 1.1）',
    );
    const guide = row.querySelector('[data-testid="capture-unit-guide"]')
      ?.textContent;
    expect(guide).toContain('台灣華語');
    expect(guide).toContain(
      '兩種大小的辨識模型、對齊時間點的 Qwen3 模型與 GPU 執行環境',
    );
    expect(guide).not.toMatch(/\d+(?:\.\d+)?\s*(?:GB|MB)/);
    expect(guide).toContain('錄音不會上傳');
    expect(row.querySelector('[data-testid="capture-download-size"]')).toBeNull();
  });

  it('shows each listed unit size from downloadBytes and none when it is missing or zero', async () => {
    inputSource.config.set({ identifySpeakers: true });
    inputSource.client.set(
      fakeClient({
        getReady: vi.fn(() => of({ ...READY, ready: false })),
        getRequirements: vi.fn(() =>
          of([
            {
              requirementId: 'speech-recognition',
              kind: 'speech-recognition',
              displayName: 'Speech recognition',
              status: 'installable',
              requiredFor: ['recording'],
              installStrategy: 'runtime-catalog',
              optional: true,
              downloadBytes: 2_800_000_000,
            },
            {
              requirementId: 'speaker-diarization',
              kind: 'speaker-diarization',
              displayName: 'Speakers',
              status: 'installable',
              requiredFor: ['recording'],
              installStrategy: 'runtime-catalog',
              optional: true,
              downloadBytes: 0,
            },
            {
              requirementId: 'text-recognition',
              kind: 'text-recognition',
              displayName: 'Text recognition',
              status: 'installable',
              requiredFor: ['pdf', 'image'],
              installStrategy: 'runtime-catalog',
              downloadBytes: 144_000_000,
            },
            {
              requirementId: 'structuring-runtime',
              kind: 'structuring-runtime',
              displayName: 'Ollama',
              status: 'installable',
              requiredFor: ['runtime'],
              installStrategy: 'winget',
            },
          ] satisfies RuntimeRequirement[]),
        ),
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const root = captureWorkbenchRoot(fixture);
    const sizeOf = (requirementId: string) =>
      root.querySelector(
        `[data-requirement-id="${requirementId}"] [data-testid="capture-download-size"]`,
      );
    expect(sizeOf('speech-recognition')?.textContent).toBe('約 2.8 GB');
    expect(sizeOf('text-recognition')?.textContent).toBe('約 144 MB');
    expect(
      root.querySelector(
        '[data-requirement-id="text-recognition"] [data-testid="capture-unit-guide"]',
      ),
    ).toBeNull();
    expect(sizeOf('speaker-diarization')).toBeNull();
    expect(sizeOf('structuring-runtime')).toBeNull();
    expect(
      root.querySelector(
        '[data-requirement-id="speaker-diarization"] [data-testid="capture-unit-guide"]',
      )?.textContent,
    ).toContain('說話者辨識模型與 CPU 執行環境');

    inputSource.config.set({ identifySpeakers: true, locale: 'en' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(sizeOf('speech-recognition')?.textContent).toBe('~2.8 GB');
    expect(sizeOf('text-recognition')?.textContent).toBe('~144 MB');
    expect(sizeOf('speaker-diarization')).toBeNull();
    expect(sizeOf('structuring-runtime')).toBeNull();
  });

  it('installs OCR before Whisper even when the runtime lists dependencies in reverse order', async () => {
    const requirements: readonly RuntimeRequirement[] = [
      {
        requirementId: 'speech-recognition',
        kind: 'speech-recognition',
        displayName: 'Speech recognition',
        status: 'installable',
        requiredFor: ['recording'],
        installStrategy: 'runtime-catalog',
      },
      {
        requirementId: 'text-recognition',
        kind: 'text-recognition',
        displayName: 'Text recognition',
        status: 'installable',
        requiredFor: ['pdf', 'image'],
        installStrategy: 'runtime-catalog',
      },
    ];
    const startInstallation = vi.fn(
      (request: StartRuntimeInstallationRequest) =>
        of({
          installationId: `install-${request.requirementId}`,
          requirementId: request.requirementId,
          status: 'completed' as const,
          progress: 1,
          createdAt: RAW.createdAt,
          updatedAt: RAW.createdAt,
          completedAt: RAW.createdAt,
        }),
    );
    const client = fakeClient({
      getRequirements: vi.fn(() => of(requirements)),
      startInstallation,
    });
    inputSource.client.set(client);
    inputSource.config.set({ pollIntervalMs: 0 });
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.store.installMissingRequirements();
    await fixture.whenStable();

    expect(
      startInstallation.mock.calls.map(([request]) => request.requirementId),
    ).toEqual(['text-recognition', 'speech-recognition']);
  });

  it('retries an uncertain installation once and leaves the model to model installation', async () => {
    const ollamaRuntime: RuntimeRequirement = {
      requirementId: 'structuring-runtime',
      kind: 'structuring-runtime',
      displayName: 'Ollama',
      status: 'installable',
      requiredFor: ['runtime'],
      installStrategy: 'winget',
    };
    const captureModel: RuntimeRequirement = {
      requirementId: 'structuring-model',
      kind: 'structuring-model',
      displayName: 'Capture model',
      status: 'manual_action_required',
      requiredFor: ['runtime'],
      installStrategy: 'manual',
    };
    const ollamaInstallable: readonly RuntimeRequirement[] = [
      ollamaRuntime,
      captureModel,
    ];
    const modelInstallable: readonly RuntimeRequirement[] = [
      // A stale runtime probe must not cause the already-completed ID to be
      // repeated. The structuring model is installed with a chosen option
      // through model installation, never through a general installation.
      ollamaRuntime,
      { ...captureModel, status: 'installable' },
    ];
    const allReady: readonly RuntimeRequirement[] = [
      { ...ollamaRuntime, status: 'ready' },
      { ...captureModel, status: 'ready' },
    ];
    const getRequirements = vi
      .fn<CaptureClient['getRequirements']>()
      .mockReturnValueOnce(of(ollamaInstallable))
      .mockReturnValueOnce(of(modelInstallable))
      .mockReturnValue(of(allReady));
    const startInstallation = vi
      .fn<CaptureClient['startInstallation']>()
      .mockReturnValueOnce(throwError(() => new TypeError('response was lost')))
      .mockImplementation((request) =>
        of({
          installationId: `install-${request.requirementId}`,
          requirementId: request.requirementId,
          status: 'completed',
          progress: 1,
          createdAt: RAW.createdAt,
          updatedAt: RAW.createdAt,
          completedAt: RAW.createdAt,
        }),
      );
    const client = fakeClient({ getRequirements, startInstallation });
    inputSource.client.set(client);
    inputSource.config.set({
      pollIntervalMs: 0,
    });
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.store.installMissingRequirements();
    await fixture.whenStable();

    expect(startInstallation).toHaveBeenCalledTimes(2);
    const firstRequest = startInstallation.mock.calls[0]?.[0];
    const retryRequest = startInstallation.mock.calls[1]?.[0];
    expect(firstRequest).toBe(retryRequest);
    expect(retryRequest?.clientRequestId).toBe(firstRequest?.clientRequestId);
    expect(firstRequest?.requirementId).toBe('structuring-runtime');
    expect(getRequirements).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.installation()).toBeNull();
  });

  it('does not retry an installation after an abort response', async () => {
    const requirement: RuntimeRequirement = {
      requirementId: 'structuring-runtime',
      kind: 'structuring-runtime',
      displayName: 'Ollama',
      status: 'installable',
      requiredFor: ['runtime'],
      installStrategy: 'winget',
    };
    const startInstallation = vi
      .fn<CaptureClient['startInstallation']>()
      .mockReturnValueOnce(
        throwError(
          () => new DOMException('The operation was aborted.', 'AbortError'),
        ),
      );
    const client = fakeClient({
      getRequirements: vi.fn(() => of([requirement])),
      startInstallation,
    });
    inputSource.client.set(client);
    inputSource.config.set({
      pollIntervalMs: 0,
    });
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.store.installMissingRequirements();
    await fixture.whenStable();

    expect(startInstallation).toHaveBeenCalledOnce();
    expect(client.getInstallation).not.toHaveBeenCalled();
  });
});
