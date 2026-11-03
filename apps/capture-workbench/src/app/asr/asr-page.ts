import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { EngineCard } from '../engine-card/engine-card';
import { desktopMessages } from '../i18n/desktop-messages';
import { PlaceholderPage } from '../placeholder/placeholder-page';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';

@Component({
  selector: 'app-asr-page',
  templateUrl: './asr-page.html',
  imports: [EngineCard, PlaceholderPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AsrPage {
  protected readonly features = inject(RecognitionFeaturesStore);
  protected readonly m = desktopMessages;

  protected readonly showInstallPanel = computed(
    () => this.features.missingFor('asr').length > 0,
  );

  protected readonly optionalSpeakerUnit = computed(() =>
    this.features
      .speechPack()
      .find(
        (unit) =>
          unit.requirementId === 'speaker-diarization' &&
          unit.status !== 'ready',
      ) ?? null,
  );
}
