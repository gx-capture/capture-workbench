// Projects recording transcripts and formats their timestamps.
import type { RawCapture } from '@gx-capture/capture-workbench-ui';

/** One line of a recording's transcript, with when it was heard and who spoke it. */
export interface TranscriptLine {
  readonly segmentId: string;
  readonly startMs: number;
  readonly timeLabel: string;
  readonly speaker: string | null;
  readonly text: string;
}

/**
 * A recording's transcript, one line per segment, each
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
