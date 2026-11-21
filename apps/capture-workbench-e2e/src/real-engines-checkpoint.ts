/** Classifies one live read of the progressive checkpoint in the real-engine execution journey. */

/** The fields of the host's `runtime_get_capture` response this check reads. */
export interface LiveCaptureState {
  readonly status: string;
  readonly error?: { readonly code?: unknown } | null;
  readonly createdAt?: string;
}

/**
 * The persisted document's state in the runtime's terms, for when the runtime
 * no longer knows the capture. The library spells the cancelled state `canceled`.
 */
export function persistedCaptureState(detail: { readonly status: string; readonly errorCode?: string }): LiveCaptureState {
  return {
    status: detail.status === 'canceled' ? 'cancelled' : detail.status,
    error: detail.errorCode ? { code: detail.errorCode } : null,
  };
}

function errorCode(capture: LiveCaptureState): string {
  const code = capture.error?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown';
}

/** A failed or cancelled capture, named with the runtime's error code; undefined otherwise. */
function stoppedProblem(capture: LiveCaptureState): string | undefined {
  if (capture.status === 'failed') {
    return `Progressive recording extraction failed before the live checkpoint was verified: code=${errorCode(capture)}.`;
  }
  if (capture.status === 'cancelled') {
    return `Progressive recording extraction stopped (cancelled) before the live checkpoint was verified: code=${errorCode(capture)}.`;
  }
  return undefined;
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
  const stopped = stoppedProblem(capture);
  if (stopped) return stopped;
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

/**
 * Why the live card already shows a revision past the checkpoint. The row
 * status was read before the card, so the capture's current state decides: a
 * capture that failed or was cancelled meanwhile is reported as such.
 */
export function shownPastCheckpointProblem(read: {
  readonly expectedRevision: number;
  readonly shownRevision: number;
  readonly capture: LiveCaptureState;
}): string {
  return stoppedProblem(read.capture)
    ?? `Missed the live checkpoint revision between UI polls: the card shows revision ${read.shownRevision}, `
      + `expected ${read.expectedRevision}; the capture is ${read.capture.status}.`;
}

/** Milliseconds from the runtime's capture start to `now`, or undefined without a valid start time. */
export function sinceCaptureStart(capture: LiveCaptureState, now: number): number | undefined {
  const started = capture.createdAt ? Date.parse(capture.createdAt) : Number.NaN;
  return Number.isFinite(started) ? now - started : undefined;
}
