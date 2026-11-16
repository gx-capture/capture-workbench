import { Injectable, inject, signal } from '@angular/core';
import { concatMap, defer, EMPTY, finalize, from, map, of, tap, type Observable } from 'rxjs';
import { desktopMessages } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';

type ExportFormat = 'text' | 'markdown' | 'srt' | 'vtt';

/** Browser effects and host export shared by result and queue commands. */
@Injectable({ providedIn: 'root' })
export class LibraryExportService {
  private readonly library = inject(DesktopLibraryService);
  private readonly formatting = inject(DesktopWorkspaceFormattingService);
  readonly busyIds = signal<ReadonlySet<string>>(new Set());

  run(id: string, format: ExportFormat, copy = false, save: Observable<void> = of(undefined)): Observable<void> {
    return defer(() => {
      if (this.busyIds().has(id)) return EMPTY;
      this.busyIds.update((ids) => new Set([...ids, id]));
      return save.pipe(
        concatMap(() => this.library.export(id, format,
          format === 'text' || format === 'markdown' ? desktopMessages().exportPageLabel : undefined)),
        concatMap((payload) => copy
          ? defer(() => from(navigator.clipboard.writeText(payload.content)))
          : of(payload).pipe(tap((file) => this.formatting.downloadText(file.fileName, file.content, file.mediaType)), map(() => undefined))),
        finalize(() => this.busyIds.update((ids) => new Set([...ids].filter((value) => value !== id)))),
      );
    });
  }
}
