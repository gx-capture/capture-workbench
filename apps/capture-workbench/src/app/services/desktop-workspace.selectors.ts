import type {
  CaptureOperation,
  CaptureRequirementId,
  RuntimeModelInstallation,
  RuntimeModelOption,
  RawCapture,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import type {
  DesktopLibraryStatus,
  DesktopLibrarySummary,
} from '../contracts';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';
import { desktopMessages } from '../i18n/desktop-messages';

/** Pure workspace selectors and terminal mappings shared by the facade services. */

export type RecognitionFeature = 'ocr' | 'asr' | 'asr.speakers';

/** Recognition features and the runtime requirement units each one needs. */
export const FEATURE_REQUIREMENTS: Readonly<
  Record<RecognitionFeature, readonly CaptureRequirementId[]>
> = {
  ocr: ['windowsml-ocr'],
  asr: ['speech-recognition'],
  'asr.speakers': ['speaker-diarization'],
};

/** User-facing recognition engine units shown in settings and cards. */
export const RECOGNITION_ENGINE_UNITS: readonly CaptureRequirementId[] = [
  'windowsml-ocr',
  'speech-recognition',
  'speaker-diarization',
  'vertical-japanese-reader',
];

export const INSTALLATION_ORDER = new Map<CaptureRequirementId, number>([
  ['windowsml-ocr', 0],
  ['speech-recognition', 1],
  ['speaker-diarization', 2],
  ['vertical-japanese-reader', 3],
  ['ollama-runtime', 4],
]);

/**
 * The optional Taiwan speech pack: speech-to-text first, then speaker
 * identification, which only adds to a transcript. The user downloads either
 * one when they want it; neither is needed for documents.
 */
export const SPEECH_PACK_UNITS: readonly CaptureRequirementId[] = [
  'speech-recognition',
  'speaker-diarization',
];

/** The speech pack units this runtime reports, in pack order. */
export function selectSpeechPack(
  requirements: readonly RuntimeRequirement[],
): readonly RuntimeRequirement[] {
  return SPEECH_PACK_UNITS.flatMap((requirementId) =>
    requirements.filter((requirement) => requirement.requirementId === requirementId));
}

/** The recognition engine units this runtime reports, in display order. */
export function selectRecognitionEngines(
  requirements: readonly RuntimeRequirement[],
): readonly RuntimeRequirement[] {
  return RECOGNITION_ENGINE_UNITS.flatMap((requirementId) =>
    requirements.filter((requirement) => requirement.requirementId === requirementId));
}

/** Formats a download byte count as a localized approximate size (`約 2.8 GB`, `約 144 MB`). */
export function formatApproximateBytes(
  bytes: number | null | undefined,
): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  const m = desktopMessages();
  if (bytes >= 1_000_000_000) {
    const gb = (bytes / 1_000_000_000).toFixed(1).replace(/\.0$/u, '');
    return m.approxSize(`${gb} GB`);
  }
  if (bytes >= 1_000_000) {
    const mb = Math.round(bytes / 1_000_000);
    return m.approxSize(`${mb} MB`);
  }
  const kb = Math.max(1, Math.round(bytes / 1_000));
  return m.approxSize(`${kb} KB`);
}

/** Converts model installation progress to the percentage shown by the UI. */
export function modelInstallationPercent(
  installation: RuntimeModelInstallation | null,
): number {
  return installationPercent(installation);
}

/** An installation's progress as a whole percentage, preferring byte counts when available. */
export function installationPercent(
  installation: {
    readonly progress: number;
    readonly downloadedBytes?: number | null;
    readonly downloadBytes?: number | null;
  } | null,
): number {
  if (!installation) return 0;
  const ratio =
    typeof installation.downloadBytes === 'number'
    && installation.downloadBytes > 0
    && typeof installation.downloadedBytes === 'number'
      ? installation.downloadedBytes / installation.downloadBytes
      : installation.progress;
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
}

/** Maps a model installation state to its human-readable phase. */
export function modelInstallationPhase(
  installation: RuntimeModelInstallation | null,
): string {
  if (!installation) return '';
  const phase = desktopMessages().modelPhase;
  if (installation.status === 'queued') return phase.queued;
  if (installation.status === 'failed') return phase.failed;
  if (installation.status === 'cancelled') return phase.cancelled;
  if (installation.status === 'completed') return phase.completed;
  if (installation.progress < 0.1) return phase.starting;
  if (installation.progress < 0.75) return phase.downloading;
  return phase.configuring;
}

