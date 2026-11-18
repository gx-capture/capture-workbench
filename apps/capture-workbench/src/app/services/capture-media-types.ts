// Classifies capture sources by media type.

/**
 * Identifies recordings, which use the streaming capture path: audio, and
 * video whose audio track is transcribed.
 */
export function isRecordingMediaType(mediaType: string): boolean {
  return mediaType.startsWith('audio/') || mediaType.startsWith('video/');
}

/** Identifies PDF media that uses the one-shot capture path. */
export function isPdfMediaType(mediaType: string): boolean {
  return mediaType === 'application/pdf';
}
