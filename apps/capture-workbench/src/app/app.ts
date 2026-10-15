import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatCard } from '@angular/material/card';
import { MatDivider } from '@angular/material/divider';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatSpinner } from '@angular/material/progress-spinner';
import { CaptureRuntimeComputeStatusComponent } from '@gx-capture/capture-workbench-ui';
import {
  DESKTOP_LOCALES,
  DESKTOP_MESSAGES,
  desktopLocale,
  desktopMessages,
  setDesktopLocale,
  type DesktopLocale,
} from './i18n/desktop-messages';
import { formatRecordingTime } from './services/desktop-workspace.selectors';
import { DesktopWorkspaceStore } from './services/desktop-workspace.store';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [
    MatButton,
    MatCard,
    MatDivider,
    MatFormField,
    MatInput,
    MatLabel,
    MatOption,
    MatSelect,
    MatSpinner,
    CaptureRuntimeComputeStatusComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(DesktopWorkspaceStore);
  protected readonly m = desktopMessages;
  protected readonly locale = desktopLocale;
  protected readonly locales = DESKTOP_LOCALES;
  protected readonly formatTime = formatRecordingTime;
  private readonly recordingPlayer =
    viewChild<ElementRef<HTMLMediaElement>>('recordingPlayer');
  private pendingPlayFromMs: number | null = null;

  constructor() {
    this.store.initialize();
  }

  protected setLocale(locale: DesktopLocale): void {
    setDesktopLocale(locale);
  }

  protected languageName(locale: DesktopLocale): string {
    return DESKTOP_MESSAGES[locale].languageName;
  }

  protected openFilePicker(): void {
    this.store.chooseSources();
  }

  /** Plays the recording from a transcript line, loading it first if needed. */
  protected playFrom(
    item: { readonly documentId: string; readonly mediaType: string },
    startMs: number,
  ): void {
    const player = this.recordingPlayer()?.nativeElement;
    if (player && this.store.recordingUrl(item.documentId)) {
      this.seek(player, startMs);
      return;
    }
    this.pendingPlayFromMs = startMs;
    this.store.loadSpeakerSamples(item.documentId, item.mediaType);
  }

  protected playPending(player: HTMLMediaElement): void {
    if (this.pendingPlayFromMs === null) return;
    const startMs = this.pendingPlayFromMs;
    this.pendingPlayFromMs = null;
    this.seek(player, startMs);
  }

  private seek(player: HTMLMediaElement, startMs: number): void {
    player.currentTime = startMs / 1000;
    // Autoplay rules can refuse; the player is then left at the moment.
    void player.play()?.catch(() => undefined);
  }

  protected partialFor(documentId: string) {
    return this.store.partialFor?.(documentId) ?? null;
  }
}