/** Whether every requirement unit for a recognition feature is installed (`ready`). */
export function isFeatureReady(
  requirements: readonly RuntimeRequirement[],
  feature: RecognitionFeature,
): boolean {
  const requiredIds = FEATURE_REQUIREMENTS[feature];
  return requiredIds.every((id) =>
    requirements.some(
      (requirement) =>
        requirement.requirementId === id && requirement.status === 'ready',
    ),
  );
}

/** Selects requirements for a recognition feature that are not yet `ready`. */
export function selectFeatureMissing(
  requirements: readonly RuntimeRequirement[],
  feature: RecognitionFeature,
): readonly RuntimeRequirement[] {
  const requiredIds = new Set(FEATURE_REQUIREMENTS[feature]);
  return requirements.filter(
    (requirement) =>
      requiredIds.has(requirement.requirementId)
      && requirement.status !== 'ready',
  );
}

/** Selects explicitly requested requirements that are not yet `ready`. */
export function selectRequestedMissing(
  requirements: readonly RuntimeRequirement[],
  requestedRequirements: ReadonlySet<CaptureRequirementId>,
): readonly RuntimeRequirement[] {
  return requirements.filter(
    (requirement) =>
      requestedRequirements.has(requirement.requirementId)
      && requirement.status !== 'ready',
  );
}

/** Selects and orders installable requirements from the requested IDs. */
export function selectInstallableRequirements(
  requirements: readonly RuntimeRequirement[],
  requestedRequirements: Iterable<CaptureRequirementId>,
): readonly RuntimeRequirement[] {
  const requested = new Set(requestedRequirements);
  return requirements
    .filter(
      (requirement) =>
        requested.has(requirement.requirementId)
        && requirement.status === 'installable',
    )
    .slice()
    .sort(
      (left, right) =>
        (INSTALLATION_ORDER.get(left.requirementId) ?? Number.MAX_SAFE_INTEGER)
        - (INSTALLATION_ORDER.get(right.requirementId) ?? Number.MAX_SAFE_INTEGER),
    );
}

/** Indicates whether an active model option must be selected by the user. */
export function modelSelectionRequired(
  options: readonly RuntimeModelOption[],
): boolean {
  return options.length > 0 && !options.some((option) => option.status === 'active');
}

/** Returns the active model option, if the catalog has one. */
export function activeModelOption(
  options: readonly RuntimeModelOption[],
): RuntimeModelOption | null {
  return options.find((option) => option.status === 'active') ?? null;
}

/**
 * Identifies recordings, which use the streaming capture path: audio, and
 * video whose audio track is transcribed.
 */
export function isAudioMediaType(mediaType: string): boolean {
  return mediaType.startsWith('audio/') || mediaType.startsWith('video/');
}

/** One line of a recording's transcript, with when it was heard and who spoke it. */
export interface TranscriptLine {
  readonly segmentId: string;
  readonly startMs: number;
  readonly timeLabel: string;
  readonly speaker: string | null;
  readonly text: string;
}

/**
 * A recording's transcript as Whisper heard it, one line per segment, each
 * with the name a person gave its speaker when there is one.
 */
export function transcriptLines(
  raw: RawCapture,
  speakerNames: readonly { readonly speakerId: string; readonly displayName?: string | null }[] = [],
): readonly TranscriptLine[] {
  const names = new Map(
    speakerNames.map((speaker) => [speaker.speakerId, speaker.displayName?.trim() || null]),
  );
  return raw.segments.flatMap((segment) => {
    if (segment.locator.kind !== 'time') return [];
    const speaker = segment.speaker ?? null;
    return [
      {
        segmentId: segment.segmentId,
        startMs: segment.locator.startMs,
        timeLabel: formatRecordingTime(segment.locator.startMs),
        speaker: speaker === null ? null : (names.get(speaker) ?? speaker),
        text: segment.text,
      },
    ];
  });
}

