import { Injectable } from '@angular/core';

/**
 * Formats values that are rendered by the desktop workspace.
 *
 * Keeping formatting separate from the store prevents presentation concerns
 * from becoming coupled to capture lifecycle, persistence, or installation
 * side effects. The store remains the public facade used by the template.
 */
@Injectable({ providedIn: 'root' })
export class DesktopWorkspaceFormattingService {
  /** Formats byte counts using the workspace's decimal units. */
  formatBytes(bytes: number): string {
    return bytes < 1_000_000
      ? `${Math.ceil(bytes / 1_000)} KB`
      : `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  /** Formats persisted epoch timestamps for the workspace locale. */
  formatDate(milliseconds: number): string {
    return new Intl.DateTimeFormat('zh-TW', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(milliseconds);
  }
}
