import {
  ChangeDetectionStrategy,
  Component,
  inject,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { EngineCard } from '../engine-card/engine-card';
import { desktopMessages } from '../i18n/desktop-messages';
import {
  ASR_SPOKEN_LANGUAGES,
  type AsrQueueView,
  type AsrSpokenLanguage,
} from '../services/asr-queue';
import { AsrQueueStore } from '../services/asr-queue.store';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';

@Component({
  selector: 'app-asr-page',
  templateUrl: './asr-page.html',
  imports: [EngineCard, HlmButtonImports, HlmTableImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AsrPage {
  protected readonly queue = inject(AsrQueueStore);
  protected readonly features = inject(RecognitionFeaturesStore);
  protected readonly m = desktopMessages;
  protected readonly languages = ASR_SPOKEN_LANGUAGES;

  constructor() {
    this.queue.attach();
  }

  protected onLanguageChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as AsrSpokenLanguage;
    this.queue.setSpokenLanguage(value);
  }

  protected onIdentifySpeakersChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.queue.setIdentifySpeakers(checked);
  }

  protected chipClasses(status: AsrQueueView['userStatus']): string {
    switch (status) {
      case 'processing':
        return 'bg-secondary text-secondary-foreground';
      case 'done':
        return 'bg-muted text-secondary-foreground';
      case 'needs-attention':
        return 'bg-destructive/15 text-destructive';
      default:
        return 'border border-border text-muted-foreground';
    }
  }
}
