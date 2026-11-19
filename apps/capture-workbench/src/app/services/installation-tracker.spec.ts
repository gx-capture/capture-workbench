import { type Observable, of, Subject, throwError } from 'rxjs';
import { InstallationTracker, type JobEnd } from './installation-tracker';

interface FakeInstallation {
  readonly installationId: string;
  readonly requirementId: string;
  readonly status: string;
}

function job(installationId: string, status: string, requirementId = 'text-recognition'): FakeInstallation {
  return { installationId, requirementId, status };
}

function unreadable(): Observable<never> {
  return throwError(() => new Error('Capture Runtime response could not be read.'));
}

function notFound(): Observable<never> {
  return throwError(() => new Error('Capture Runtime request was rejected with HTTP 404.'));
}

/** Trackers made by a test; disposed after it so no poll outlives it. */
const createdTrackers: InstallationTracker<FakeInstallation>[] = [];

function createTracker(options: {
  readonly get: (installationId: string) => Observable<FakeInstallation>;
  readonly list?: (() => Observable<readonly FakeInstallation[]>) | null;
  readonly cancel?: (installationId: string) => Observable<FakeInstallation>;
}) {
  const get = vi.fn(options.get);
  const list = options.list === null ? null : vi.fn(options.list ?? (() => of([])));
  const cancel = vi.fn(options.cancel ?? ((installationId: string) => of(job(installationId, 'cancelled'))));
  const tracker = new InstallationTracker<FakeInstallation>({
    get,
    list,
    cancel,
    isNotFound: (error) => error instanceof Error && error.message.includes('HTTP 404'),
  });
  createdTrackers.push(tracker);
  const ends: JobEnd<FakeInstallation>[] = [];
  tracker.ended$.subscribe((end) => ends.push(end));
  return { tracker, get, list, cancel, ends };
}

