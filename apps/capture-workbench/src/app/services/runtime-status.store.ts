import { computed, effect, Injectable, inject, signal } from '@angular/core';
import { SpeechGpuSettingsStore } from './speech-gpu-settings.store';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { LibraryStore } from './library.store';
import { RecognitionFeaturesStore } from './recognition-features.store';
import { errorMessage } from './desktop-workspace.selectors';
import { desktopMessages } from '../i18n/desktop-messages';

type RuntimeState = 'starting' | 'ready' | 'error';

@Injectable({ providedIn: 'root' })
export class RuntimeStatusStore {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly compute = inject(SpeechGpuSettingsStore);
  private readonly features = inject(RecognitionFeaturesStore);
  private readonly library = inject(LibraryStore);

  readonly message = signal(desktopMessages().starting);

  readonly state = computed<RuntimeState>(() => {
    if (
      this.runtime.error() ||
      this.features.requirementsResource.error() ||
      this.library.listError()
    ) {
      return 'error';
    }
    if (!this.runtime.started()) return 'starting';
    const requirementsStatus = this.features.requirementsResource.status();
    if (
      requirementsStatus === 'idle' ||
      requirementsStatus === 'loading' ||
      requirementsStatus === 'reloading'
    ) {
      return 'starting';
    }
    return 'ready';
  });

  private readonly resourceErrorEffect = effect(() => {
    const error =
      this.runtime.error() ??
      this.features.requirementsResource.error() ??
      this.library.listError() ??
      this.library.detailError();
    if (error) this.message.set(errorMessage(error));
  });

  private readonly stateMessageEffect = effect(() => {
    const state = this.state();
    if (state === 'ready' && this.message() === desktopMessages().starting) {
      this.message.set('');
    }
  });

  private readonly featureMessageEffect = effect(() => {
    const featureMsg = this.features.message();
    if (featureMsg) {
      this.message.set(featureMsg);
    }
  });

  private readonly computeErrorEffect = effect(() => {
    const computeError = this.compute.error();
    if (computeError) {
      this.message.set(computeError);
    }
  });

  reload(): void {
    this.runtime.reload();
    this.compute.reload();
    this.features.initialize();
    this.library.refreshDocuments();
  }
}
