/**
 * What the capture lifecycle stage of the real-engine execution journey
 * (real-engines-capture-lifecycle.ts) records of the page, and the checks it
 * makes on those records. Nothing here holds a file name or recognised text:
 * rows are named by document ID and described by their status and flags.
 */

/** A host command the page sent, with when it was sent and when (or whether) it was answered. */
export interface PageCommandRecord {
  readonly command: string;
  readonly sentAt: number;
  answeredAt?: number;
  /** The request ended without an answer (for example aborted by a reload). */
  failedAt?: number;
  /** The capture a runtime command names (`input.id`). */
  readonly captureId?: string;
  /** The document a capture create (`input.documentId`) or a library read (`request.documentId`) names. */
  readonly documentId?: string;
  /** The library write of a `library_update_capture`. */
  readonly write?: LibraryWriteRecord;
  /** Every row the page showed when it sent the command. */
  readonly shown?: readonly ShownRowRecord[];
}

/** The fields of a library write the checks read. */
export interface LibraryWriteRecord {
  readonly documentId: string;
  readonly status: string;
  readonly stage?: string;
  readonly captureId?: string;
  readonly clearCaptureId?: boolean;
  readonly hasRaw: boolean;
  readonly hasResult: boolean;
}

/** A row as the page showed it, without its text. */
export interface ShownRowRecord {
  readonly documentId: string;
  /** `ocr-queue-row`, `asr-queue-row` or `history-row`. */
  readonly row: string;
  readonly status: string;
  /** The row's status says 取消中. */
  readonly cancelling: boolean;
  /** The row's status says 已中斷. */
  readonly interrupted: boolean;
  /** The row's status says 已取消. */
  readonly cancelled: boolean;
  /** The row offers 重新開始. */
  readonly restart: boolean;
}

/** A change of a row the page showed, at the page's time. */
export interface RowChangeRecord extends ShownRowRecord {
  readonly at: number;
}

/**
 * One capture attempt of the run and its time span, so that the device
 * samples taken beside the journey can be read per capture (one runs at a time).
 */
export interface CaptureWindow {
  /** Names the attempt (`pdf`, `lifecycle-recording-2`), never the file. */
  readonly label: string;
  readonly engine: 'text-recognition' | 'speech-recognition';
  /** ISO time: the capture create was sent (lifecycle) or the file was queued. */
  readonly startedAt: string;
  /** ISO time: the attempt's end was answered or shown. */
  readonly endedAt: string;
  readonly outcome: 'done' | 'interrupted' | 'cancelled';
  /** For an attempt ended by a runtime delete: how long the runtime took to answer it. */
  readonly runtimeDeleteMs?: number;
}

export const captureCreateCommands: ReadonlySet<string> = new Set([
  'runtime_create_capture',
  'runtime_start_recording_capture',
]);

const terminalStatuses: ReadonlySet<string> = new Set(['completed', 'failed', 'canceled', 'awaiting_confirmation']);

/** The library write of a page request body, reduced to the fields the checks read. */
export function libraryWriteOf(body: unknown): LibraryWriteRecord | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const update = (body as { readonly update?: unknown }).update;
  if (update === null || typeof update !== 'object') return undefined;
  const fields = update as Record<string, unknown>;
  if (typeof fields['documentId'] !== 'string' || typeof fields['status'] !== 'string') return undefined;
  return {
    documentId: fields['documentId'],
    status: fields['status'],
    ...(typeof fields['stage'] === 'string' ? { stage: fields['stage'] } : {}),
    ...(typeof fields['captureId'] === 'string' ? { captureId: fields['captureId'] } : {}),
    ...(fields['clearCaptureId'] === true ? { clearCaptureId: true } : {}),
    hasRaw: fields['raw'] !== undefined && fields['raw'] !== null,
    hasResult: fields['result'] !== undefined && fields['result'] !== null,
  };
}

/** The terminal library writes the page sent for the document, from `from` on. */
export function terminalWritesOf(
  commands: readonly PageCommandRecord[],
  documentId: string,
  from = 0,
): readonly PageCommandRecord[] {
  return commands.slice(from).filter((command) => command.write?.documentId === documentId
    && terminalStatuses.has(command.write.status));
}

/** The capture creates the page sent for the document, from `from` on. */
export function capturesCreatedFor(
  commands: readonly PageCommandRecord[],
  documentId: string,
  from = 0,
): readonly PageCommandRecord[] {
  return commands.slice(from).filter((command) => captureCreateCommands.has(command.command)
    && command.documentId === documentId);
}

/** The commands the page sent that name the capture, from `from` on, by command name. */
export function commandsNamingCapture(
  commands: readonly PageCommandRecord[],
  captureId: string,
  from = 0,
): readonly string[] {
  return commands.slice(from).filter((command) => command.captureId === captureId).map((command) => command.command);
}

/**
 * How the page's clock relates to Node's. Row changes are stamped in the page
 * (`Date.now()` there), commands in Node when Playwright reports them. The
 * page clock is read between two Node readings: `offsetMs` is the page time
 * minus the middle of those readings, and `toleranceMs` is their whole round
 * trip. That covers both the reading's own uncertainty (half the trip) and
 * how late Playwright's request events reach Node after the page saw them (at
 * most one way of a trip), so the checks treat any closer difference as no
 * difference.
 */
