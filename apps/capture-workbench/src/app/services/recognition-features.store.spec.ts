import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { of, Subject, throwError } from 'rxjs';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopInstallationService } from './desktop-installation.service';
import { RecognitionFeaturesStore } from './recognition-features.store';

describe('RecognitionFeaturesStore removeRequirement', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('uninstalls a ready requirement and reports it not installed before the list reloads', () => {
    const { store, runtime, pending, listed } = createHarness();
    expect(store.ocrReady()).toBe(true);

    store.removeRequirement('windowsml-ocr');
    store.removeRequirement('windowsml-ocr');
    expect(store.isRemoving('windowsml-ocr')).toBe(true);
    expect(runtime.uninstallRequirement).toHaveBeenCalledTimes(1);
    expect(runtime.uninstallRequirement).toHaveBeenCalledWith('windowsml-ocr');

    pending.next(requirement('windowsml-ocr', 'installable', 144_000_000));
    pending.complete();
    TestBed.tick();

    expect(store.isRemoving('windowsml-ocr')).toBe(false);
    expect(store.removalError('windowsml-ocr')).toBeNull();
    expect(requirementStatus(store)).toBe('installable');
    expect(store.ocrReady()).toBe(false);
    expect(runtime.reload).toHaveBeenCalled();

    listed.set([requirement('windowsml-ocr', 'installable', 144_000_000)]);
    store.requirementsResource.reload();
    TestBed.tick();
    expect(requirementStatus(store)).toBe('installable');
    expect(store.ocrReady()).toBe(false);

    store.removeRequirement('windowsml-ocr');
    expect(runtime.uninstallRequirement).toHaveBeenCalledTimes(1);
  });

  it('does not call the runtime while that requirement is installing', () => {
    const { store, runtime, installation } = createHarness();
    installation.installationsByRequirement.set(
      new Map([['windowsml-ocr', runningInstallation('running')]]),
    );

    store.removeRequirement('windowsml-ocr');

    expect(runtime.uninstallRequirement).not.toHaveBeenCalled();
    expect(store.isRemoving('windowsml-ocr')).toBe(false);
    expect(requirementStatus(store)).toBe('ready');
    expect(store.ocrReady()).toBe(true);
  });

  it('keeps the runtime status and shows a readable error when removal is refused', () => {
    const { store, runtime, pending } = createHarness();
    store.removeRequirement('windowsml-ocr');
    pending.error(
      new Error('Capture Runtime request was rejected with HTTP 409.'),
    );
    TestBed.tick();

    expect(store.isRemoving('windowsml-ocr')).toBe(false);
    expect(requirementStatus(store)).toBe('ready');
    expect(store.ocrReady()).toBe(true);
    expect(store.removalError('windowsml-ocr')).toBe(
      '安裝或辨識還在進行，請稍後再移除',
    );
    expect(runtime.reload).not.toHaveBeenCalled();
  });

  it('lets a finished reinstall leave the not-installed overlay', () => {
    const { store, runtime, pending } = createHarness();
    store.removeRequirement('windowsml-ocr');
    pending.next(requirement('windowsml-ocr', 'installable', 144_000_000));
    pending.complete();
    TestBed.tick();
    expect(requirementStatus(store)).toBe('installable');

    store.installRequirement('windowsml-ocr');
    TestBed.tick();

    expect(runtime.startInstallation).toHaveBeenCalled();
    expect(requirementStatus(store)).toBe('ready');
    expect(store.ocrReady()).toBe(true);
  });

  it('returns an empty list without throwing when model options fail to load', () => {
    const { store } = createHarness({
      getModelOptions: vi.fn(() => throwError(() => new Error('model options failed'))),
    });

    expect(store.modelOptionsResource.status()).toBe('error');
    expect(() => store.modelOptions()).not.toThrow();
    expect(store.modelOptions()).toEqual([]);
    expect(store.activeModelOption()).toBeNull();
    expect(store.modelSelectionRequired()).toBe(false);
  });

  it('returns an empty list without throwing when requirements fail to load', () => {
    const { store } = createHarness({
      getRequirements: vi.fn(() => throwError(() => new Error('requirements failed'))),
    });

    expect(store.requirementsResource.status()).toBe('error');
    expect(() => store.requirements()).not.toThrow();
    expect(store.requirements()).toEqual([]);
    expect(store.recognitionRequirements()).toEqual([]);
    expect(store.firstRunInstallableRequirements()).toEqual([]);
    expect(store.ocrReady()).toBe(false);
    expect(store.asrReady()).toBe(false);
  });
});

function createHarness(
  runtimeOverrides: Partial<{
    getRequirements: ReturnType<typeof vi.fn>;
    getModelOptions: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const listed = signal<readonly RuntimeRequirement[]>([
    requirement('windowsml-ocr', 'ready', 144_000_000),
  ]);
  const pending = new Subject<RuntimeRequirement>();
  const runtime = {
    started: signal(true),
    getRequirements: vi.fn(() => of(listed())),
    getModelOptions: vi.fn(() => of([])),
    listInstallations: vi.fn(() => of([])),
    uninstallRequirement: vi.fn(() => pending.asObservable()),
    startInstallation: vi.fn(() => of(runningInstallation('completed'))),
    getInstallation: vi.fn(),
    cancelInstallation: vi.fn(() => of(runningInstallation('cancelled'))),
    reload: vi.fn(),
    ...runtimeOverrides,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopRuntimeClientService, useValue: runtime },
      RecognitionFeaturesStore,
    ],
  });
  const store = TestBed.inject(RecognitionFeaturesStore);
  const installation = TestBed.inject(DesktopInstallationService);
  TestBed.tick();
  return { store, runtime, pending, listed, installation };
}

function requirementStatus(store: RecognitionFeaturesStore): string | undefined {
  return store
    .requirements()
    .find((item) => item.requirementId === 'windowsml-ocr')?.status;
}

function requirement(
  requirementId: RuntimeRequirement['requirementId'],
  status: RuntimeRequirement['status'],
  downloadBytes: number,
): RuntimeRequirement {
  return {
    requirementId,
    displayName: requirementId,
    status,
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'runtime-catalog',
    detail: null,
    downloadBytes,
  };
}

function runningInstallation(
  status: RuntimeInstallation['status'],
): RuntimeInstallation {
  return {
    installationId: 'inst-ocr-1',
    requirementId: 'windowsml-ocr',
    status,
    progress: status === 'completed' ? 1 : 0.4,
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
  };
}
