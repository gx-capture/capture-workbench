import { Injectable, inject } from '@angular/core';
import {
  Observable,
  defer,
  forkJoin,
  from,
  map,
  of,
  throwError,
} from 'rxjs';
import type {
  CaptureClient,
  CaptureDocumentV1,
  CaptureJobV1,
  CaptureSourceV1,
  CommitStructuredResultRequest,
  CreateCaptureRequest,
  RawCaptureV1,
  ReportStructuringFailureRequest,
  RuntimeInstallationV1,
  RuntimeReadyV1,
  RuntimeRequirementV1,
  StartRuntimeInstallationRequest,
} from '@gx-capture/capture-workbench';
import {
  DETERMINISTIC_COMPLETED_AT,
  DETERMINISTIC_CREATED_AT,
} from '../constants';
import type { FakeCaptureRecord } from '../contracts';
import { DeterministicDocumentService } from './deterministic-document.service';

@Injectable({ providedIn: 'root' })
export class DeterministicCaptureClientService implements CaptureClient {
  private readonly documents = inject(DeterministicDocumentService);
  private readonly captures = new Map<string, FakeCaptureRecord>();
  private readonly installations = new Map<string, RuntimeInstallationV1>();

  getReady(): Observable<RuntimeReadyV1> {
    return of({
      ready: true,
      service: 'capture-runtime',
      runtimeVersion: '0.3.0',
      apiVersion: '1.0',
      captureDocumentSchemaVersion: '1',
      capabilities: {
        captureKinds: ['pdf', 'image', 'audio'],
        structuringModes: ['runtime', 'host'],
        supportsCancellation: true,
        supportsRawDiagnostics: true,
        maxUploadBytes: 25_000_000,
      },
      message: 'Deterministic validation runtime',
    });
  }

  getRequirements(): Observable<readonly RuntimeRequirementV1[]> {
    return of([
      this.documents.readyRequirement('windowsml-ocr', 'WindowsML OCR', [
        'pdf',
        'image',
      ]),
      this.documents.readyRequirement('whisper-primary', 'Whisper STT', ['audio']),
      this.documents.readyRequirement('ollama-runtime', 'Isolated Ollama', [
        'runtime',
      ]),
      this.documents.readyRequirement(
        'capture-ollama-model',
        'Capture structure model',
        ['runtime'],
      ),
    ]);
  }

  startInstallation(
    request: StartRuntimeInstallationRequest,
  ): Observable<RuntimeInstallationV1> {
    return defer(() => {
      const installation: RuntimeInstallationV1 = {
        installationId: crypto.randomUUID(),
        requirementId: request.requirementId,
        status: 'completed',
        progress: 1,
        createdAt: DETERMINISTIC_CREATED_AT,
        updatedAt: DETERMINISTIC_COMPLETED_AT,
        completedAt: DETERMINISTIC_COMPLETED_AT,
      };
      this.installations.set(installation.installationId, installation);
      return of(installation);
    });
  }

  listInstallations(): Observable<readonly RuntimeInstallationV1[]> {
    return defer(() => of([...this.installations.values()]));
  }

  getInstallation(id: string): Observable<RuntimeInstallationV1> {
    return defer(() => of(this.requireInstallation(id)));
  }

  cancelInstallation(id: string): Observable<RuntimeInstallationV1> {
    return defer(() => {
      const current = this.requireInstallation(id);
      const canceled = {
        ...current,
        status: 'cancelled' as const,
        updatedAt: DETERMINISTIC_COMPLETED_AT,
      };
      this.installations.set(id, canceled);
      return of(canceled);
    });
  }