export interface PageClock {
  readonly offsetMs: number;
  readonly toleranceMs: number;
}

/** When the user's Cancel was given, and the clocks its checks compare. */
export interface CancelTiming {
  /** The page clock read just before the Cancel was clicked: every change it caused is stamped at or after it. */
  readonly cancelAt: number;
  readonly clock: PageClock;
}

/**
 * Why the row of `documentId` was not shown cancelling (取消中) while the
 * runtime delete `deletion` waited for its answer, then cancelled (已取消)
 * after it; undefined when it was. `deletion` is the page's own delete;
 * only the row's changes from the Cancel on count, so an earlier attempt's
 * 取消中 or 已取消 neither passes nor fails this one. Both checks compare
 * page times: the delete's Node times are moved onto the page clock.
 */
export function cancellingWhileDeletePendingProblem(
  changes: readonly RowChangeRecord[],
  documentId: string,
  deletion: Pick<PageCommandRecord, 'sentAt' | 'answeredAt'>,
  cancel: CancelTiming,
): string | undefined {
  if (deletion.answeredAt === undefined) return 'The runtime delete of the cancelled capture was not answered.';
  const answeredAt = deletion.answeredAt + cancel.clock.offsetMs;
  const tolerance = cancel.clock.toleranceMs;
  const rows = changes.filter((change) => change.documentId === documentId && change.at >= cancel.cancelAt);
  // The row may render 取消中 a moment after the page sent the delete, never before the Cancel.
  const cancellingWhilePending = rows.some((change) => change.cancelling && change.status === 'processing'
    && change.at <= answeredAt + tolerance);
  if (!cancellingWhilePending) return 'The row did not show 取消中 before the runtime delete was answered.';
  const cancelledAfter = rows.some((change) => change.status === 'cancelled' && change.cancelled
    && change.at >= answeredAt - tolerance);
  if (!cancelledAfter) return 'The row did not show 已取消 after the runtime delete was answered.';
  const cancelledBefore = rows.some((change) => change.status === 'cancelled' && change.at < answeredAt - tolerance);
  if (cancelledBefore) return 'The row showed 已取消 before the runtime delete was answered.';
  return undefined;
}

/** A turn from one capture to the next, as the checks of the command log read it. */
export interface Turn {
  readonly predecessor: string;
  /** The predecessor's terminal write. */
  readonly status: string;
  /** The predecessor row's status when the successor starts. */
  readonly shownStatus: string;
  readonly successor: string;
  /** The first command of the turn's part of the log. */
  readonly from?: number;
  /**
   * The page may have been on a page without the predecessor's row when the
   * successor started (the predecessor can end before the journey has
   * navigated to a page that shows both). Then the stored order alone proves
   * the turn; a row that was shown must still show `shownStatus`.
   */
  readonly predecessorRowOptional?: boolean;
}

/** The successor's first start from `turn.from` on: its in-progress write or its capture create. A `queued` write is the user's Start again, not a start. */
function successorStart(commands: readonly PageCommandRecord[], turn: Turn): PageCommandRecord | undefined {
  return commands.slice(turn.from ?? 0).find((command) =>
    (captureCreateCommands.has(command.command) && command.documentId === turn.successor)
    || (command.write?.documentId === turn.successor && command.write.status !== 'queued'));
}

function predecessorStatusesAt(start: PageCommandRecord | undefined, turn: Turn): readonly string[] {
  return (start?.shown ?? []).filter((row) => row.documentId === turn.predecessor).map((row) => row.status);
}

/** Whether the page showed the predecessor's row when it started the successor. */
export function predecessorShownAtStart(commands: readonly PageCommandRecord[], turn: Turn): boolean {
  return predecessorStatusesAt(successorStart(commands, turn), turn).length > 0;
}

/**
 * Why the turn did not pass from the predecessor to the successor only after
 * the predecessor's outcome; undefined when it did: from `from` on, the
 * successor's first start came after the predecessor's terminal write
 * (`status`) was answered, and when the page sent it the predecessor's row
 * showed `shownStatus` (or was not on the page, when that is allowed).
 */
export function turnProblem(commands: readonly PageCommandRecord[], turn: Turn): string | undefined {
  const from = turn.from ?? 0;
  const outcome = terminalWritesOf(commands, turn.predecessor, from)
    .find((command) => command.write?.status === turn.status && command.answeredAt !== undefined);
  if (!outcome?.answeredAt) return `The predecessor's ${turn.status} write was not answered.`;
  if (capturesCreatedFor(commands, turn.successor, from).length === 0) {
    return 'The successor was not created at the runtime.';
  }
  const first = successorStart(commands, turn);
  if (!first) return 'The successor was not started.';
  if (first.sentAt < outcome.answeredAt) return 'The successor was started before the predecessor\'s outcome was stored.';
  const shown = predecessorStatusesAt(first, turn);
  if (shown.length === 0) {
    return turn.predecessorRowOptional
      ? undefined
      : 'The page did not show the predecessor\'s row when it started the successor.';
  }
  if (!shown.every((status) => status === turn.shownStatus)) {
    return `The predecessor's row showed ${shown.join(', ')}, not ${turn.shownStatus}, when the successor was started.`;
  }
  return undefined;
}
