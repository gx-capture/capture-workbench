import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideCaptureWorkbenchInputs } from '../../../contracts';
import type {
  CaptureClient,
  RuntimeRequirementV1,
  StartRuntimeInstallationRequest,
} from '../../../contracts';
import { of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-angular';
import {
  CaptureWorkbenchTestInputSource,
  RAW,
  READY,
  captureWorkbenchRoot,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
} from './capture-angular-test-support';

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
              requirementId: 'ollama-runtime',
              kind: 'runtime',
              displayName: 'Ollama',
              status: 'installable',
              requiredFor: ['runtime'],
              installStrategy: 'winget',
            },
            {
              requirementId: 'capture-ollama-model',
              kind: 'model',
              displayName: 'Capture model',
              status: 'manual_action_required',
              requiredFor: ['runtime'],
              installStrategy: 'manual',
              detail: 'Open Ollama and pull the capture model.',
            },
            {
              requirementId: 'whisper-primary',
              kind: 'stt',
              displayName: 'Whisper',
              status: 'unavailable',
              requiredFor: ['audio'],
              installStrategy: 'none',
              detail: 'Whisper is unavailable.',
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
    ).toEqual(['ollama-runtime', 'capture-ollama-model', 'whisper-primary']);
    const installButton = captureWorkbenchRoot(fixture).querySelector(
      '.runtime-card .primary',
    ) as HTMLButtonElement | null;
    expect(installButton).not.toBeNull();
    installButton?.click();
    await fixture.whenStable();
    expect(client.startInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementId: 'ollama-runtime',
        consent: true,
      }),
      expect.any(AbortSignal),
    );
    expect(client.startInstallation).toHaveBeenCalledTimes(1);
    fixture.detectChanges();
    expect(captureWorkbenchRoot(fixture).textContent).toContain(
      'Manual action is required',
    );
    expect(captureWorkbenchRoot(fixture).textContent).toContain(
      'unavailable on the current system',
    );
  });

  it('presents a core-only release without offering a model install action', async () => {
    const detail =
      'No downloadable model is published for this runtime release.';
    const client = fakeClient({
      getReady: vi.fn(() => of({ ...READY, ready: false })),
      getRequirements: vi.fn(() =>
        of(
          (['windowsml-ocr', 'whisper-primary'] as const).map(
            (requirementId): RuntimeRequirementV1 => ({
              requirementId,
              kind: 'model',
              displayName: requirementId,
              status: 'unavailable',
              requiredFor:
                requirementId === 'windowsml-ocr' ? ['pdf'] : ['audio'],
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

  it('installs OCR before Whisper even when the runtime lists dependencies in reverse order', async () => {
    const requirements: readonly RuntimeRequirementV1[] = [
      {
        requirementId: 'whisper-primary',
        kind: 'stt',
        displayName: 'Whisper',
        status: 'installable',
        requiredFor: ['audio'],
        installStrategy: 'runtime-catalog',
      },
      {
        requirementId: 'windowsml-ocr',
        kind: 'ocr',
        displayName: 'WindowsML OCR',
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
    ).toEqual(['windowsml-ocr', 'whisper-primary']);
  });

  it('retries an uncertain installation once and installs a newly unlocked model', async () => {
    const ollamaRuntime: RuntimeRequirementV1 = {
      requirementId: 'ollama-runtime',
      kind: 'runtime',
      displayName: 'Ollama',
      status: 'installable',
      requiredFor: ['runtime'],
      installStrategy: 'winget',
    };
    const captureModel: RuntimeRequirementV1 = {
      requirementId: 'capture-ollama-model',
      kind: 'model',
      displayName: 'Capture model',
      status: 'manual_action_required',
      requiredFor: ['runtime'],
      installStrategy: 'manual',
    };
    const ollamaInstallable: readonly RuntimeRequirementV1[] = [
      ollamaRuntime,
      captureModel,
    ];
    const modelInstallable: readonly RuntimeRequirementV1[] = [
      // A stale runtime probe must not cause the already-completed ID to be
      // repeated; the newly unlocked model should still be selected.
      ollamaRuntime,
      { ...captureModel, status: 'installable' },
    ];
    const allReady: readonly RuntimeRequirementV1[] = [
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

    expect(startInstallation).toHaveBeenCalledTimes(3);
    const firstRequest = startInstallation.mock.calls[0]?.[0];
    const retryRequest = startInstallation.mock.calls[1]?.[0];
    const modelRequest = startInstallation.mock.calls[2]?.[0];
    expect(firstRequest).toBe(retryRequest);
    expect(retryRequest?.clientRequestId).toBe(firstRequest?.clientRequestId);
    expect(firstRequest?.requirementId).toBe('ollama-runtime');
    expect(modelRequest?.requirementId).toBe('capture-ollama-model');
    expect(modelRequest?.clientRequestId).not.toBe(
      firstRequest?.clientRequestId,
    );
    expect(getRequirements).toHaveBeenCalledTimes(3);
    expect(fixture.componentInstance.installation()).toBeNull();
  });

  it('does not retry an installation after an abort response', async () => {
    const requirement: RuntimeRequirementV1 = {
      requirementId: 'ollama-runtime',
      kind: 'runtime',
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
