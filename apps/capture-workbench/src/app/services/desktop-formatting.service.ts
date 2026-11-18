import { Injectable } from '@angular/core';
import { formatApproximateBytes as formatApproximateBytesIn } from '@gx-capture/capture-workbench-ui';

import { desktopLocale } from '../i18n/desktop-messages';

/**
 * Formats values that are rendered by the desktop workspace.
 *
 * Keeping formatting separate from the store prevents presentation concerns
 * from becoming coupled to capture lifecycle, persistence, or installation
 * side effects. The store remains the public facade used by the template.
 */
@Injectable({ providedIn: 'root' })
export class DesktopFormattingService {
  /** Formats byte counts using the workspace's decimal units. */
  formatBytes(bytes: number): string {
    return bytes < 1_000_000
      ? `${Math.ceil(bytes / 1_000)} KB`
      : `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  /** Downloads text the page already built, through the same browser save path as host export. */
  downloadText(fileName: string, content: string, mediaType: string): void {
    const blob = new Blob([content], { type: mediaType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** Formats persisted epoch timestamps for the workspace locale. */
  formatDate(milliseconds: number): string {
    return new Intl.DateTimeFormat(desktopLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(milliseconds);
  }
}

/** A download size in the app's current language (`約 2.8 GB`, `~2.8 GB`), or null when unknown. */
export function formatApproximateBytes(
  bytes: number | null | undefined,
): string | null {
  return formatApproximateBytesIn(bytes, desktopLocale());
}
