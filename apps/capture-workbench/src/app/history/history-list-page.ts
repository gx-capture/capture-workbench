import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrnAlertDialogImports } from '@spartan-ng/brain/alert-dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { desktopMessages } from '../i18n/desktop-messages';
import { HistoryListStore } from '../services/history-list.store';
import { captureStatusChipClasses, captureStatusChipVariant, type CaptureUserStatus } from '../services/capture-user-status';

@Component({
  selector: 'app-history-list-page',
  templateUrl: './history-list-page.html',
  imports: [RouterLink, BrnAlertDialogImports, HlmButtonImports, HlmTableImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryListPage {
  protected readonly store = inject(HistoryListStore);
  protected readonly m = desktopMessages;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.store.clearTransientState());
  }

  protected chipClass(status: CaptureUserStatus): string {
    return captureStatusChipClasses(captureStatusChipVariant(status));
  }
}
