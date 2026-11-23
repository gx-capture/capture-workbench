import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryDetail, DesktopLibraryEdits, DesktopLibrarySummary } from '../contracts';
import { desktopMessages } from '../i18n/desktop-messages';
import { detailDurationMs } from './asr-queue';
import { formatRecordingTime, transcriptLines, type TranscriptLine } from './recording-transcript';
import { isRecordingMediaType, isPdfMediaType } from './capture-media-types';
import { groupRawOcrPages, type OcrPageText } from './ocr-queue';
import { captureRowState, type CaptureRowInput, type CaptureRowState } from './capture-user-status';

type CaptureSpeaker = NonNullable<RawCapture['speakers']>[number];

export type ResultKind = 'ocr' | 'asr';

export interface EditedOcrPage extends OcrPageText {
  readonly recognizedText: string;
  readonly edited: boolean;
}

export interface EditedTranscriptLine extends TranscriptLine {
  readonly recognizedText: string;
  readonly edited: boolean;
}

/** Applies whole-page edits without changing raw segments or creating orphan pages. */
export function resultPages(
  raw: RawCapture,
  edits?: DesktopLibraryEdits,
): readonly EditedOcrPage[] {
  return groupRawOcrPages(raw).map((page) => ({
    ...page,
    recognizedText: page.text,
    text: ownEdit(edits?.ocrPages, String(page.page)) ?? page.text,
    edited: ownEdit(edits?.ocrPages, String(page.page)) !== undefined,
  }));
}

/** Applies segment edits and speaker names while keeping each recognized line. */
export function resultLines(
  raw: RawCapture,
  speakers: readonly CaptureSpeaker[],
  edits?: DesktopLibraryEdits,
): readonly EditedTranscriptLine[] {
  const names = new Map(raw.segments.flatMap((segment) => {
    const id = segment.speaker;
    const name = id == null ? undefined : ownEdit(edits?.speakerNames, id);
    return id != null && name !== undefined ? [[id, name.trim()] as const] : [];
  }));
  const namedSpeakers = [...speakers.map((speaker) => ({
    ...speaker, displayName: names.get(speaker.speakerId) ?? speaker.displayName,
  })), ...[...names].map(([speakerId, displayName]) => ({ speakerId, displayName }))];
  return transcriptLines(raw, namedSpeakers).map((line) => ({
    ...line,
    recognizedText: line.text,
    text: ownEdit(edits?.transcriptLines, line.segmentId) ?? line.text,
    edited: ownEdit(edits?.transcriptLines, line.segmentId) !== undefined,
  }));
}

function ownEdit(map: Readonly<Record<string, string>> | undefined, key: string): string | undefined {
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

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
  return isRecordingMediaType(mediaType) ? 'asr' : 'ocr';
}

/** Returns true when a library lookup error indicates the document does not exist. */
export function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not\s*found|unknown document/iu.test(message);
}

/** The document's row, as its queue shows it: from what is stored and what this run does with it. */
export function resultRowState(
  detail: DesktopLibrarySummary & Pick<DesktopLibraryDetail, 'raw'>,
  run: Omit<CaptureRowInput, 'document'>,
): CaptureRowState {
  const document = { ...detail, hasRaw: detail.hasRaw === true || detail.raw !== undefined };
  return captureRowState({ ...run, document });
}

/** Resolves the speaker list from structured result first, falling back to raw capture. */
export function resultSpeakersList(detail: DesktopLibraryDetail): readonly CaptureSpeaker[] {
  return detail.result?.speakers ?? detail.raw?.speakers ?? [];
}

/** The label shown for a speaker nobody has named: the same value an unnamed field holds. */
function recognizedSpeakerName(speaker: CaptureSpeaker): string {
  return speaker.displayName?.trim() || speaker.speakerId;
}

/** Builds read-only speaker view models with media fragment sample URLs when playable. */
export function buildResultSpeakers(
  speakers: readonly CaptureSpeaker[],
  recordingUrl: string | null,
  edits?: DesktopLibraryEdits,
): readonly ResultSpeakerView[] {
  return speakers.map((speaker) => ({
    speakerId: speaker.speakerId,
    displayName: ownEdit(edits?.speakerNames, speaker.speakerId)?.trim()
      ?? recognizedSpeakerName(speaker),
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
  statusLabel: string,
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
    statusLabel,
    pageCount,
    durationLabel: durationMs !== null ? formatRecordingTime(durationMs) : null,
    createdAtLabel: formatting.formatDate(detail.createdAtMs),
    updatedAtLabel: formatting.formatDate(detail.updatedAtMs),
  };
}


/** Map equality ignores host timestamps and insertion order. */
export function sameResultEdits(a: DesktopLibraryEdits, b: DesktopLibraryEdits): boolean {
  return (['ocrPages', 'transcriptLines', 'speakerNames'] as const).every((field) => {
    const keys = Object.keys(a[field]);
    return keys.length === Object.keys(b[field]).length
      && keys.every((key) => ownEdit(b[field], key) === a[field][key]);
  });
}

export type ResultEditCommand =
  | { readonly field: 'ocrPages'; readonly key: number; readonly text: string | null }
  | { readonly field: 'transcriptLines' | 'speakerNames'; readonly key: string; readonly text: string | null };

/** Validates before replacing an immutable map; null means restore recognized content. */
export function applyResultEdit(
  detail: DesktopLibraryDetail,
  edits: DesktopLibraryEdits,
  command: ResultEditCommand,
): { readonly edits: DesktopLibraryEdits; readonly error: string | null } {
  const { field, key } = command;
  const raw = detail.raw;
  if (!raw) return { edits, error: null };
  const speaker = field === 'speakerNames'
    ? resultSpeakersList(detail).find((candidate) => candidate.speakerId === key)
    : undefined;
  const recognized = field === 'ocrPages'
    ? resultPages(raw).find((page) => page.page === key)?.text
    : field === 'transcriptLines'
      ? resultLines(raw, []).find((line) => line.segmentId === key)?.text
      : speaker && recognizedSpeakerName(speaker);
  if (recognized === undefined) return { edits, error: null };
  let text = command.text;
  if (field !== 'speakerNames' && text === recognized) text = null;
  if (field === 'speakerNames' && text !== null) {
    // Rust char::is_control covers Unicode Cc, including C1 controls.
    if (/\p{Cc}/u.test(text) || [...text.trim()].length > 100) {
      return { edits, error: desktopMessages().resultNameInvalid };
    }
    text = text.trim() || null;
  } else if (text !== null && new TextEncoder().encode(text).length > (field === 'ocrPages' ? 1024 * 1024 : 64 * 1024)) {
    return { edits, error: field === 'ocrPages' ? desktopMessages().resultPageTooLong : desktopMessages().resultLineTooLong };
  }
  if (text === recognized) text = null;
  const map = { ...edits[field] };
  if (text === null) delete map[String(key)];
  else Object.defineProperty(map, String(key), { value: text, enumerable: true, configurable: true, writable: true });
  return { edits: { ...edits, [field]: map }, error: null };
}
