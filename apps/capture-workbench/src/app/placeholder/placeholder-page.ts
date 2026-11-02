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

/** A page still to be built: what it will do, and where that work happens today. */
@Component({
  selector: 'app-placeholder-page',
  imports: [RouterLink, HlmButtonImports, HlmCardImports],
  template: `
    <section
      class="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10"
      [attr.data-testid]="'page-' + page()"
    >
      <h1 class="text-2xl font-semibold">{{ m().nav[page()] }}</h1>
      <div hlmCard>
        <div hlmCardHeader>
          <h2 hlmCardTitle>{{ m().comingSoon }}</h2>
          <p hlmCardDescription>{{ text().summary }}</p>
        </div>
        <div hlmCardFooter>
          <a hlmBtn routerLink="/history">{{ text().action }}</a>
        </div>
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaceholderPage {
  /** Bound from the route's `data`. */
  readonly page = input.required<PlaceholderRoute>();
  protected readonly m = desktopMessages;
  protected readonly text = computed(() => this.m().placeholder[this.page()]);
}
