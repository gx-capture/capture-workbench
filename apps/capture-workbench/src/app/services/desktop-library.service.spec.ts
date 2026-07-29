import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import type { DesktopLibrarySummary } from '../contracts';
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
});

function configure() {
  const commands = {
    invoke: vi.fn(() => of(summary)),
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
