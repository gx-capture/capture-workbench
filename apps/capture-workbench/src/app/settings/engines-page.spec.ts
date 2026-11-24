import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import type {
  CaptureRequirementId,
  RuntimeInstallation,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { selectRecognitionRequirements } from '../services/recognition-requirements';
import { LibraryStore } from '../services/library.store';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';
import { EnginesPage } from './engines-page';

describe('EnginesPage removal', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  afterEach(() => {
    document.body.querySelectorAll('.cdk-overlay-container').forEach((node) => {
      node.remove();
    });
  });

  it('asks for confirmation with the size, and cancel leaves the engine installed', async () => {
    const { fixture, removeRequirement } = await renderEngines();
    const row = engineRow(fixture.nativeElement, 'text-recognition');
    (row.querySelector('[data-testid="engine-row-remove"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const dialog = removeDialog();
    expect(dialog.textContent).toContain('移除文字辨識？');
    expect(dialog.textContent).toContain('約 144 MB');
    expect(dialog.textContent).toContain('已經做好的文件和逐字稿會留在這台電腦');

    (dialog.querySelector('[data-testid="engine-remove-cancel"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(removeRequirement).not.toHaveBeenCalled();
    expect(row.querySelector('[data-testid="engine-row-status"]')?.textContent).toContain(
      '已安裝',
    );
    expect(
      engineRow(fixture.nativeElement, 'speech-recognition').querySelector(
        '[data-testid="engine-row-remove"]',
      ),
    ).toBeNull();
  });

  it('removes the engine only after the user confirms', async () => {
    const { fixture, removeRequirement } = await renderEngines();
    const row = engineRow(fixture.nativeElement, 'text-recognition');
    (row.querySelector('[data-testid="engine-row-remove"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const dialog = removeDialog();
    (dialog.querySelector('[data-testid="engine-remove-confirm"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(removeRequirement).toHaveBeenCalledTimes(1);
    expect(removeRequirement).toHaveBeenCalledWith('text-recognition');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('disables removal while that requirement is installing', async () => {
    const { fixture, removeRequirement } = await renderEngines({
      installation: {
        installationId: 'inst-ocr-1',
        requirementId: 'text-recognition',
        status: 'running',
        progress: 0.2,
        createdAt: '2026-11-10T00:00:00Z',
        updatedAt: '2026-11-10T00:00:00Z',
      },
    });
    const row = engineRow(fixture.nativeElement, 'text-recognition');
    const button = row.querySelector(
      '[data-testid="engine-row-remove"]',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(row.querySelector('[data-testid="engine-row-remove-reason"]')?.textContent).toContain(
      '這項功能正在安裝',
    );
    expect(row.querySelector('[data-testid="engine-row-cancel"]')).not.toBeNull();
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(removeRequirement).not.toHaveBeenCalled();
  });

  it('keeps the row progress with a hint while status requests fail', async () => {
    const { fixture } = await renderEngines({
      installation: {
        installationId: 'inst-speech-1',
        requirementId: 'speech-recognition',
        status: 'running',
        progress: 0.2,
        createdAt: '2026-11-10T00:00:00Z',
        updatedAt: '2026-11-10T00:00:00Z',
      },
      progressUnavailable: 'speech-recognition',
    });
    const row = engineRow(fixture.nativeElement, 'speech-recognition');
    const progress = row.querySelector('[data-testid="engine-row-progress"]');
    expect(progress?.querySelector('[data-testid="install-progress-bar"]')).not.toBeNull();
    expect(progress?.querySelector('[data-testid="install-progress-retrying"]')?.textContent).toContain(
      '暫時無法取得安裝進度，持續重試中。',
    );
    expect(engineRow(fixture.nativeElement, 'text-recognition').querySelector(
      '[data-testid="install-progress-retrying"]',
    )).toBeNull();
  });

  it('disables removal while a capture that needs the engine is running', async () => {
    const { fixture, removeRequirement } = await renderEngines({
      documents: [libraryDocument('processing', 'application/pdf')],
    });
    const row = engineRow(fixture.nativeElement, 'text-recognition');
    const button = row.querySelector(
      '[data-testid="engine-row-remove"]',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(row.querySelector('[data-testid="engine-row-remove-reason"]')?.textContent).toContain(
      '有辨識正在使用它',
    );
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(removeRequirement).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('shows removal in progress on the row', async () => {
    const { fixture } = await renderEngines({ removingId: 'text-recognition' });
    const row = engineRow(fixture.nativeElement, 'text-recognition');
    expect(row.querySelector('[data-testid="engine-row-removing"]')?.textContent).toContain(
      '正在移除',
    );
    expect(row.querySelector('[data-testid="engine-row-remove"]')).toBeNull();
  });

  it('shows a removal failure on that row', async () => {
    const { fixture } = await renderEngines({
      removalError: '安裝或辨識還在進行，請稍後再移除',
    });
    const alert = engineRow(fixture.nativeElement, 'text-recognition').querySelector(
      '[data-testid="engine-row-remove-error"]',
    );
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('安裝或辨識還在進行，請稍後再移除');
  });
});

async function renderEngines(
  options: {
    readonly installation?: RuntimeInstallation | null;
    readonly documents?: readonly DesktopLibrarySummary[];
    readonly removingId?: CaptureRequirementId;
    readonly removalError?: string | null;
    readonly progressUnavailable?: CaptureRequirementId;
  } = {},
) {
  const requirements = signal<readonly RuntimeRequirement[]>([
    requirement('text-recognition', 'ready', 144_000_000),
    requirement('speech-recognition', 'installable', 2_800_000_000),
  ]);
  const removeRequirement = vi.fn();
  await TestBed.configureTestingModule({
    imports: [EnginesPage],
    providers: [
      provideNoopAnimations(),
      {
        provide: RecognitionFeaturesStore,
        useValue: {
          recognitionRequirements: computed(() => selectRecognitionRequirements(requirements())),
          installing: signal(false),
          startingRequirementId: signal(null),
          isProgressUnavailable: (requirementId: CaptureRequirementId) =>
            options.progressUnavailable === requirementId,
          installationFor: (requirementId: CaptureRequirementId) =>
            options.installation?.requirementId === requirementId
              ? options.installation
              : null,
          isRemoving: (requirementId: CaptureRequirementId) =>
            options.removingId === requirementId,
          removalError: (requirementId: CaptureRequirementId) =>
            requirementId === 'text-recognition' ? (options.removalError ?? null) : null,
          removeRequirement,
          cancelInstallation: vi.fn(),
          retryInstallation: vi.fn(),
          installRequirement: vi.fn(),
        },
      },
      {
        provide: LibraryStore,
        useValue: { allDocuments: signal(options.documents ?? []) },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(EnginesPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, removeRequirement };
}

function engineRow(page: HTMLElement, requirementId: string): HTMLElement {
  const found = page.querySelector(
    `[data-testid="engine-row"][data-requirement-id="${requirementId}"]`,
  );
  if (!(found instanceof HTMLElement)) {
    throw new Error(`Missing engine row ${requirementId}`);
  }
  return found;
}

function removeDialog(): HTMLElement {
  const found = document.querySelector('[role="alertdialog"]');
  if (!(found instanceof HTMLElement)) throw new Error('Missing remove dialog');
  return found;
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
    kind: requirementId,
    requiredFor: ['capture'],
    installStrategy: 'runtime-catalog',
    detail: null,
    downloadBytes,
  };
}

function libraryDocument(
  status: DesktopLibrarySummary['status'],
  mediaType: string,
): DesktopLibrarySummary {
  return {
    documentId: 'b'.repeat(32),
    fileName: 'charge.pdf',
    mediaType,
    byteLength: 8,
    createdAtMs: 1,
    updatedAtMs: 1,
    status,
  };
}