describe('InstallationTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const tracker of createdTrackers.splice(0)) tracker.dispose();
    vi.useRealTimers();
  });

  it('retries a failed status request after 1, 2, 4, 8 and 8 s, one boundary at a time', () => {
    const { tracker, get } = createTracker({ get: () => unreadable() });
    tracker.follow(job('a', 'running'));

    vi.advanceTimersByTime(749);
    expect(get).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(true);

    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 8_000].entries()) {
      vi.advanceTimersByTime(delay - 1);
      expect(get).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(1);
      expect(get).toHaveBeenCalledTimes(index + 2);
    }
    expect(tracker.jobs().get('a')?.record.status).toBe('running');
  });

  it('polls every 750 ms again after an answer and starts the backoff afresh at 1 s', () => {
    const get = vi.fn<(installationId: string) => Observable<FakeInstallation>>()
      .mockReturnValueOnce(unreadable())
      .mockReturnValueOnce(unreadable())
      .mockReturnValueOnce(of(job('a', 'running')))
      .mockReturnValueOnce(of(job('a', 'running')))
      .mockReturnValueOnce(unreadable())
      .mockReturnValueOnce(of(job('a', 'running')));
    const { tracker } = createTracker({ get });
    tracker.follow(job('a', 'running'));

    vi.advanceTimersByTime(750); // 1: fails
    vi.advanceTimersByTime(1_000); // 2: fails
    vi.advanceTimersByTime(2_000); // 3: answers running
    expect(get).toHaveBeenCalledTimes(3);
    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(false);

    vi.advanceTimersByTime(749);
    expect(get).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1); // 4: answers running, 750 ms later
    expect(get).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(750); // 5: fails
    expect(get).toHaveBeenCalledTimes(5);
    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(true);

    vi.advanceTimersByTime(999);
    expect(get).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(1); // 6: a fresh 1 s, not 4 s
    expect(get).toHaveBeenCalledTimes(6);
    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(false);
  });

  it('asks again with backoff while a 404 and a listing of the same id as running disagree, one request at a time', () => {
    const get = vi.fn<(installationId: string) => Observable<FakeInstallation>>()
      .mockReturnValueOnce(notFound())
      .mockReturnValueOnce(notFound())
      .mockReturnValue(of(job('a', 'running')));
    const { tracker, list } = createTracker({ get, list: () => of([job('a', 'running')]) });
    tracker.follow(job('a', 'running'));

    vi.advanceTimersByTime(750);
    expect(get).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    // The listing answered, so there is no retry hint (a failed listing sets it, see below).
    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(false);

    vi.advanceTimersByTime(999);
    expect(get).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);

    // The second disagreement backs off to 2 s.
    vi.advanceTimersByTime(1_999);
    expect(get).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(get).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(false);

    // One poll: exactly one request per interval.
    vi.advanceTimersByTime(750);
    expect(get).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(750);
    expect(get).toHaveBeenCalledTimes(5);
  });

  it('ends with the listed record when a 404 is followed by a listing of the id as ended', () => {
    const { tracker, get, ends } = createTracker({
      get: () => notFound(),
      list: () => of([job('a', 'completed')]),
    });
    tracker.follow(job('a', 'running'));

    vi.advanceTimersByTime(750);

    expect(ends).toEqual([{ installationId: 'a', outcome: 'completed', record: job('a', 'completed') }]);
    expect(tracker.jobs().get('a')?.record.status).toBe('completed');
    vi.advanceTimersByTime(60_000);
    expect(get).toHaveBeenCalledOnce();
  });

  it('ends as vanished and drops the record when the listing no longer has the id', () => {
    const { tracker, get, ends } = createTracker({ get: () => notFound(), list: () => of([]) });
    tracker.follow(job('a', 'running'));

    vi.advanceTimersByTime(750);

    expect(ends).toEqual([{ installationId: 'a', outcome: 'vanished', record: null }]);
    expect(tracker.jobs().has('a')).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(get).toHaveBeenCalledOnce();
  });

  it('ends a 404 as vanished at once when there is no list (model installations)', () => {
    const { tracker, ends } = createTracker({ get: () => notFound(), list: null });
    tracker.follow(job('m', 'running'));

    vi.advanceTimersByTime(750);

    expect(ends).toEqual([{ installationId: 'm', outcome: 'vanished', record: null }]);
    expect(tracker.jobs().has('m')).toBe(false);
  });

  it('retries a failed listing with backoff instead of reading it as nothing running', () => {
    const list = vi.fn<() => Observable<readonly FakeInstallation[]>>()
      .mockReturnValueOnce(unreadable())
      .mockReturnValueOnce(unreadable())
      .mockReturnValueOnce(of([job('a', 'completed')]));
    const { tracker, ends } = createTracker({ get: () => notFound(), list });
    tracker.follow(job('a', 'running'));

    vi.advanceTimersByTime(750);
    expect(list).toHaveBeenCalledTimes(1);
    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(true);
    vi.advanceTimersByTime(999);
    expect(list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(list).toHaveBeenCalledTimes(2);
    expect(ends).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(list).toHaveBeenCalledTimes(3);
    expect(ends.map((end) => end.outcome)).toEqual(['completed']);
  });

  it('tracks two live installations of one requirement separately', () => {
    const { tracker } = createTracker({
      get: (installationId) => (installationId === 'a' ? unreadable() : of(job('b', 'running'))),
    });
    tracker.follow(job('a', 'running'));
    tracker.follow(job('b', 'running'));

    vi.advanceTimersByTime(750);

    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(true);
    expect(tracker.jobs().get('b')?.statusUnavailable).toBe(false);
    expect(tracker.jobs().get('b')?.startOrder ?? 0).toBeGreaterThan(tracker.jobs().get('a')?.startOrder ?? 0);
  });

  it('keeps one poll per id when a start, a re-attach and a resolution all find it', () => {
    const { tracker, get } = createTracker({
      get: (installationId) => (installationId === 'b' ? notFound() : of(job('a', 'running'))),
      list: () => of([job('b', 'running'), job('a', 'running')]),
    });
    const callsFor = (installationId: string) =>
      get.mock.calls.filter(([id]) => id === installationId).length;
    tracker.follow(job('a', 'running')); // the start
    tracker.follow(job('a', 'running')); // a re-attach listing it
    tracker.follow(job('b', 'running')); // b's 404 resolution lists a again

    vi.advanceTimersByTime(750);
    expect(callsFor('a')).toBe(1);
    vi.advanceTimersByTime(750);
    expect(callsFor('a')).toBe(2);
    vi.advanceTimersByTime(750 * 4);
    expect(callsFor('a')).toBe(6);
  });

  it('ends as cancelled on a cancel confirmed while a status request keeps failing, then asks nothing more', () => {
    const { tracker, get, ends } = createTracker({ get: () => unreadable() });
    tracker.follow(job('a', 'running'));
    vi.advanceTimersByTime(750);

    tracker.cancel$('a').subscribe();

    expect(ends).toEqual([{ installationId: 'a', outcome: 'cancelled', record: job('a', 'cancelled') }]);
    expect(tracker.jobs().get('a')?.statusUnavailable).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(get).toHaveBeenCalledOnce();
  });

  it('ends as cancelled on a cancel confirmed while the listing is pending', () => {
    const listing = new Subject<readonly FakeInstallation[]>();
    const { tracker, get, ends } = createTracker({ get: () => notFound(), list: () => listing });
    tracker.follow(job('a', 'running'));
    vi.advanceTimersByTime(750);
    expect(listing.observed).toBe(true);

    tracker.cancel$('a').subscribe();

    expect(listing.observed).toBe(false);
    expect(ends.map((end) => end.outcome)).toEqual(['cancelled']);
    listing.next([]);
    vi.advanceTimersByTime(60_000);
    expect(ends.map((end) => end.outcome)).toEqual(['cancelled']);
    expect(get).toHaveBeenCalledOnce();
  });

  it('keeps polling after a failed cancel and reports the failure to the caller', () => {
    const { tracker, get, ends } = createTracker({
      get: () => of(job('a', 'running')),
      cancel: () => unreadable(),
    });
    tracker.follow(job('a', 'running'));
    vi.advanceTimersByTime(750);
    const errors: unknown[] = [];

    tracker.cancel$('a').subscribe({ error: (error: unknown) => errors.push(error) });
    vi.advanceTimersByTime(750 * 2);

    expect(errors).toHaveLength(1);
    expect(ends).toEqual([]);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('replays an end that already happened to endOf$', () => {
    const { tracker } = createTracker({ get: () => of(job('a', 'completed')) });
    tracker.follow(job('a', 'running'));
    vi.advanceTimersByTime(750);

    const seen: JobEnd<FakeInstallation>[] = [];
    tracker.endOf$('a').subscribe((end) => seen.push(end));

    expect(seen).toEqual([{ installationId: 'a', outcome: 'completed', record: job('a', 'completed') }]);
  });

  it('stores a terminal record without polling or announcing an end', () => {
    const { tracker, get, ends } = createTracker({ get: () => of(job('a', 'running')) });
    tracker.follow(job('a', 'failed'));
    vi.advanceTimersByTime(60_000);

    expect(tracker.jobs().get('a')?.record.status).toBe('failed');
    expect(get).not.toHaveBeenCalled();
    expect(ends).toEqual([]);
  });

  it('stops every poll on dispose', () => {
    const { tracker, get } = createTracker({ get: () => of(job('a', 'running')) });
    tracker.follow(job('a', 'running'));
    vi.advanceTimersByTime(750);

    tracker.dispose();
    vi.advanceTimersByTime(60_000);

    expect(get).toHaveBeenCalledOnce();
  });
});
