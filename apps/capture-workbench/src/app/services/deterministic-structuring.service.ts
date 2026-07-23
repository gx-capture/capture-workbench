import { Injectable, inject } from '@angular/core';
import { Observable, defer, of, throwError } from 'rxjs';
import type {
  CaptureDocumentV1,
  CaptureStructuringProvider,
  CaptureStructuringRequest,
} from '@gx/capture-workbench';
import { DeterministicDocumentService } from './deterministic-document.service';

@Injectable({ providedIn: 'root' })
export class DeterministicStructuringProviderService
  implements CaptureStructuringProvider
{
  private readonly documents = inject(DeterministicDocumentService);

  structure({
    raw,
    documentContract,
    signal,
    reportProgress,
  }: CaptureStructuringRequest): Observable<CaptureDocumentV1> {
    return defer(() => {
      if (signal.aborted) {
        return throwError(() => new DOMException('Aborted', 'AbortError'));
      }
      if (documentContract.schemaVersion !== raw.schemaVersion) {
        return throwError(
          () => new Error('Capture document contract version mismatch.'),
        );
      }
      reportProgress(50);
      reportProgress(100);
      return of(this.documents.createCandidate(raw, 'host-provider-fake'));
    });
  }
}
