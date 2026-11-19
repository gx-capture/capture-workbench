import { signal } from '@angular/core';
import {
  EMPTY,
  Subject,
  Subscription,
  type Observable,
  type SchedulerLike,
  asyncScheduler,
  catchError,
  defer,
  expand,
  filter,
  finalize,
  ignoreElements,
  map,
  of,
  switchMap,
  take,
  takeUntil,
  tap,
  timer,
} from 'rxjs';

/** What every tracked installation record carries. */
export interface TrackedRecord {
  readonly installationId: string;
  readonly status: string;
}

/** One installation the tracker knows, keyed by its installation id. */
export interface TrackedJob<T extends TrackedRecord> {
  readonly record: T;
  /** The last status request failed; the poll keeps retrying it. */
  readonly statusUnavailable: boolean;
  /** Increases with each newly seen installation, so the newest start can be found. */
  readonly startOrder: number;
}

type JobOutcome = 'completed' | 'failed' | 'cancelled' | 'vanished';

/** How an installation ended. `vanished`: the runtime no longer knows it, so there is no record. */
export interface JobEnd<T extends TrackedRecord> {
  readonly installationId: string;
  readonly outcome: JobOutcome;
  readonly record: T | null;
}

const POLL_INTERVAL_MS = 750;
const POLL_RETRY_FIRST_DELAY_MS = 1_000;
/** Failed requests are retried with doubling delays up to this cap, for as long as they keep failing. */
const POLL_RETRY_DELAY_CAP_MS = 8_000;

interface InstallationTrackerOptions<T extends TrackedRecord> {
  /** One status request for an installation id. */
  readonly get: (installationId: string) => Observable<T>;
  /** The runtime's installation list, newest first; `null` when there is none (a 404 then ends the job). */
  readonly list: (() => Observable<readonly T[]>) | null;
  /** Cancels an installation; `null` when installations of this kind cannot be cancelled. */
  readonly cancel: ((installationId: string) => Observable<T>) | null;
  /** True when the runtime answered definitively that the installation id does not exist. */
  readonly isNotFound: (error: unknown) => boolean;
  readonly scheduler?: SchedulerLike;
  readonly pollIntervalMs?: number;
  readonly firstRetryDelayMs?: number;
  readonly retryDelayCapMs?: number;
}

export function isActiveStatus(status: string): boolean {
  return status === 'queued' || status === 'running';
}

/** The end a terminal record stands for. */
export function endOfRecord<T extends TrackedRecord>(record: T): JobEnd<T> {
  const outcome: JobOutcome =
    record.status === 'completed' ? 'completed'
      : record.status === 'cancelled' ? 'cancelled'
        : 'failed';
  return { installationId: record.installationId, outcome, record };
}

/** The delay before the given consecutive retry (1, 2, 3, …): doubling from the first delay up to the cap. */
export function backoffDelayMs(
  failures: number,
  firstDelayMs = POLL_RETRY_FIRST_DELAY_MS,
  capMs = POLL_RETRY_DELAY_CAP_MS,
): number {
  return Math.min(firstDelayMs * 2 ** Math.max(0, failures - 1), capMs);
}

/** Where the poll of one installation id stands. */
interface PollStep {
  /** `status` asks for the installation; `resolve` asks the list after a definitive "not found". */
  readonly phase: 'status' | 'resolve';
  /** Wait before this step's request. */
  readonly waitMs: number;
  /** Consecutive failed requests in this phase. */
  readonly failures: number;
  /** Consecutive "not found" answers that the list contradicted by listing the id as running. */
  readonly disagreements: number;
}

/**
 * Tracks runtime installations by installation id. It owns all polling: one
 * poll per id, retried without limit on transient errors, resolved through the
 * installation list on a definitive "not found", and ended by a confirmed
 * cancel. Callers learn about ends from `ended$` / `endOf$`, never by owning a poll.
 */
export class InstallationTracker<T extends TrackedRecord> {
  private readonly jobsState = signal<ReadonlyMap<string, TrackedJob<T>>>(new Map());
  /** Every installation known, keyed by installation id. */
  readonly jobs = this.jobsState.asReadonly();

