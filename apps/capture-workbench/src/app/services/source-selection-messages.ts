import { desktopMessages } from '../i18n/desktop-messages';
import type { DesktopSourceSelectionBatch, SourceRejectionReason } from './desktop-library.service';

export function selectionRejectionMessages(batch: DesktopSourceSelectionBatch): string[] {
  const counts = new Map<SourceRejectionReason, number>();
  for (const reason of batch.rejected) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => desktopMessages().sourceRejections[reason](count));
}
