// Selects recognition requirements and model options for the desktop app.
import type { CaptureRequirementId, RuntimeModelOption, RuntimeRequirement } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibrarySummary } from '../contracts';
import { isRecordingMediaType } from './capture-media-types';

export type RecognitionFeature = 'ocr' | 'asr' | 'asr.speakers';

/** Recognition features and the runtime requirements each one needs. */
export const FEATURE_REQUIREMENTS: Readonly<
  Record<RecognitionFeature, readonly CaptureRequirementId[]>
> = {
  ocr: ['windowsml-ocr'],
  asr: ['speech-recognition'],
  'asr.speakers': ['speaker-diarization'],
};

/** User-facing recognition requirements shown in settings and cards. */
export const RECOGNITION_REQUIREMENTS: readonly CaptureRequirementId[] = [
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
export const OPTIONAL_SPEECH_REQUIREMENTS: readonly CaptureRequirementId[] = [
  'speech-recognition',
  'speaker-diarization',
];

/** The optional speech requirements this runtime reports, in display order. */
export function selectSpeechPack(
  requirements: readonly RuntimeRequirement[],
): readonly RuntimeRequirement[] {
  return OPTIONAL_SPEECH_REQUIREMENTS.flatMap((requirementId) =>
    requirements.filter((requirement) => requirement.requirementId === requirementId));
}

/** The recognition requirements this runtime reports, in display order. */
export function selectRecognitionRequirements(
  requirements: readonly RuntimeRequirement[],
): readonly RuntimeRequirement[] {
  return RECOGNITION_REQUIREMENTS.flatMap((requirementId) =>
    requirements.filter((requirement) => requirement.requirementId === requirementId));
}

/** Whether every requirement for a recognition feature is installed (`ready`). */
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

const SPEECH_CAPTURE_REQUIREMENTS = new Set<CaptureRequirementId>([
  'speech-recognition',
  'speaker-diarization',
]);

const OCR_CAPTURE_REQUIREMENTS = new Set<CaptureRequirementId>([
  'windowsml-ocr',
  'vertical-japanese-reader',
]);

/**
 * Whether a capture that is still processing or saving needs this requirement.
 * The runtime does not record which engine a capture used, so a recording
 * blocks both speech requirements and a document blocks both OCR requirements.
 */
export function captureNeedsRequirement(
  requirementId: CaptureRequirementId,
  documents: readonly DesktopLibrarySummary[],
): boolean {
  const active = documents.filter(
    (document) => document.status === 'processing' || document.status === 'persisting',
  );
  if (active.length === 0) return false;
  if (SPEECH_CAPTURE_REQUIREMENTS.has(requirementId)) {
    return active.some((document) => isRecordingMediaType(document.mediaType));
  }
  if (OCR_CAPTURE_REQUIREMENTS.has(requirementId)) {
    return active.some((document) => !isRecordingMediaType(document.mediaType));
  }
  return true;
}