/** `m:ss` below an hour, `h:mm:ss` from an hour on. */
export function formatRecordingTime(milliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigits = (value: number) => value.toString().padStart(2, '0');
  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${minutes}:${twoDigits(seconds)}`;
}

/** Identifies PDF media that uses the one-shot capture path. */
export function isPdfMediaType(mediaType: string): boolean {
  return mediaType === 'application/pdf';
}

/** Identifies non-terminal one-shot capture jobs. */
export function isActiveJob(job: DesktopCaptureOperation): boolean {
  return job.status === 'queued'
    || job.status === 'running'
    || job.status === 'created'
    || job.status === 'waiting_input'
    || job.status === 'extracting'
    || job.status === 'awaiting_structuring'
    || job.status === 'structuring';
}

/** A one-shot OCR result is ready for host persistence before optional structuring. */
export function isOcrCheckpoint(job: DesktopCaptureOperation): boolean {
  return job.status === 'awaiting_structuring';
}

/** Returns the v2 stage while preserving the legacy desktop bridge field. */
export function captureJobStage(job: DesktopCaptureOperation): string {
  return job.stage ?? job.status;
}

/** Identifies non-terminal streaming operations. */
export function isActiveStreaming(operation: CaptureOperation): boolean {
  return operation.status === 'created'
    || operation.status === 'waiting_input'
    || operation.status === 'extracting'
    || operation.status === 'awaiting_structuring'
    || operation.status === 'structuring';
}

/** Maps a runtime terminal job to the library's persisted status vocabulary. */
export function terminalLibraryStatus(job: DesktopCaptureOperation): DesktopLibraryStatus {
  if (job.status === 'completed') return 'completed';
  if (job.status === 'cancelled') return 'canceled';
  return 'failed';
}

/** Derives a terminal library status from a persisted runtime stage. */
export function terminalStatusFromStage(stage?: string): DesktopLibraryStatus {
  if (stage === 'cancelled') return 'canceled';
  if (stage === 'failed') return 'failed';
  if (stage === 'awaiting_structuring') return 'awaiting_confirmation';
  return 'completed';
}

/** Indicates whether a document already contains terminal data during recovery. */
export function hasCommittedTerminalData(document: DesktopLibrarySummary): boolean {
  return document.recoveryCode === 'runtime_cleanup_failed'
    || document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled';
}

/** Preserves an existing terminal status while recovering runtime cleanup. */
export function committedTerminalStatus(document: DesktopLibrarySummary): DesktopLibraryStatus {
  return document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled'
    ? document.status
    : terminalStatusFromStage(document.stage);
}

/** Converts a library terminal status to the runtime stage spelling. */
export function terminalStage(status?: DesktopLibraryStatus): string {
  if (status === 'canceled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'awaiting_confirmation') return 'awaiting_structuring';
  return 'completed';
}

/** Converts unknown errors to redacted messages safe for host-facing UI. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveMessage(message);
}

/** Removes bearer and token-shaped values from user-visible diagnostics. */
export function redactSensitiveMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(?:authorization|bearerToken|access_token|token)\s*[:=]\s*["']?[^"'\s,;}]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)} [redacted]`,
    );
}

/** Maps a runtime stage to its workspace label. */
export function stageLabel(stage?: string): string {
  const labels = desktopMessages().stage;
  return labels[stage ?? ''] ?? labels['queued'] ?? '';
}

/** Maps a library status to its workspace label. */
export function statusLabel(status: DesktopLibrarySummary['status']): string {
  return desktopMessages().status[status] ?? status;
}

/** Result text; a transcript with speakers reads "name: what they said". */
export function captureResultText(result: {
  readonly targetText: string;
  readonly speakers?: readonly {
    readonly speakerId: string;
    readonly displayName?: string | null;
  }[];
  readonly rawSegments?: readonly {
    readonly segmentId: string;
    readonly speaker?: string | null;
  }[];
  readonly blocks?: readonly {
    readonly sourceSegmentId: string;
    readonly targetText: string;
  }[];
}): string {
  const speakers = result.speakers ?? [];
  if (speakers.length === 0 || !result.blocks || !result.rawSegments) {
    return result.targetText;
  }
  const names = new Map(
    speakers.map((speaker) => [
      speaker.speakerId,
      speaker.displayName?.trim() || speaker.speakerId,
    ]),
  );
  const speakerOf = new Map(
    result.rawSegments.map((segment) => [segment.segmentId, segment.speaker]),
  );
  return result.blocks
    .map((block) => {
      const speaker = speakerOf.get(block.sourceSegmentId);
      const name = speaker ? names.get(speaker) : undefined;
      return name ? `${name}: ${block.targetText}` : block.targetText;
    })
    .join('\n');
}
