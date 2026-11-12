import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import type { DesktopLibrarySummary, OcrEvidenceV1 } from '../contracts';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';
import { DESKTOP_MESSAGES, desktopLocale } from '../i18n/desktop-messages';
import { selectionRejectionMessages } from './source-selection-messages';

const summary: DesktopLibrarySummary = {
  documentId: 'a'.repeat(32),
  fileName: 'fixture.pdf',
  mediaType: 'application/pdf',
  byteLength: 16,
  createdAtMs: 1,
  updatedAtMs: 1,
  status: 'queued',
};

describe('DesktopLibraryService native source import', () => {
  it('groups rejection reasons with counts in both languages', () => {
    const previous = desktopLocale();
    try {
      for (const locale of ['zh-TW', 'en'] as const) {
        desktopLocale.set(locale);
        const messages = selectionRejectionMessages({
          selections: [], rejected: ['unsupported', 'empty', 'unsupported', 'notLocal'],
        });
        expect(messages).toEqual([
          DESKTOP_MESSAGES[locale].sourceRejections.unsupported(2),
          DESKTOP_MESSAGES[locale].sourceRejections.empty(1),
          DESKTOP_MESSAGES[locale].sourceRejections.notLocal(1),
        ]);
      }
    } finally {
      desktopLocale.set(previous);
    }
  });
  it('passes only the selection token to the private Rust import command', async () => {
    const { commands, service } = configure();
    const selectionTokenInput = selection('fixture.pdf');

    const imported = await firstValueFrom(service.importSelection(selectionTokenInput));

    expect(commands.invoke).toHaveBeenCalledWith('library_import_selection', {
      request: { selectionToken: selectionTokenInput.selectionToken },
    });
    expect(imported).toEqual(summary);
  });

  it('sends the selection token together with the page-count option', async () => {
    const { commands, service } = configure();
    const selectionTokenInput = selection('charge.pdf');

    await firstValueFrom(service.importSelection(selectionTokenInput, { pdfPageCount: 3 }));

    expect(commands.invoke).toHaveBeenCalledWith('library_import_selection', {
      request: {
        selectionToken: selectionTokenInput.selectionToken,
        captureOptions: { pdfPageCount: 3 },
      },
    });
  });

  it('keeps ordinary library responses path-free', async () => {
    const { service } = configure();

    const imported = await firstValueFrom(
      service.importSelection(selection('scan.png')),
    );

    expect(Object.keys(imported)).not.toContain('path');
    expect(imported.fileName).toBe('fixture.pdf');
  });

  it('redacts credential-shaped persisted error fields before the UI sees them', async () => {
    const { service } = configure({
      errorMessage: 'Bearer secret-token',
      recoveryMessage: 'token=secret-token',
    });

    const imported = await firstValueFrom(
      service.importSelection(selection('scan.png')),
    );

    expect(imported.errorMessage).toBe('Bearer [redacted]');
    expect(imported.recoveryMessage).toBe('token= [redacted]');
    expect(JSON.stringify(imported)).not.toContain('secret-token');
  });

  it('routes picker, native channel and explicit discard through token commands', async () => {
    const { commands, service } = configure();
    await firstValueFrom(service.selectSources('documents'));
    expect(commands.invoke).toHaveBeenCalledWith('library_select_sources', { request: { kind: 'documents' } });
    await firstValueFrom(service.droppedSources());
    expect(commands.watch).toHaveBeenCalledWith('library_watch_native_sources', 'onEvent');
    await firstValueFrom(service.discardSelections([selection('scan.png')]));
    expect(commands.invoke).toHaveBeenCalledWith('library_discard_selections', { request: { selectionTokens: [selection('scan.png').selectionToken] } });
  });
  it('passes privacy-safe OCR evidence through the existing capture update command', async () => {
    const { commands, service } = configure();
    const ocrEvidence = { schemaVersion: 1 } as OcrEvidenceV1;
    const update = {
      documentId: summary.documentId,
      status: 'completed' as const,
      ocrEvidence,
    };

    await firstValueFrom(service.updateCapture(update));

    expect(commands.invoke).toHaveBeenCalledWith('library_update_capture', {
      update,
    });
  });
});

function configure(response: Partial<DesktopLibrarySummary> = {}) {
  const commands = {
    watch: vi.fn(() => of({ selections: [], rejected: [] })),
    invoke: vi.fn(() => of({ ...summary, ...response })),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopTauriCommandService, useValue: commands },
      DesktopLibraryService,
    ],
  });
  return {
    commands,
    service: TestBed.inject(DesktopLibraryService),
  };
}

function selection(fileName: string): DesktopSourceSelection {
  return { selectionToken: fileName.padEnd(32, '0'), fileName, byteLength: 16,
    mediaType: fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.wav') ? 'audio/wav' : 'application/pdf' };
}
