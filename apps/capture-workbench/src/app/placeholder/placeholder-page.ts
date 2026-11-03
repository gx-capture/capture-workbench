import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import {
  desktopMessages,
  type PlaceholderRoute,
} from '../i18n/desktop-messages';

/** Intake card linking to the history workspace until the full page queue lands. */
@Component({
  selector: 'app-placeholder-page',
  imports: [RouterLink, HlmButtonImports, HlmCardImports],
  template: `
    <div hlmCard data-testid="placeholder-card">
      <div hlmCardHeader>
        <h2 hlmCardTitle>{{ m().comingSoon }}</h2>
        <p hlmCardDescription>{{ text().summary }}</p>
      </div>
      <div hlmCardFooter>
        <a hlmBtn routerLink="/history">{{ text().action }}</a>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaceholderPage {
  readonly page = input.required<PlaceholderRoute>();
  protected readonly m = desktopMessages;
  protected readonly text = computed(() => this.m().placeholder[this.page()]);
}