  private readonly ends = new Subject<JobEnd<T>>();
  /** Each installation's end, once, when it happens. */
  readonly ended$: Observable<JobEnd<T>> = this.ends.asObservable();

  private readonly polls = new Map<string, Subscription>();
  private readonly pastEnds = new Map<string, JobEnd<T>>();
  private readonly cancelConfirmed = new Subject<T>();
  private readonly options: InstallationTrackerOptions<T>;
  private readonly scheduler: SchedulerLike;
  private readonly pollIntervalMs: number;
  private readonly firstRetryDelayMs: number;
  private readonly retryDelayCapMs: number;
  private nextStartOrder = 0;

  constructor(options: InstallationTrackerOptions<T>) {
    this.options = options;
    this.scheduler = options.scheduler ?? asyncScheduler;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.firstRetryDelayMs = options.firstRetryDelayMs ?? POLL_RETRY_FIRST_DELAY_MS;
    this.retryDelayCapMs = options.retryDelayCapMs ?? POLL_RETRY_DELAY_CAP_MS;
  }

  /**
   * Starts following an installation. A terminal record is stored and nothing
   * more happens; an id that already has a poll is left to that poll; otherwise
   * one poll starts for the id.
   */
  follow(record: T): void {
    const installationId = record.installationId;
    if (this.polls.has(installationId)) return;
    this.store(record);
    if (!isActiveStatus(record.status)) return;
    const owner = new Subscription();
    this.polls.set(installationId, owner);
    owner.add(
      this.poll$(installationId)
        .pipe(
          finalize(() => {
            if (this.polls.get(installationId) === owner) this.polls.delete(installationId);
          }),
        )
        .subscribe(),
    );
  }

  /** The end of this installation id: replayed if it already ended, else the next one. */
  endOf$(installationId: string): Observable<JobEnd<T>> {
    return defer(() => {
      const past = this.pastEnds.get(installationId);
      return past
        ? of(past)
        : this.ended$.pipe(filter((end) => end.installationId === installationId), take(1));
    });
  }

  /**
   * Cancels an installation. Only a confirmed cancel stops its poll (in either
   * phase) and ends it as `cancelled`; a failed cancel leaves the poll running
   * and errors to the caller.
   */
  cancel$(installationId: string): Observable<T> {
    const cancel = this.options.cancel;
    if (!cancel) return EMPTY;
    return defer(() => cancel(installationId)).pipe(
      tap((record) => {
        this.cancelConfirmed.next(record);
        this.finish(installationId, 'cancelled', record);
      }),
    );
  }

  /** Forgets every installation that has ended, so a new one starts from a clean view. */
  forgetEnded(): void {
    this.jobsState.update((current) => {
      const next = new Map(current);
      for (const [installationId, job] of current) {
        if (!isActiveStatus(job.record.status)) next.delete(installationId);
      }
      return next;
    });
  }

  /** Stops every poll; the tracker is not used afterwards. */
  dispose(): void {
    for (const owner of [...this.polls.values()]) owner.unsubscribe();
    this.polls.clear();
    this.ends.complete();
    this.cancelConfirmed.complete();
  }

  /** One iterative loop for one installation id; it never subscribes to another poll. */
  private poll$(installationId: string): Observable<never> {
    const first: PollStep = {
      phase: 'status',
      waitMs: this.pollIntervalMs,
      failures: 0,
      disagreements: 0,
    };
    return of(first).pipe(
      expand((step) => this.wait$(step.waitMs).pipe(
        switchMap(() => step.phase === 'status'
          ? this.askStatus$(installationId, step)
          : this.askList$(installationId, step)),
      )),
      // A confirmed cancel ends the loop in either phase, even with a request in flight.
      takeUntil(this.cancelConfirmed.pipe(
        filter((record) => record.installationId === installationId),
      )),
      ignoreElements(),
    );
  }

