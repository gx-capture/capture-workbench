import { playbackUnavailable } from '../services/recording-playback';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatCard } from '@angular/material/card';
import { MatDivider } from '@angular/material/divider';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatSpinner } from '@angular/material/progress-spinner';
import {
  CAPTURE_UNIT_GUIDES,
  CaptureRuntimeComputeStatusComponent,
} from '@gx-capture/capture-workbench-ui';
import { BrnAlertDialogImports } from '@spartan-ng/brain/alert-dialog';
import { BrnDialogClose } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  DESKTOP_LOCALES,
  DESKTOP_MESSAGES,
  desktopLocale,
  desktopMessages,
  setDesktopLocale,
  type DesktopLocale,
} from '../i18n/desktop-messages';
import {
  formatApproximateBytes,
  formatRecordingTime,
} from '../services/desktop-workspace.selectors';
import { DesktopWorkspaceStore } from '../services/desktop-workspace.store';
import { EngineCard } from '../engine-card/engine-card';

/**
 * The document workspace (queue, intake, detail) as it was before the shell
 * existed. Later phases split it into the OCR, ASR and history pages
 * (.agents/PLANS/workbench-ocr-asr-ux.md).
 */
@Component({
  selector: 'app-history-page',
  templateUrl: './history-page.html',
  styleUrl: './history-page.css',
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
    EngineCard,
    BrnAlertDialogImports,
    BrnDialogClose,
    HlmButtonImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryPage {
  protected readonly store = inject(DesktopWorkspaceStore);
  protected readonly m = desktopMessages;
  protected readonly playbackUnavailable = playbackUnavailable;
  protected readonly locale = desktopLocale;
  protected readonly locales = DESKTOP_LOCALES;
  protected readonly formatTime = formatRecordingTime;
  /** Download sizes come from the runtime, never from the guide text (plan §2). */
  protected readonly approxSize = formatApproximateBytes;
  /** What each optional unit's model does, in the language in use. */
  protected readonly guides = computed(() => CAPTURE_UNIT_GUIDES[this.locale()]);
  protected readonly speechPackOpen = computed(() =>
    this.store.speechPack().some((unit) => unit.status !== 'ready'),
  );
  protected readonly pendingDelete = signal<{
    readonly documentId: string;
    readonly fileName: string;
  } | null>(null);
  protected readonly deleteDialogState = computed(() =>
    this.pendingDelete() === null ? 'closed' : 'open',
  );
  private readonly recordingPlayer =
    viewChild<ElementRef<HTMLMediaElement>>('recordingPlayer');
  private pendingPlayFromMs: number | null = null;

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
    item: {
      readonly documentId: string;
      readonly mediaType: string;
      readonly byteLength: number;
    },
    startMs: number,
  ): void {
    if (playbackUnavailable(item.byteLength)) return;
    const player = this.recordingPlayer()?.nativeElement;
    if (player && this.store.recordingUrl(item.documentId)) {
      this.seek(player, startMs);
      return;
    }
    this.pendingPlayFromMs = startMs;
    this.store.loadSpeakerSamples(item.documentId, item.mediaType, item.byteLength);
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

  protected askDelete(item: {
    readonly documentId: string;
    readonly fileName: string;
    readonly captureId?: string;
  }): void {
    if (this.store.busyIds().has(item.documentId) || item.captureId) return;
    this.pendingDelete.set({
      documentId: item.documentId,
      fileName: item.fileName,
    });
  }

  protected confirmDelete(): void {
    const pending = this.pendingDelete();
    if (!pending) return;
    this.store.delete(pending.documentId);
    this.pendingDelete.set(null);
  }

  protected cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  protected onDeleteDialogState(state: 'open' | 'closed'): void {
    if (state === 'closed') this.pendingDelete.set(null);
  }
}
