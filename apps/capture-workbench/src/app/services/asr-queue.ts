import type {
  CaptureOperation,
  PartialCapture,
} from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import type { CaptureUserStatus } from './capture-user-status';
import { formatRecordingTime } from './recording-transcript';
import { isActiveStreaming } from './capture-operation-status';
import { isRecordingMediaType } from './capture-media-types';
import { playbackUnavailable } from './recording-playback';
import { inImportOrder } from './ocr-queue';

export type AsrSpokenLanguage = 'zh' | 'en' | 'ja';

export const ASR_SPOKEN_LANGUAGES: readonly AsrSpokenLanguage[] = [
  'zh',
  'en',
  'ja',
];

export interface AsrTranscriptLine {
  readonly segmentId: string;
  readonly timeLabel: string;
  readonly speaker: string | null;
  readonly text: string;
  readonly partial: boolean;
}

export interface AsrLiveCaptureView {
  readonly documentId: string;
  readonly fileName: string;
  readonly coveredUntilMs: number;
  readonly durationMs: number | null;
  readonly percent: number;
  readonly heardLabel: string;
  readonly lines: readonly AsrTranscriptLine[];
  readonly partialRevision: number | null;
}

export interface AsrQueueView {
  readonly documentId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly durationLabel: string;
  readonly userStatus: CaptureUserStatus;
  readonly statusText: string;
  readonly needsInstall: boolean;
  readonly installPercent: number | null;
  readonly interrupted: boolean;
  readonly speakerCount: number | null;
  readonly playbackUnavailable: boolean;
  readonly canExport: boolean;
  readonly errorMessage: string;
}

/** Filters to recordings and sorts oldest first (`createdAtMs` ascending, tie keeps import order). */
export function sortAsrDocumentsOldestFirst(
  documents: readonly DesktopLibrarySummary[],
): readonly DesktopLibrarySummary[] {
  return inImportOrder(documents).filter((document) => isRecordingMediaType(document.mediaType));
}

export function asrStatusText(
  status: CaptureUserStatus,
  interrupted = false,
): string {
  const messages = desktopMessages();
  switch (status) {
    case 'waiting':
      return messages.captureStatusWaiting;
    case 'processing':
      return messages.captureStatusProcessing;
    case 'done':
      return messages.captureStatusDone;
    case 'cancelled':
      return messages.captureStatusCancelled;
    default:
      return interrupted
        ? messages.captureInterrupted
        : messages.captureStatusNeedsAttention;
  }
}

export function describeAsrDocument(input: {
  readonly document: DesktopLibrarySummary;
  readonly detail?: DesktopLibraryDetail;
  readonly operation?: CaptureOperation;
  readonly busy: boolean;
  readonly speechReady: boolean;
  readonly installPercent: number | null;
}): AsrQueueView {
  const { document, detail } = input;
  const opActive = input.operation !== undefined && isActiveStreaming(input.operation);
  const described = describeStatus(document, input.busy || opActive);
  const waiting = described.userStatus === 'waiting';
  const durationMs =
    (described.userStatus === 'processing' ? validDuration(input.operation?.durationMs) : null)
    ?? validDuration(document.durationMs);
  const speakerCount =
    described.userStatus === 'done' && detail?.result?.speakers
      ? (detail.result.speakers.length > 0 ? detail.result.speakers.length : null)
      : null;

  return {
    documentId: document.documentId,
    fileName: document.fileName,
    mediaType: document.mediaType,
    byteLength: document.byteLength,
    durationLabel: durationMs === null ? '—' : formatRecordingTime(durationMs),
    userStatus: described.userStatus,
    statusText: asrStatusText(described.userStatus, described.interrupted),
    needsInstall: waiting && !input.speechReady,
    installPercent: waiting && !input.speechReady ? input.installPercent : null,
    interrupted: described.interrupted,
    speakerCount,
    playbackUnavailable:
      described.userStatus === 'done' && playbackUnavailable(document.byteLength),
    canExport:
      described.userStatus === 'done'
      && (document.status === 'completed' || detail?.result !== undefined),
    errorMessage:
      described.userStatus === 'needs-attention' && !described.interrupted
        ? (document.recoveryMessage ?? document.errorMessage ?? '')
        : '',
  };
}

