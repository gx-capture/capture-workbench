/** Classifies one live read of the progressive checkpoint in the real-engine execution journey. */

/** The fields of the host's `runtime_get_capture` response this check reads. */
export interface LiveCaptureState {
  readonly status: string;
  readonly error?: { readonly code?: unknown } | null;
}

function errorCode(capture: LiveCaptureState): string {
  const code = capture.error?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown';
}

/**
 * Why a live read did not show the checkpoint revision, or undefined when it
 * did. A failed or cancelled capture is reported as such with the runtime's
 * error code; only a capture that moved on (a later revision, the end of
 * extraction) is a missed revision.
 */
export function liveCheckpointProblem(read: {
  readonly captureId: string;
  readonly expectedRevision: number;
  readonly snapshot: unknown;
  readonly capture: LiveCaptureState;
}): string | undefined {
  const { capture, snapshot } = read;
  if (capture.status === 'failed') {
    return `Progressive recording extraction failed before the live checkpoint was verified: code=${errorCode(capture)}.`;
  }
  if (capture.status === 'cancelled') {
    return `Progressive recording extraction stopped (cancelled) before the live checkpoint was verified: code=${errorCode(capture)}.`;
  }
  if (snapshot === null || typeof snapshot !== 'object') {
    return capture.status === 'extracting'
      ? 'Host partial is unavailable while extraction is active.'
      : `Missed the live checkpoint revision: the capture moved on to ${capture.status} before the host partial was read.`;
  }
  const partial = snapshot as { readonly captureId?: unknown; readonly revision?: unknown };
  if (partial.captureId !== read.captureId) return 'Host partial belongs to another capture.';
  if (partial.revision !== read.expectedRevision) {
    return `Missed the live checkpoint revision: the host partial is at revision ${String(partial.revision)}, expected ${read.expectedRevision}.`;
  }
  if (capture.status !== 'extracting') {
    return `Missed the live checkpoint revision: the capture moved on to ${capture.status} before extraction was confirmed active.`;
  }
  return undefined;
}
