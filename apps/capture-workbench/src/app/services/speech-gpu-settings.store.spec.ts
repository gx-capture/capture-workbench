import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import type { OcrComputePreflight } from '@gx-capture/capture-workbench-ui';
import type { DesktopSpeechGpuStatus } from '../contracts';
import { SpeechGpuSettingsStore } from './speech-gpu-settings.store';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceCaptureService } from './desktop-workspace-capture.service';
import { RecognitionFeaturesStore } from './recognition-features.store';

describe('SpeechGpuSettingsStore', () => {
  it('offers the GPU setting only when a CUDA driver is present', () => {
    const cpuStore = setupComputeStore({
      getComputeStatus: vi.fn(() => of({ cudaAvailable: false, preferGpu: true })),
    });
    expect(cpuStore.store.speechStatus()).toEqual({
      cudaAvailable: false,
      preferGpu: true,
    });
    expect(cpuStore.store.speechGpu()).toBeNull();

    TestBed.resetTestingModule();

    const gpuStore = setupComputeStore({
      getComputeStatus: vi.fn(() => of({ cudaAvailable: true, preferGpu: true })),
    });
    expect(gpuStore.store.speechGpu()).toEqual({
      cudaAvailable: true,
      preferGpu: true,
    });
  });

  it('disables changing compute while a capture or installation is active', () => {
    const setPreferGpu = vi.fn(() => of({ cudaAvailable: true, preferGpu: false }));
    const { store, busyIds, installing } = setupComputeStore({
      getComputeStatus: vi.fn(() => of({ cudaAvailable: true, preferGpu: true })),
      setPreferGpu,
    });

    expect(store.canChangeCompute()).toBe(true);

    busyIds.set(new Set(['doc-1']));
    expect(store.canChangeCompute()).toBe(false);
    store.setPreferGpu(false);
    expect(setPreferGpu).not.toHaveBeenCalled();

    busyIds.set(new Set());
    installing.set(true);
    expect(store.canChangeCompute()).toBe(false);
    store.setPreferGpu(false);
    expect(setPreferGpu).not.toHaveBeenCalled();
  });

  it('tracks saving state while updating the GPU preference and reloads runtime on success', () => {
    const saved: DesktopSpeechGpuStatus = { cudaAvailable: true, preferGpu: false };
    const pending = new Subject<DesktopSpeechGpuStatus>();
    const getComputeStatus = vi.fn(() => of({ cudaAvailable: true, preferGpu: true }));
    const setPreferGpu = vi.fn(() => pending);
    const { store, runtime, features } = setupComputeStore({
      getComputeStatus,
      setPreferGpu,
    });

    store.setPreferGpu(true);
    expect(setPreferGpu).not.toHaveBeenCalled();

    store.setPreferGpu(false);
    expect(setPreferGpu).toHaveBeenCalledWith(false);
    expect(store.savingCompute()).toBe(true);
    expect(store.canChangeCompute()).toBe(false);

    getComputeStatus.mockReturnValue(of(saved));
    pending.next(saved);
    pending.complete();
    TestBed.tick();

    expect(store.savingCompute()).toBe(false);
    expect(store.canChangeCompute()).toBe(true);
    expect(runtime.reload).toHaveBeenCalledTimes(1);
    expect(features.initialize).toHaveBeenCalledTimes(1);
    expect(store.speechGpu()).toEqual(saved);
    expect(store.error()).toBeNull();
  });

  it('reports an error and reloads compute status when saving fails', () => {
    const getComputeStatus = vi.fn(() => of({ cudaAvailable: true, preferGpu: true }));
    const setPreferGpu = vi.fn(() => throwError(() => new Error('save failed')));
    const { store, runtime } = setupComputeStore({
      getComputeStatus,
      setPreferGpu,
    });

    store.setPreferGpu(false);
    TestBed.tick();

    expect(store.savingCompute()).toBe(false);
    expect(store.error()).toBe('save failed');
    expect(runtime.reload).not.toHaveBeenCalled();
    expect(getComputeStatus).toHaveBeenCalledTimes(2);
  });
});

function setupComputeStore(overrides: {
  readonly getComputeStatus?: ReturnType<typeof vi.fn>;
  readonly setPreferGpu?: ReturnType<typeof vi.fn>;
}) {
  const busyIds = signal<ReadonlySet<string>>(new Set());
  const installing = signal(false);
  const runtime = {
    ocrCompute: signal<OcrComputePreflight | null>(null),
    getComputeStatus:
      overrides.getComputeStatus ??
      vi.fn(() => of({ cudaAvailable: false, preferGpu: true })),
    setPreferGpu: overrides.setPreferGpu ?? vi.fn(),
    reload: vi.fn(),
  };
  const features = {
    installing,
    initialize: vi.fn(),
  };
  const captureLifecycle = {
    busyIds,
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopRuntimeClientService, useValue: runtime },
      { provide: RecognitionFeaturesStore, useValue: features },
      { provide: DesktopWorkspaceCaptureService, useValue: captureLifecycle },
      SpeechGpuSettingsStore,
    ],
  });

  const store = TestBed.inject(SpeechGpuSettingsStore);
  TestBed.tick();
  return { store, runtime, features, busyIds, installing };
}