export function describeAsrLiveCapture(input: {
  readonly document: DesktopLibrarySummary;
  readonly operation?: CaptureOperation;
  readonly partial?: PartialCapture | null;
}): AsrLiveCaptureView {
  const { document, operation, partial } = input;
  const messages = desktopMessages();
  const coveredUntilMs = Math.max(
    0,
    partial?.coveredUntilMs ?? operation?.coveredUntilMs ?? 0,
  );
  const durationMs = validDuration(operation?.durationMs);
  const percent = computeLivePercent(coveredUntilMs, durationMs, operation?.progress);
  const heardTime = formatRecordingTime(coveredUntilMs);
  const heardLabel =
    durationMs !== null
      ? messages.asrHeardOf(heardTime, formatRecordingTime(durationMs))
      : messages.heardUntil(heardTime);

  return {
    documentId: document.documentId,
    fileName: document.fileName,
    coveredUntilMs,
    durationMs,
    percent,
    heardLabel,
    lines: buildLiveTranscriptLines(partial, coveredUntilMs),
    partialRevision: partial?.revision ?? null,
  };
}

export function buildLiveTranscriptLines(
  partial: PartialCapture | null | undefined,
  coveredUntilMs: number,
): readonly AsrTranscriptLine[] {
  if (!partial) return [];
  const timed = (partial.segments ?? []).filter(
    (segment): segment is typeof segment & { readonly locator: { readonly kind: 'time'; readonly startMs: number; readonly endMs: number } } =>
      segment.locator.kind === 'time',
  );
  if (timed.length > 0) {
    return timed.map((segment, index) => ({
      segmentId: segment.segmentId,
      timeLabel: formatRecordingTime(segment.locator.startMs),
      speaker: segment.speaker ?? null,
      text: segment.text,
      partial: index === timed.length - 1,
    }));
  }
  const text = (partial.sourceText ?? '').trim();
  if (!text) return [];
  return [
    {
      segmentId: 'partial-0',
      timeLabel: formatRecordingTime(coveredUntilMs),
      speaker: null,
      text,
      partial: true,
    },
  ];
}

function describeStatus(
  document: DesktopLibrarySummary,
  active: boolean,
): { readonly userStatus: CaptureUserStatus; readonly interrupted: boolean } {
  if (active) return { userStatus: 'processing', interrupted: false };
  if (
    (document.status === 'processing' || document.status === 'persisting')
    && document.captureId
  ) {
    return { userStatus: 'processing', interrupted: false };
  }
  if (document.status === 'processing' || document.status === 'persisting') {
    return { userStatus: 'needs-attention', interrupted: true };
  }
  if (document.status === 'canceled') {
    return { userStatus: 'cancelled', interrupted: false };
  }
  if (document.status === 'failed' || document.status === 'recovery_required') {
    return {
      userStatus: 'needs-attention',
      interrupted: document.recoveryCode === 'capture_recovery_required',
    };
  }
  if (document.status === 'completed') {
    return { userStatus: 'done', interrupted: false };
  }
  if (document.status === 'queued') {
    return { userStatus: 'waiting', interrupted: false };
  }
  return { userStatus: 'needs-attention', interrupted: false };
}

function computeLivePercent(
  coveredUntilMs: number,
  durationMs: number | null,
  progress?: number | null,
): number {
  if (durationMs !== null && durationMs > 0) {
    return Math.round(Math.min(Math.max(coveredUntilMs / durationMs, 0), 1) * 100);
  }
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    return Math.round(Math.min(Math.max(progress, 0), 1) * 100);
  }
  return 0;
}

function validDuration(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function detailDurationMs(detail: DesktopLibraryDetail | undefined): number | null {
  if (!detail) return null;
  let maxEndMs = 0;
  for (const segment of detail.raw?.segments ?? []) {
    if (segment.locator.kind === 'time' && segment.locator.endMs > maxEndMs) {
      maxEndMs = segment.locator.endMs;
    }
  }
  for (const block of detail.result?.blocks ?? []) {
    if (block.locator.kind === 'time' && block.locator.endMs > maxEndMs) {
      maxEndMs = block.locator.endMs;
    }
  }
  return maxEndMs > 0 ? maxEndMs : null;
}
