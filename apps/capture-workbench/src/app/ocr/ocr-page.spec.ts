import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { RuntimeInstallation, RuntimeRequirement } from '@gx-capture/capture-workbench-ui';
import { of } from 'rxjs';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { CaptureQueueStore } from '../services/capture-queue.store';
import { DesktopLibraryService } from '../services/desktop-library.service';
import { DesktopRuntimeClientService } from '../services/desktop-runtime-client.service';
import { DesktopWorkspaceCaptureService } from '../services/desktop-workspace-capture.service';
import { isFeatureReady, type RecognitionFeature } from '../services/desktop-workspace.selectors';
import { DesktopWorkspaceStore } from '../services/desktop-workspace.store';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';
import type { DesktopLibrarySummary } from '../contracts';
import { OcrPage } from './ocr-page';

describe('OcrPage queue', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('shows a waiting install prompt from downloadBytes and exports only when raw text exists', async () => {
    const requirements = signal<readonly RuntimeRequirement[]>([
      requirement('windowsml-ocr', 'installable', 144_000_000),
    ]);
    const installUnit = vi.fn();
    const documents = [
      doc({ documentId: 'b'.repeat(32), fileName: 'charge.pdf', status: 'queued' }),
      doc({
        documentId: 'c'.repeat(32),
        fileName: 'done.pdf',
        status: 'awaiting_confirmation',
        hasRaw: true,
      }),
      doc({
        documentId: 'd'.repeat(32),
        fileName: 'empty.pdf',
        status: 'completed',
        hasRaw: false,
      }),
    ];
    TestBed.configureTestingModule({
      imports: [OcrPage],
      providers: [
        provideRouter([]),
        { provide: DesktopLibraryService, useValue: { list: () => of(documents), get: vi.fn() } },
        {
          provide: DesktopRuntimeClientService,
          useValue: {
            started: signal(true),
            ready: signal(true),
            pdfPageNumbers: signal(undefined),
            ocrCompute: signal(null),
          },
        },
        {
          provide: RecognitionFeaturesStore,
          useValue: {
            requirements,
            installations: signal({}),
            installing: signal(false),
            firstRunDismissed: signal(true),
            firstRunInstallableUnits: signal([]),
            showFirstRunCard: signal(false),
            activeInstallation: signal<RuntimeInstallation | null>(null),
            isFeatureReady: (feature: RecognitionFeature) => isFeatureReady(requirements(), feature),
            installUnit,
            installFirstRunSelection: vi.fn(),
            cancelInstallation: vi.fn(),
            dismissFirstRun: vi.fn(),
            requestedRequirements: signal(new Set()),
          },
        },
        {
          provide: DesktopWorkspaceStore,
          useValue: { allDocuments: signal(documents), refreshDocuments: vi.fn() },
        },
        DesktopWorkspaceCaptureService,
        CaptureQueueStore,
      ],
    });

    const fixture = TestBed.createComponent(OcrPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('[data-testid="ocr-dropzone"]')?.textContent).toContain('拖曳 PDF 或圖片到這裡');
    expect(page.querySelector('[data-testid="ocr-vertical-japanese"]')).toBeNull();
    expect(page.querySelector('[data-testid="ocr-file-input"]')).toBeNull();
    const waiting = row(page, 'charge.pdf');
    expect(waiting.textContent).toContain('需要文字辨識（約 144 MB）');
    expect(waiting.querySelector('[data-testid="ocr-row-install"]')).not.toBeNull();

    (waiting.querySelector('[data-testid="ocr-row-install"]') as HTMLButtonElement).click();
    expect(installUnit).toHaveBeenCalledWith('windowsml-ocr');

    const doneExport = row(page, 'done.pdf').querySelector(
      '[data-testid="ocr-row-export-txt"]',
    ) as HTMLButtonElement;
    const emptyExport = row(page, 'empty.pdf').querySelector(
      '[data-testid="ocr-row-export-txt"]',
    ) as HTMLButtonElement;
    expect(doneExport.disabled).toBe(false);
    expect(emptyExport.disabled).toBe(true);
    expect(row(page, 'done.pdf').querySelector('[data-testid="ocr-row-view"]')?.getAttribute('href'))
      .toBe('/history');
  });

  it('shows the install percentage on a waiting row and hides the install button', async () => {
    const requirements = signal<readonly RuntimeRequirement[]>([
      requirement('windowsml-ocr', 'installable', 144_000_000),
    ]);
    TestBed.configureTestingModule({
      imports: [OcrPage],
      providers: [
        provideRouter([]),
        {
          provide: DesktopLibraryService,
          useValue: {
            list: () => of([doc({ fileName: 'charge.pdf', status: 'queued' })]),
            get: vi.fn(),
          },
        },
        {
          provide: DesktopRuntimeClientService,
          useValue: { started: signal(true), ready: signal(true), pdfPageNumbers: signal(undefined), ocrCompute: signal(null) },
        },
        {
          provide: RecognitionFeaturesStore,
          useValue: {
            requirements,
            installing: signal(true),
            firstRunDismissed: signal(true),
            firstRunInstallableUnits: signal([]),
            showFirstRunCard: signal(false),
            activeInstallation: signal({
              installationId: 'inst-1',
              requirementId: 'windowsml-ocr',
              status: 'running',
              progress: 0.4,
              createdAt: '2026-11-10T00:00:00Z',
              updatedAt: '2026-11-10T00:00:00Z',
            } as RuntimeInstallation),
            isFeatureReady: (feature: RecognitionFeature) => isFeatureReady(requirements(), feature),
            installUnit: vi.fn(),
            installFirstRunSelection: vi.fn(),
            cancelInstallation: vi.fn(),
            dismissFirstRun: vi.fn(),
            requestedRequirements: signal(new Set()),
          },
        },
        {
          provide: DesktopWorkspaceStore,
          useValue: {
            allDocuments: signal([doc({ fileName: 'charge.pdf', status: 'queued' })]),
            refreshDocuments: vi.fn(),
          },
        },
        DesktopWorkspaceCaptureService,
        CaptureQueueStore,
      ],
    });

    const fixture = TestBed.createComponent(OcrPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const waiting = row(fixture.nativeElement as HTMLElement, 'charge.pdf');
    expect(waiting.querySelector('[data-testid="ocr-row-install"]')).toBeNull();
    expect(waiting.querySelector('[data-testid="ocr-row-install-progress"]')?.textContent).toContain('40%');
  });
});

function row(page: HTMLElement, fileName: string): HTMLElement {
  const found = [...page.querySelectorAll('[data-testid="ocr-queue-row"]')]
    .find((item) => item.textContent?.includes(fileName));
  if (!(found instanceof HTMLElement)) throw new Error(`Missing row ${fileName}`);
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

function doc(partial: Partial<DesktopLibrarySummary>): DesktopLibrarySummary {
  return {
    documentId: 'b'.repeat(32),
    fileName: 'charge.pdf',
    mediaType: 'application/pdf',
    byteLength: 8,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: 'queued',
    ...partial,
  };
}
