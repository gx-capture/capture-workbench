import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import type { DesktopLibrarySummary, OcrEvidenceV1 } from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

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
  it('passes a native path to the private Rust import command without browser byte allocation', async () => {
    const { commands, service } = configure();
    const sourcePath = String.raw`C:\private\fixture.pdf`;

    const imported = await firstValueFrom(service.createSource(sourcePath));

    expect(commands.invoke).toHaveBeenCalledWith('library_import_source', {
      request: { sourcePath },
    });
    expect(imported).toEqual(summary);
    expect(JSON.stringify(imported)).not.toContain(sourcePath);
  });

  it('keeps ordinary library responses path-free', async () => {
    const { service } = configure();

    const imported = await firstValueFrom(
      service.createSource(String.raw`C:\private\scan.png`),
    );

    expect(imported).not.toHaveProperty('sourcePath');
    expect(imported.fileName).toBe('fixture.pdf');
  });

  it('redacts credential-shaped persisted error fields before the UI sees them', async () => {
    const { service } = configure({
      errorMessage: 'Bearer secret-token',
      recoveryMessage: 'token=secret-token',
    });

    const imported = await firstValueFrom(
      service.createSource(String.raw`C:\private\scan.png`),
    );

    expect(imported.errorMessage).toBe('Bearer [redacted]');
    expect(imported.recoveryMessage).toBe('token= [redacted]');
    expect(JSON.stringify(imported)).not.toContain('secret-token');
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
