import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryDetail } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import { detailDurationMs } from './asr-queue';
import {
  formatRecordingTime,
  isAudioMediaType,
  isPdfMediaType,
} from './desktop-workspace.selectors';

type CaptureSpeaker = NonNullable<RawCapture['speakers']>[number];

export type ResultKind = 'ocr' | 'asr';

export interface ResultSpeakerView {
  readonly speakerId: string;
  readonly displayName: string;
  readonly sampleUrl: string | null;
}

export interface ResultDetailsView {
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeLabel: string;
  readonly statusLabel: string;
  readonly pageCount: number | null;
  readonly durationLabel: string | null;
  readonly createdAtLabel: string;
  readonly updatedAtLabel: string;
}

export interface ResultSeekRequest {
  readonly ms: number;
  readonly seq: number;
}

/** Classifies a library item as an OCR document or an ASR recording (audio or video). */
export function resultKind(mediaType: string): ResultKind {
  return isAudioMediaType(mediaType) ? 'asr' : 'ocr';
}

/** Returns true when a library lookup error indicates the document does not exist. */
export function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not\s*found|unknown document/iu.test(message);
}

/** Maps a library item's persisted state to the user-facing status vocabulary. */
export function resultStatusText(detail: DesktopLibraryDetail): string {
  const messages = desktopMessages();
  if (detail.status === 'queued') return messages.ocrStatusWaiting;
  if (detail.status === 'processing' || detail.status === 'persisting') {
    return detail.captureId ? messages.ocrStatusProcessing : messages.ocrInterrupted;
  }
  if (detail.status === 'canceled') return messages.ocrStatusCancelled;
  if (detail.status === 'failed' || detail.status === 'recovery_required') {
    return detail.recoveryCode === 'capture_recovery_required'
      ? messages.ocrInterrupted
      : messages.ocrStatusNeedsAttention;
  }
  if (
    detail.status === 'completed'
    || (detail.status === 'awaiting_confirmation' && (detail.hasRaw === true || detail.raw !== undefined))
  ) {
    return messages.ocrStatusDone;
  }
  return messages.ocrStatusNeedsAttention;
}

/** Resolves the speaker list from structured result first, falling back to raw capture. */
export function resultSpeakersList(detail: DesktopLibraryDetail): readonly CaptureSpeaker[] {
  return detail.result?.speakers ?? detail.raw?.speakers ?? [];
}

/** Builds read-only speaker view models with media fragment sample URLs when playable. */
export function buildResultSpeakers(
  speakers: readonly CaptureSpeaker[],
  recordingUrl: string | null,
): readonly ResultSpeakerView[] {
  return speakers.map((speaker) => ({
    speakerId: speaker.speakerId,
    displayName: speaker.displayName?.trim() || speaker.speakerId,
    sampleUrl:
      recordingUrl && speaker.sample
        ? `${recordingUrl}#t=${speaker.sample.startMs / 1000},${speaker.sample.endMs / 1000}`
        : null,
  }));
}

/** Formats non-diagnostic metadata for the result details sub-page. */
export function buildResultDetails(
  detail: DesktopLibraryDetail,
  pagesCount: number,
  formatting: {
    formatBytes(bytes: number): string;
    formatDate(milliseconds: number): string;
  },
): ResultDetailsView {
  const kind = resultKind(detail.mediaType);
  const durationMs = kind === 'asr' ? detailDurationMs(detail) : null;
  const pageCount =
    kind === 'ocr'
      ? (detail.raw?.ocrPageScope?.sourcePageCount
        ?? (pagesCount > 0
          ? pagesCount
          : detail.captureOptions?.pdfPageCount ?? (isPdfMediaType(detail.mediaType) ? null : 1)))
      : null;

  return {
    fileName: detail.fileName,
    mediaType: detail.mediaType,
    sizeLabel: formatting.formatBytes(detail.byteLength),
    statusLabel: resultStatusText(detail),
    pageCount,
    durationLabel: durationMs !== null ? formatRecordingTime(durationMs) : null,
    createdAtLabel: formatting.formatDate(detail.createdAtMs),
    updatedAtLabel: formatting.formatDate(detail.updatedAtMs),
  };
}
