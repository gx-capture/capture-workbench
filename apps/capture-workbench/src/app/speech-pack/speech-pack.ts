import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { CAPTURE_UNIT_GUIDES } from '@gx-capture/capture-workbench-ui';
import { desktopLocale, desktopMessages } from '../i18n/desktop-messages';
import { DesktopWorkspaceStore } from '../services/desktop-workspace.store';

/**
 * The optional Taiwan speech pack: what each unit's model does, and a
 * download the user agrees to one unit at a time. Its own component so its
 * styles stay out of the workspace's style budget.
 */
@Component({
  selector: 'app-speech-pack',
  templateUrl: './speech-pack.html',
  styleUrl: './speech-pack.css',
  imports: [MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpeechPack {
  protected readonly store = inject(DesktopWorkspaceStore);
  protected readonly m = desktopMessages;
  /** What each optional unit's model does, in the language in use. */
  protected readonly guides = computed(() => CAPTURE_UNIT_GUIDES[desktopLocale()]);
  /** Folds the speech pack away once everything in it is installed. */
  protected readonly speechPackReady = computed(() =>
    this.store.speechPack().every((unit) => unit.status === 'ready'));
}
