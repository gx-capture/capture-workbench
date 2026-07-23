import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { CaptureClient, CaptureJobV1 } from '../../../contracts';
import { provideCaptureWorkbenchInputs } from '../../../contracts';
import { Subject, map, of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-angular';
import {
  CaptureWorkbenchTestInputSource,
  DOCUMENT,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
  job,
  selectFiles,
} from './capture-angular-test-support';

describe('CaptureWorkbenchComponent', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;
  let inputSource: CaptureWorkbenchTestInputSource;

  beforeEach(async () => {
    inputSource = createCaptureWorkbenchTestInputSource();
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
      providers: [provideCaptureWorkbenchInputs(inputSource)],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  it('emits a runtime-validated canonical result', async () => {
    const client = fakeClient();
    const completed = vi.fn();
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(client.createCapture).toHaveBeenCalledOnce();
    expect(client.getResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(completed).toHaveBeenCalledWith({
      taskId: expect.any(String),
      document: DOCUMENT,
    });
    expect(
      fixture.nativeElement.querySelector('.result-preview').textContent,
    ).toContain('page one');
  });

  it('polls queued jobs through rxResource until completion without overlap', async () => {
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValue(of(job('queued', 'queued')));
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockReturnValueOnce(of(job('running', 'extracting')))
      .mockReturnValueOnce(of(job('completed', 'completed')));
    const client = fakeClient({ createCapture, getCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'queued.pdf')]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getCapture).toHaveBeenCalledTimes(2);
    expect(getCapture.mock.invocationCallOrder[0]).toBeLessThan(
      getCapture.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(fixture.componentInstance.tasks()[0]?.status).toBe('completed');
    expect(client.getResult).toHaveBeenCalledOnce();
  });

  it('stops host polling at awaiting_structuring and does not poll after commit', async () => {
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValue(of(job('running', 'extracting', 'host')));
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockReturnValue(of(job('running', 'awaiting_structuring', 'host')));
    const structure = vi.fn(() => of(DOCUMENT));
    const client = fakeClient({ createCapture, getCapture });
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'host.pdf')]);
    await fixture.whenStable();

    expect(getCapture).toHaveBeenCalledOnce();
    expect(structure).toHaveBeenCalledOnce();
    expect(client.commitStructuredResult).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(client.getResult).toHaveBeenCalledOnce());
  });

  it('cancels an in-flight rxResource poll without applying a late result', async () => {
    const pendingPoll = new Subject<CaptureJobV1>();
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValue(of(job('queued', 'queued')));
    const getCapture = vi.fn<CaptureClient['getCapture']>(() =>
      pendingPoll.asObservable(),
    );
    const client = fakeClient({ createCapture, getCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'cancel.pdf')]);
    await vi.waitFor(() => expect(getCapture).toHaveBeenCalledOnce());
    const taskId = fixture.componentInstance.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected a capture task.');

    fixture.componentInstance.store.cancel(taskId);
    pendingPoll.next(job('completed', 'completed'));
    pendingPoll.complete();
    await fixture.whenStable();

    expect(fixture.componentInstance.tasks()[0]?.status).toBe('canceled');
    expect(client.getResult).not.toHaveBeenCalled();
    expect(getCapture.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it('retries an uncertain capture creation with the same request and file', async () => {
    const source = new File(['test'], 'scan.pdf', {
      type: 'application/pdf',
    });
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValueOnce(throwError(() => new TypeError('connection reset')))
      .mockReturnValueOnce(of(job('completed', 'completed')));
    const client = fakeClient({ createCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [source]);
    await fixture.whenStable();

    expect(createCapture).toHaveBeenCalledTimes(2);
    const firstRequest = createCapture.mock.calls[0]?.[0];
    const retryRequest = createCapture.mock.calls[1]?.[0];
    expect(firstRequest).toBe(retryRequest);
    expect(firstRequest?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(retryRequest?.clientRequestId).toBe(firstRequest?.clientRequestId);
    expect(firstRequest?.file).toBe(source);
    expect(retryRequest?.file).toBe(source);
    expect(client.getCapture).not.toHaveBeenCalled();
    expect(client.getResult).toHaveBeenCalledOnce();
  });

  it('does not retry capture creation after an abort response', async () => {
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValueOnce(
        throwError(
          () => new DOMException('The operation was aborted.', 'AbortError'),
        ),
      );
    const client = fakeClient({ createCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(createCapture).toHaveBeenCalledOnce();
    expect(client.getCapture).not.toHaveBeenCalled();
    expect(client.getResult).not.toHaveBeenCalled();
    expect(fixture.componentInstance.tasks()[0]?.status).toBe('canceled');
  });

  it('does not retry a plain domain error from a custom capture client', async () => {
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValueOnce(
        throwError(() => new Error('host validation rejected the request')),
      );
    const client = fakeClient({ createCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(createCapture).toHaveBeenCalledOnce();
    expect(client.getCapture).not.toHaveBeenCalled();
    expect(fixture.componentInstance.tasks()[0]?.status).toBe('failed');
  });

  it('keeps later files queued and supports canceling them', async () => {
    const preprocessing = new Subject<void>();
    const release = (): void => {
      preprocessing.next();
      preprocessing.complete();
    };
    const client = fakeClient();
    inputSource.client.set(client);
    inputSource.preprocessor.set({
      preprocess: vi.fn(({ file }) => preprocessing.pipe(map(() => file))),
    });
    inputSource.config.set({
      concurrency: 1,
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['1'], 'one.pdf'),
      new File(['2'], 'two.pdf'),
    ]);
    const second = fixture.componentInstance.tasks()[1];
    expect(second?.status).toBe('queued');
    if (!second) throw new Error('Expected the second task to be queued.');
    fixture.componentInstance.store.cancel(second.id);
    expect(fixture.componentInstance.tasks()[1]?.status).toBe('canceled');

    release();
    await fixture.whenStable();
    expect(client.createCapture).toHaveBeenCalledOnce();
  });
});
