/** Whole-file playback stays bounded until large-recording playback is available. */
export const MAX_PLAYBACK_BYTES = 50 * 1024 * 1024;

export function playbackUnavailable(byteLength: number): boolean {
  return byteLength > MAX_PLAYBACK_BYTES;
}
