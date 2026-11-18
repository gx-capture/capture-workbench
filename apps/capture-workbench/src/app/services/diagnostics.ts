import type {
  CaptureEngine,
  OcrComputePreflight,
} from '@gx-capture/capture-workbench-ui';
import type {
  DesktopLibraryDetail,
  DesktopRuntimeStatus,
  OcrEvidenceV1,
} from '../contracts';
import type { DesktopMessages } from '../i18n/desktop-messages';

export interface DiagnosticsRuntimeView {
  readonly state: 'starting' | 'ready' | 'error';
  readonly statusLabel: string;
  readonly errorMessage: string | null;
  readonly runtimeVersion: string | null;
  readonly apiVersion: string | null;
  readonly contractSetVersion: string | null;
  readonly contractSha256: string | null;
}

export interface EngineProvenanceView {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly digest: string;
}

export interface DocumentProvenanceView {
  readonly extraction: EngineProvenanceView | null;
  readonly structuring: EngineProvenanceView | null;
}

export interface DiagnosticsEvidenceView {
  readonly status: OcrEvidenceV1['status'];
  readonly pageCount: number;
  readonly digest: string;
}

export interface DiagnosticsDocumentView {
  readonly documentId: string;
  readonly fileName: string;
  readonly extraction: EngineProvenanceView | null;
  readonly structuring: EngineProvenanceView | null;
  readonly evidence: DiagnosticsEvidenceView | null;
  readonly canExportJson: boolean;
}

export function buildDiagnosticsRuntimeView(input: {
  readonly state: 'starting' | 'ready' | 'error';
  readonly runtimeStatusMessage: string;
  /** Null while the readiness check has failed: there is no status to show then. */
  readonly runtimeStatus: DesktopRuntimeStatus | null;
  readonly ocrCompute: OcrComputePreflight | null;
  readonly messages: DesktopMessages;
}): DiagnosticsRuntimeView {
  const { state, runtimeStatusMessage, runtimeStatus, ocrCompute, messages } =
    input;
  const statusLabel =
    state === 'ready'
      ? messages.ready
      : state === 'error'
        ? messages.diagnosticsRuntimeError
        : messages.starting;
  return {
    state,
    statusLabel,
    errorMessage:
      state === 'error'
        ? nonEmpty(runtimeStatusMessage) ?? nonEmpty(runtimeStatus?.detail)
        : null,
    runtimeVersion: nonEmpty(
      runtimeStatus?.runtimeVersion ?? ocrCompute?.runtimeVersion,
    ),
    apiVersion: nonEmpty(runtimeStatus?.apiVersion ?? ocrCompute?.apiVersion),
    contractSetVersion: nonEmpty(
      runtimeStatus?.contractSetVersion ?? ocrCompute?.contractSetVersion,
    ),
    contractSha256: nonEmpty(ocrCompute?.contractSha256),
  };
}

export function buildDocumentProvenance(
  detail: Pick<DesktopLibraryDetail, 'raw' | 'result'>,
): DocumentProvenanceView {
  const extractionSource =
    detail.result?.extractionEngine ?? detail.raw?.extractionEngine ?? null;
  const structuringSource = detail.result?.structuringEngine ?? null;
  return {
    extraction: extractionSource ? toEngineProvenance(extractionSource) : null,
    structuring: structuringSource
      ? toEngineProvenance(structuringSource)
      : null,
  };
}

export function buildDiagnosticsDocumentView(
  detail: DesktopLibraryDetail,
): DiagnosticsDocumentView {
  const provenance = buildDocumentProvenance(detail);
  const evidence = detail.ocrEvidence
    ? {
        status: detail.ocrEvidence.status,
        pageCount: detail.ocrEvidence.pageCount,
        digest: detail.ocrEvidence.digest,
      }
    : null;
  return {
    documentId: detail.documentId,
    fileName: detail.fileName,
    extraction: provenance.extraction,
    structuring: provenance.structuring,
    evidence,
    canExportJson: Boolean(detail.result || detail.raw),
  };
}

function toEngineProvenance(source: CaptureEngine): EngineProvenanceView {
  return {
    engine: source.engine,
    model: source.model,
    device: nonEmpty(source.device),
    digest: source.digest,
  };
}

function nonEmpty(value?: string | null): string | null {
  return value && value.trim() !== '' ? value : null;
}
