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
import { selectRecognitionEngines } from '../services/desktop-workspace.selectors';
import { DesktopWorkspaceStore } from '../services/desktop-workspace.store';
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
    const { fixture, removeUnit } = await renderEngines();
    const row = engineRow(fixture.nativeElement, 'windowsml-ocr');
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
    expect(removeUnit).not.toHaveBeenCalled();
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
    const { fixture, removeUnit } = await renderEngines();
    const row = engineRow(fixture.nativeElement, 'windowsml-ocr');
    (row.querySelector('[data-testid="engine-row-remove"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const dialog = removeDialog();
    (dialog.querySelector('[data-testid="engine-remove-confirm"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(removeUnit).toHaveBeenCalledTimes(1);
    expect(removeUnit).toHaveBeenCalledWith('windowsml-ocr');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('disables removal while that unit is installing', async () => {
    const { fixture, removeUnit } = await renderEngines({
      installation: {
        installationId: 'inst-ocr-1',
        requirementId: 'windowsml-ocr',
        status: 'running',
        progress: 0.2,
        createdAt: '2026-11-10T00:00:00Z',
        updatedAt: '2026-11-10T00:00:00Z',
      },
    });
    const row = engineRow(fixture.nativeElement, 'windowsml-ocr');
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
    expect(removeUnit).not.toHaveBeenCalled();
  });

  it('disables removal while a capture that needs the engine is running', async () => {
    const { fixture, removeUnit } = await renderEngines({
      documents: [libraryDocument('processing', 'application/pdf')],
    });
    const row = engineRow(fixture.nativeElement, 'windowsml-ocr');
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
    expect(removeUnit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('shows removal in progress on the row', async () => {
    const { fixture } = await renderEngines({ removingId: 'windowsml-ocr' });
    const row = engineRow(fixture.nativeElement, 'windowsml-ocr');
    expect(row.querySelector('[data-testid="engine-row-removing"]')?.textContent).toContain(
      '正在移除',
    );
    expect(row.querySelector('[data-testid="engine-row-remove"]')).toBeNull();
  });

  it('shows a removal failure on that row', async () => {
    const { fixture } = await renderEngines({
      removalError: '安裝或辨識還在進行，請稍後再移除',
    });
    const alert = engineRow(fixture.nativeElement, 'windowsml-ocr').querySelector(
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
  } = {},
) {
  const requirements = signal<readonly RuntimeRequirement[]>([
    requirement('windowsml-ocr', 'ready', 144_000_000),
    requirement('speech-recognition', 'installable', 2_800_000_000),
  ]);
  const removeUnit = vi.fn();
  await TestBed.configureTestingModule({
    imports: [EnginesPage],
    providers: [
      provideNoopAnimations(),
      {
        provide: RecognitionFeaturesStore,
        useValue: {
          engines: computed(() => selectRecognitionEngines(requirements())),
          installing: signal(false),
          installationFor: (requirementId: CaptureRequirementId) =>
            options.installation?.requirementId === requirementId
              ? options.installation
              : null,
          isRemoving: (requirementId: CaptureRequirementId) =>
            options.removingId === requirementId,
          removalError: (requirementId: CaptureRequirementId) =>
            requirementId === 'windowsml-ocr' ? (options.removalError ?? null) : null,
          removeUnit,
          cancelInstallation: vi.fn(),
          retryInstallation: vi.fn(),
          installUnit: vi.fn(),
        },
      },
      {
        provide: DesktopWorkspaceStore,
        useValue: { allDocuments: signal(options.documents ?? []) },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(EnginesPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, removeUnit };
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
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'automatic',
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
