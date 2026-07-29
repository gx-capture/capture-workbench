import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import type { DesktopLibrarySummary } from '../contracts';
import {
  DesktopLibraryService,
  MAX_DESKTOP_SOURCE_BYTES,
} from './desktop-library.service';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

const summary: DesktopLibrarySummary = {
  documentId: 'a'.repeat(32),
  fileName: 'fixture.pdf',
  mediaType: 'application/pdf',
  byteLength: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
  status: 'queued',
};

describe('DesktopLibraryService source validation', () => {
  it.each([
    ['application/pdf', 'fixture.pdf'],
    ['image/png', 'fixture.png'],
    ['image/jpeg', 'fixture.jpg'],
    ['audio/wav', 'fixture.wav'],
    ['audio/mpeg', 'fixture.mp3'],
    ['audio/mp4', 'fixture.m4a'],
  ])('accepts %s before invoking the native library', async (mediaType, fileName) => {
    const { commands, service } = configure();
    const source = fakeFile({ fileName, mediaType, size: 1 });

    await firstValueFrom(service.createSource(source.file));

    expect(source.arrayBuffer).toHaveBeenCalledOnce();
    expect(commands.invoke).toHaveBeenCalledWith('library_create_source', {
      input: {
        fileName,
        mediaType,
        bytes: [1],
      },
    });
  });

  it('accepts an exact 50 MiB declared file size before reading it', async () => {
    const { commands, service } = configure();
    const source = fakeFile({
      fileName: 'limit.pdf',
      mediaType: 'application/pdf',
      size: MAX_DESKTOP_SOURCE_BYTES,
    });

    await firstValueFrom(service.createSource(source.file));

    expect(source.arrayBuffer).toHaveBeenCalledOnce();
    expect(commands.invoke).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty source', 'empty.pdf', 'application/pdf', 0],
    ['oversized source', 'large.pdf', 'application/pdf', MAX_DESKTOP_SOURCE_BYTES + 1],
    ['WebP source', 'image.webp', 'image/webp', 1],
    ['OGG source', 'voice.ogg', 'audio/ogg', 1],
  ])('rejects %s before allocation or IPC', async (_case, fileName, mediaType, size) => {
    const { commands, service } = configure();
    const source = fakeFile({ fileName, mediaType, size });

    await expect(firstValueFrom(service.createSource(source.file))).rejects.toBeTruthy();

    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(commands.invoke).not.toHaveBeenCalled();
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

function fakeFile(input: {
  readonly fileName: string;
  readonly mediaType: string;
  readonly size: number;
}) {
  const arrayBuffer = vi.fn(() => Promise.resolve(Uint8Array.of(1).buffer));
  return {
    arrayBuffer,
    file: {
      name: input.fileName,
      type: input.mediaType,
      size: input.size,
      arrayBuffer,
    } as unknown as File,
  };
}