  createCapture(request: CreateCaptureRequest): Observable<CaptureJobV1> {
    return forkJoin({
      sourceText: from(request.file.text()),
      sha256: this.documents.sha256(request.file),
    }).pipe(
      map(({ sourceText: sourceTextValue, sha256: digest }) => {
        const captureId = crypto.randomUUID();
        const sourceText =
          sourceTextValue.trim() || `Captured ${request.file.name}`;
        const source: CaptureSourceV1 = {
          sha256: digest,
          fileName: request.file.name,
          mediaType:
            request.file.type || this.documents.fallbackMediaType(request.sourceKind),
          bytes: request.file.size,
        };
        const locator =
          request.sourceKind === 'audio'
            ? ({ kind: 'time', startMs: 0, endMs: 1500 } as const)
            : ({ kind: 'page', page: 1 } as const);
        const raw: RawCaptureV1 = {
          schemaVersion: '1',
          diagnosticOnly: true,
          source,
          segments: [{ segmentId: 'segment-1', order: 0, locator, text: sourceText }],
          sourceText,
          extractionEngine: {
            engine:
              request.sourceKind === 'audio' ? 'whisper-fake' : 'windowsml-fake',
            model:
              request.sourceKind === 'audio' ? 'whisper-primary' : 'windowsml-ocr',
            digest: `sha256:${'b'.repeat(64)}`,
          },
          warnings: [this.documents.warning()],
          createdAt: DETERMINISTIC_CREATED_AT,
        };
        const runtimeResult = this.documents.createCandidate(
          raw,
          'isolated-ollama-fake',
        );
        const completed = request.structuringMode === 'runtime';
        const job: CaptureJobV1 = {
          captureId,
          status: completed ? 'completed' : 'running',
          stage: completed ? 'completed' : 'awaiting_structuring',
          structuringMode: request.structuringMode,
          progress: completed ? 1 : 0.7,
          source,
          createdAt: DETERMINISTIC_CREATED_AT,
          updatedAt: completed
            ? DETERMINISTIC_COMPLETED_AT
            : DETERMINISTIC_CREATED_AT,
          completedAt: completed ? DETERMINISTIC_COMPLETED_AT : undefined,
        };
        this.captures.set(captureId, {
          job,
          raw,
          result: completed ? runtimeResult : undefined,
        });
        return job;
      }),
    );
  }

  getCapture(id: string): Observable<CaptureJobV1> {
    return defer(() => of(this.requireCapture(id).job));
  }

  cancelCapture(id: string): Observable<CaptureJobV1> {
    return defer(() => {
      const record = this.requireCapture(id);
      record.job = {
        ...record.job,
        status: 'cancelled',
        stage: 'cancelled',
        updatedAt: DETERMINISTIC_COMPLETED_AT,
        completedAt: DETERMINISTIC_COMPLETED_AT,
      };
      return of(record.job);
    });
  }

  getRaw(id: string): Observable<RawCaptureV1> {
    return defer(() => of(this.requireCapture(id).raw));
  }

  getResult(id: string): Observable<CaptureDocumentV1> {
    return defer(() => {
      const result = this.requireCapture(id).result;
      return result
        ? of(result)
        : throwError(() => new Error('result_unavailable'));
    });
  }

  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
  ): Observable<CaptureJobV1> {
    return defer(() => {
      const record = this.requireCapture(id);
      record.result = request.candidate;
      record.job = {
        ...record.job,
        status: 'completed',
        stage: 'completed',
        progress: 1,
        updatedAt: DETERMINISTIC_COMPLETED_AT,
        completedAt: DETERMINISTIC_COMPLETED_AT,
      };
      return of(record.job);
    });
  }

  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
  ): Observable<CaptureJobV1> {
    return defer(() => {
      const record = this.requireCapture(id);
      record.job = {
        ...record.job,
        status: 'failed',
        stage: 'failed',
        error: { ...request, stage: 'structuring' },
        updatedAt: DETERMINISTIC_COMPLETED_AT,
        completedAt: DETERMINISTIC_COMPLETED_AT,
      };
      return of(record.job);
    });
  }

  deleteCapture(id: string): Observable<void> {
    return defer(() => {
      this.captures.delete(id);
      return of(undefined);
    });
  }

  private requireCapture(id: string): FakeCaptureRecord {
    const capture = this.captures.get(id);
    if (!capture) throw new Error(`Unknown fake capture: ${id}`);
    return capture;
  }

  private requireInstallation(id: string): RuntimeInstallationV1 {
    const installation = this.installations.get(id);
    if (!installation) throw new Error(`Unknown fake installation: ${id}`);
    return installation;
  }
}
