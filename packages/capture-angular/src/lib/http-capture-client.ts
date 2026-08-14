import {
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import {
  CaptureRuntimeClient,
  CaptureRuntimeError,
  type RuntimeTransport,
} from '@gx-capture/capture-runtime-client';
import { catchError, defer, from, Observable, throwError } from 'rxjs';

import { CaptureHttpError } from './capture-http-error';
import {
  CAPTURE_CLIENT,
  type CaptureClient,
  type CaptureEvent,
  type CaptureEventStreamOptions,
  type CaptureOperation,
  type CaptureStreamingResult,
  type CommitStreamingStructuredResultRequest,
  type PartialCapture,
  type RawCapture,
  type ReportStreamingStructuringFailureRequest,
  type RuntimeInstallation,
  type RuntimeReady,
  type RuntimeRequirement,
  type StartRuntimeInstallationRequest,
  type StartStreamingCaptureRequest,
} from './contracts';

export { CaptureHttpError } from './capture-http-error';

/**
 * The browser-facing adapter accepts only a host-owned transport. Sidecar
 * origins and bearer credentials must stay in the trusted host process.
 */
export interface CaptureHttpClientOptions {
  readonly transport: RuntimeTransport;
}

const CAPTURE_HTTP_CLIENT_OPTIONS =
  new InjectionToken<CaptureHttpClientOptions>('CAPTURE_HTTP_CLIENT_OPTIONS');

/** RxJS adapter over the canonical strict v2 Capture Runtime SDK. */
export class HttpCaptureClient implements CaptureClient {
  private readonly runtime: CaptureRuntimeClient;
  private discovery?: Promise<RuntimeReady>;

  constructor(options: CaptureHttpClientOptions) {
    if (!options.transport || typeof options.transport.request !== 'function') {
      throw new CaptureHttpError(
        0,
        'browser_transport_required',
        'Capture Workbench requires a host-provided RuntimeTransport.',
      );
    }
    this.runtime = new CaptureRuntimeClient(options.transport);
  }

  getReady(signal?: AbortSignal): Observable<RuntimeReady> {
    return this.fromRuntime(() => {
      const active =
        this.discovery ??
        this.runtime.discover(signal).then((discovery) => discovery.ready);
      this.discovery = active.catch((error: unknown) => {
        this.discovery = undefined;
        throw error;
      });
      return this.discovery;
    });
  }

  getRequirements(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeRequirement[]> {
    return this.fromRuntime(() => this.runtime.getRequirements(signal));
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation> {
    return this.fromRuntime(() =>
      this.runtime.startInstallation(
        request.requirementId,
        request.clientRequestId,
        signal,
      ),
    );
  }

  listInstallations(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeInstallation[]> {
    return this.fromRuntime(() => this.runtime.listInstallations(signal));
  }

  getInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation> {
    return this.fromRuntime(() => this.runtime.getInstallation(id, signal));
  }

  cancelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation> {
    return this.fromRuntime(() => this.runtime.cancelInstallation(id, signal));
  }

  captureEvents(
    id: string,
    options: CaptureEventStreamOptions = {},
  ): Observable<CaptureEvent> {
    return new Observable<CaptureEvent>((subscriber) => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      if (options.signal?.aborted) controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      void (async () => {
        try {
          for await (const event of this.runtime.captureEvents(id, {
            lastEventId: options.lastEventId,
            signal: controller.signal,
          })) {
            if (subscriber.closed) return;
            subscriber.next(event);
          }
          if (!subscriber.closed) subscriber.complete();
        } catch (error) {
          if (!subscriber.closed) subscriber.error(toCaptureHttpError(error));
        }
      })();
      return () => {
        options.signal?.removeEventListener('abort', abort);
        controller.abort();
      };
    });
  }

  startStreamingCapture(
    request: StartStreamingCaptureRequest,
  ): Observable<CaptureOperation> {
    return this.fromRuntime(() =>
      this.runtime.startStreamingCapture({
        clientRequestId: request.clientRequestId,
        fileName: request.file.name,
        body: request.file,
        mediaType: request.file.type || mediaTypeFor(request.sourceKind),
        sourceKind: request.sourceKind,
        structuringMode: request.structuringMode,
        targetLanguage: request.targetLanguage,
        signal: request.signal,
      }),
    );
  }

  getStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperation> {
    return this.fromRuntime(() => this.runtime.getStreamingCapture(id, signal));
  }

  cancelStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperation> {
    return this.fromRuntime(() =>
      this.runtime.cancelStreamingCapture(id, signal),
    );
  }

  getStreamingPartial(
    id: string,
    signal?: AbortSignal,
  ): Observable<PartialCapture> {
    return this.fromRuntime(() => this.runtime.getStreamingPartial(id, signal));
  }

  getStreamingRaw(id: string, signal?: AbortSignal): Observable<RawCapture> {
    return this.fromRuntime(() => this.runtime.getRaw(id, signal));
  }

  getStreamingResult(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureStreamingResult> {
    return this.fromRuntime(() => this.runtime.getStreamingResult(id, signal));
  }

  commitStreamingStructuredResult(
    id: string,
    request: CommitStreamingStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperation> {
    return this.fromRuntime(() =>
      this.runtime.commitStreamingStructuredResult(
        id,
        request.candidate,
        request.clientRequestId,
        signal,
      ),
    );
  }

  reportStreamingStructuringFailure(
    id: string,
    request: ReportStreamingStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperation> {
    return this.fromRuntime(() =>
      this.runtime.reportStreamingStructuringFailure(
        id,
        request.code,
        request.message,
        request.clientRequestId ?? crypto.randomUUID(),
        signal,
      ),
    );
  }

  deleteStreamingCapture(id: string, signal?: AbortSignal): Observable<void> {
    return this.fromRuntime(() => this.runtime.deleteCapture(id, signal));
  }

  private fromRuntime<T>(operation: () => Promise<T>): Observable<T> {
    return defer(() => from(operation())).pipe(
      catchError((error: unknown) =>
        throwError(() => toCaptureHttpError(error)),
      ),
    );
  }
}

export function provideHttpCaptureClient(
  options: CaptureHttpClientOptions,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: CAPTURE_HTTP_CLIENT_OPTIONS, useValue: options },
    {
      provide: HttpCaptureClient,
      useFactory: () =>
        new HttpCaptureClient(inject(CAPTURE_HTTP_CLIENT_OPTIONS)),
    },
    { provide: CAPTURE_CLIENT, useExisting: HttpCaptureClient },
  ]);
}

function toCaptureHttpError(error: unknown): unknown {
  if (error instanceof DOMException && error.name === 'AbortError')
    return error;
  if (error instanceof CaptureHttpError) return error;
  if (error instanceof CaptureRuntimeError) {
    return new CaptureHttpError(
      error.status,
      error.code,
      error.message,
      error.details,
    );
  }
  return error;
}

function mediaTypeFor(
  kind: StartStreamingCaptureRequest['sourceKind'],
): string {
  return kind === 'pdf'
    ? 'application/pdf'
    : kind === 'image'
      ? 'image/*'
      : 'audio/*';
}
