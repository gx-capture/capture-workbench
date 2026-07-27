import { Injectable, inject } from '@angular/core';
import {
  HttpCaptureClient,
  type CaptureClient,
  type CaptureDocumentV1,
  type CaptureJobV1,
  type CaptureStructuringProvider,
  type CommitStructuredResultRequest,
  type CreateCaptureRequest,
  type RawCaptureV1,
  type ReportStructuringFailureRequest,
  type RuntimeInstallationV1,
  type RuntimeReadyV1,
  type RuntimeRequirementV1,
  type StartRuntimeInstallationRequest,
} from '@gx-capture/capture-workbench';
import {
  Observable,
  catchError,
  defer,
  map,
  of,
  shareReplay,
  switchMap,
  throwError,
} from 'rxjs';
import {
  UNCONFIGURED_CAPTURE_CLIENT_ERROR,
} from '../constants';
import type { ValidationCaptureClientMode } from '../contracts';
import { ValidationEnvironmentService } from './validation-environment.service';
import { ValidationCaptureFixtureService } from './validation-fixture.service';
import { ValidationRuntimeReadinessService } from './validation-runtime-readiness.service';

@Injectable({ providedIn: 'root' })
export class ValidationCaptureClientService implements CaptureClient {
  private readonly environment = inject(ValidationEnvironmentService);
  private readonly fixtureService = inject(ValidationCaptureFixtureService);
  private readonly readiness = inject(ValidationRuntimeReadinessService);
  private readonly fixture = this.fixtureService.select();
  private delegateObservable?: Observable<CaptureClient>;

  readonly mode: ValidationCaptureClientMode = this.environment.tauri
    ? 'tauri-http'
    : this.fixture?.mode ?? 'browser-unconfigured';
  readonly hostStructuringAvailable =
    !this.environment.tauri && this.fixture !== undefined;
  readonly structuringProvider: CaptureStructuringProvider | undefined =
    this.environment.tauri ? undefined : this.fixture?.structuringProvider;

  getReady(signal?: AbortSignal): Observable<RuntimeReadyV1> {
    return this.delegate().pipe(switchMap((client) => client.getReady(signal)));
  }

  getRequirements(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeRequirementV1[]> {
    return this.delegate().pipe(
      switchMap((client) => client.getRequirements(signal)),
    );
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1> {
    return this.delegate().pipe(
      switchMap((client) => client.startInstallation(request, signal)),
    );
  }

  listInstallations(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeInstallationV1[]> {
    return this.delegate().pipe(
      switchMap((client) => client.listInstallations(signal)),
    );
  }

  getInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1> {
    return this.delegate().pipe(
      switchMap((client) => client.getInstallation(id, signal)),
    );
  }

  cancelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1> {
    return this.delegate().pipe(
      switchMap((client) => client.cancelInstallation(id, signal)),
    );
  }

  createCapture(request: CreateCaptureRequest): Observable<CaptureJobV1> {
    return this.delegate().pipe(
      switchMap((client) => client.createCapture(request)),
    );
  }

  getCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.delegate().pipe(
      switchMap((client) => client.getCapture(id, signal)),
    );
  }

  cancelCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1> {
    return this.delegate().pipe(
      switchMap((client) => client.cancelCapture(id, signal)),
    );
  }

  getRaw(id: string, signal?: AbortSignal): Observable<RawCaptureV1> {
    return this.delegate().pipe(
      switchMap((client) => client.getRaw(id, signal)),
    );
  }

  getResult(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureDocumentV1> {
    return this.delegate().pipe(
      switchMap((client) => client.getResult(id, signal)),
    );
  }

  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    return this.delegate().pipe(
      switchMap((client) =>
        client.commitStructuredResult(id, request, signal),
      ),
    );
  }

  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1> {
    return this.delegate().pipe(
      switchMap((client) =>
        client.reportStructuringFailure(id, request, signal),
      ),
    );
  }

  deleteCapture(id: string, signal?: AbortSignal): Observable<void> {
    return this.delegate().pipe(
      switchMap((client) => client.deleteCapture(id, signal)),
    );
  }

  private delegate(): Observable<CaptureClient> {
    if (!this.delegateObservable) {
      this.delegateObservable = defer(() => this.loadDelegate()).pipe(
        catchError((error: unknown) => {
          this.delegateObservable = undefined;
          return throwError(() => error);
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.delegateObservable;
  }

  private loadDelegate(): Observable<CaptureClient> {
    if (this.environment.tauri) {
      return this.readiness.waitUntilReady().pipe(
        switchMap(() => this.environment.loadBackendConfig()),
        map(
          (backend) =>
            new HttpCaptureClient({
              baseUrl: backend.baseUrl,
              bearerToken: backend.token,
            }),
        ),
      );
    }
    if (this.fixture) return of(this.fixture.client);
    return throwError(() => new Error(UNCONFIGURED_CAPTURE_CLIENT_ERROR));
  }
}