  /** The next step after one status request, or nothing when the installation ended. */
  private askStatus$(installationId: string, step: PollStep): Observable<PollStep> {
    return defer(() => this.options.get(installationId)).pipe(
      map((record): PollStep | null => {
        this.store(record, false);
        if (!isActiveStatus(record.status)) {
          this.finish(installationId, endOfRecord(record).outcome, record);
          return null;
        }
        return { phase: 'status', waitMs: this.pollIntervalMs, failures: 0, disagreements: 0 };
      }),
      catchError((error: unknown) => {
        if (this.options.isNotFound(error)) {
          if (!this.options.list) {
            this.finish(installationId, 'vanished', null);
            return of(null);
          }
          return of<PollStep>({ phase: 'resolve', waitMs: 0, failures: 0, disagreements: step.disagreements });
        }
        this.markUnavailable(installationId);
        const failures = step.failures + 1;
        return of<PollStep>({
          phase: 'status',
          waitMs: this.backoff(failures),
          failures,
          disagreements: step.disagreements,
        });
      }),
      filter((next): next is PollStep => next !== null),
    );
  }

  /**
   * The next step after asking the list about an id the runtime said it does
   * not know. Other running installations in the list are followed by their own polls.
   */
  private askList$(installationId: string, step: PollStep): Observable<PollStep> {
    const list = this.options.list;
    if (!list) return EMPTY;
    return defer(list).pipe(
      map((items): PollStep | null => {
        // Newest first; follow oldest first so the newest gets the newest start order.
        for (const item of [...items].reverse()) {
          if (item.installationId !== installationId && isActiveStatus(item.status)) this.follow(item);
        }
        const listed = items.find((item) => item.installationId === installationId);
        if (!listed) {
          this.finish(installationId, 'vanished', null);
          return null;
        }
        if (!isActiveStatus(listed.status)) {
          this.store(listed, false);
          this.finish(installationId, endOfRecord(listed).outcome, listed);
          return null;
        }
        // The list says running while the status said "not found": ask again, backing off while they disagree.
        this.store(listed, true);
        const disagreements = step.disagreements + 1;
        return { phase: 'status', waitMs: this.backoff(disagreements), failures: 0, disagreements };
      }),
      catchError(() => {
        // A failed list never reads as "nothing running": stay here and ask again later.
        this.markUnavailable(installationId);
        const failures = step.failures + 1;
        return of<PollStep>({
          phase: 'resolve',
          waitMs: this.backoff(failures),
          failures,
          disagreements: step.disagreements,
        });
      }),
      filter((next): next is PollStep => next !== null),
    );
  }

  private wait$(ms: number): Observable<unknown> {
    return ms > 0 ? timer(ms, this.scheduler) : of(0);
  }

  private backoff(failures: number): number {
    return backoffDelayMs(failures, this.firstRetryDelayMs, this.retryDelayCapMs);
  }

  /** Stores a record; `statusUnavailable` keeps its value unless given. */
  private store(record: T, statusUnavailable?: boolean): void {
    this.jobsState.update((current) => {
      const next = new Map(current);
      const existing = current.get(record.installationId);
      next.set(record.installationId, {
        record,
        statusUnavailable: statusUnavailable ?? existing?.statusUnavailable ?? false,
        startOrder: existing?.startOrder ?? ++this.nextStartOrder,
      });
      return next;
    });
  }

  private markUnavailable(installationId: string): void {
    this.jobsState.update((current) => {
      const existing = current.get(installationId);
      if (!existing || existing.statusUnavailable) return current;
      const next = new Map(current);
      next.set(installationId, { ...existing, statusUnavailable: true });
      return next;
    });
  }

  /** Records the end of an installation once and announces it. */
  private finish(installationId: string, outcome: JobOutcome, record: T | null): void {
    if (this.pastEnds.has(installationId)) return;
    this.jobsState.update((current) => {
      const next = new Map(current);
      const existing = current.get(installationId);
      if (outcome === 'vanished' || !record) {
        next.delete(installationId);
      } else {
        next.set(installationId, {
          record,
          statusUnavailable: false,
          startOrder: existing?.startOrder ?? ++this.nextStartOrder,
        });
      }
      return next;
    });
    const end: JobEnd<T> = { installationId, outcome, record };
    this.pastEnds.set(installationId, end);
    this.ends.next(end);
  }
}
