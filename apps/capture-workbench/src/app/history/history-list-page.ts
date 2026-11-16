import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrnAlertDialogImports } from '@spartan-ng/brain/alert-dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { desktopMessages } from '../i18n/desktop-messages';
import { HistoryListStore } from '../services/history-list.store';

@Component({
  selector: 'app-history-list-page',
  templateUrl: './history-list-page.html',
  imports: [RouterLink, BrnAlertDialogImports, HlmButtonImports, HlmTableImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryListPage {
  protected readonly store = inject(HistoryListStore);
  protected readonly m = desktopMessages;
}
