import { ComponentFixture, TestBed } from '@angular/core/testing';
import type {
  CaptureClient,
  RuntimeRequirementV1,
  RuntimeInstallationV1,
  StartRuntimeInstallationRequest,
} from '../contracts';
import { CaptureWorkbenchComponent } from './capture-angular';
import { RAW, READY, fakeClient } from './capture-angular-test-support';

describe('CaptureWorkbenchComponent', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  it('starts runtime installation only after explicit user action', async () => {
    const client = fakeClient({
      getReady: vi.fn(async () => ({ ...READY, ready: false })),
      getRequirements: vi.fn(
        async (): Promise<readonly RuntimeRequirementV1[]> => [
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
        ],
      ),
      startInstallation: vi.fn(
        async (
          request: StartRuntimeInstallationRequest,
        ): Promise<RuntimeInstallationV1> => ({
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
    fixture.componentRef.setInput('client', client);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(client.startInstallation).not.toHaveBeenCalled();
    expect(
      Array.from(
        fixture.nativeElement.querySelectorAll(
          '[data-requirement-id]',
        ) as NodeListOf<HTMLElement>,
        (element) => element.dataset['requirementId'],
      ),
    ).toEqual(['ollama-runtime', 'capture-ollama-model', 'whisper-primary']);
    const installButton = fixture.nativeElement.querySelector(
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
    expect(fixture.nativeElement.textContent).toContain(
      'Manual action is required',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'unavailable on the current system',
    );
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
      .mockResolvedValueOnce(ollamaInstallable)
      .mockResolvedValueOnce(modelInstallable)
      .mockResolvedValue(allReady);
    const startInstallation = vi
      .fn<CaptureClient['startInstallation']>()
      .mockRejectedValueOnce(new TypeError('response was lost'))
      .mockImplementation(async (request) => ({
        installationId: `install-${request.requirementId}`,
        requirementId: request.requirementId,
        status: 'completed',
        progress: 1,
        createdAt: RAW.createdAt,
        updatedAt: RAW.createdAt,
        completedAt: RAW.createdAt,
      }));
    const client = fakeClient({ getRequirements, startInstallation });
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('config', {
      pollIntervalMs: 0,
    });
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.installMissingRequirements();

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
    expect(getRequirements).toHaveBeenCalledTimes(4);
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
      .mockRejectedValueOnce(
        new DOMException('The operation was aborted.', 'AbortError'),
      );
    const client = fakeClient({
      getRequirements: vi.fn(async () => [requirement]),
      startInstallation,
    });
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('config', {
      pollIntervalMs: 0,
    });
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.installMissingRequirements();

    expect(startInstallation).toHaveBeenCalledOnce();
    expect(client.getInstallation).not.toHaveBeenCalled();
  });
});
