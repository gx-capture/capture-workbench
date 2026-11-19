/** Public v2 DTO names. Generated contracts remain a private build input. */
/* eslint-disable @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type */
import type * as Generated from './private/generated-contracts.js';

export interface CaptureBlock extends Generated.CaptureBlock {}
export interface CaptureDocument extends Generated.CaptureDocument {}
export interface CaptureEngine extends Generated.CaptureEngine {}
export interface CaptureEvent extends Generated.CaptureEvent {}
export interface OperationFailure extends Generated.OperationFailure {}
export interface OcrRaster extends Generated.OcrRaster {}
export interface OcrPoint extends Generated.OcrPoint {}
export interface OcrBox extends Generated.OcrBox {}
export type OcrProvenance = Generated.OcrProvenance;
export type OcrProvenanceResolved = Generated.OcrProvenanceResolved;
export type OcrProvenanceUnavailable = Generated.OcrProvenanceUnavailable;
export interface OcrPageProjection extends Generated.OcrPageProjection {}
export interface CaptureOcrProjection extends Generated.CaptureOcrProjection {}
export interface OcrComputePreflight extends Generated.OcrComputePreflight {}
export interface CaptureOperation extends Generated.CaptureOperation {}
export interface CaptureSource extends Generated.CaptureSource {}
export interface ErrorBody extends Generated.ErrorBody {}
export interface ErrorEnvelope extends Generated.ErrorEnvelope {}
export interface FinalizeIngestion extends Generated.FinalizeIngestion {}
export interface Ingestion extends Generated.Ingestion {}
export interface OpenIngestion extends Generated.OpenIngestion {}
export interface PartialCapture extends Generated.PartialCapture {}
export interface RawCaptureSegment extends Generated.RawCaptureSegment {}
export interface RawCapture extends Generated.RawCapture {}
export interface ReportStructuringFailure extends Generated.ReportStructuringFailure {}
export interface RuntimeArtifactDescriptor extends Generated.RuntimeArtifactDescriptor {}
export interface RuntimeInstallation extends Generated.RuntimeInstallation {}
export interface RuntimeInstallations extends Generated.RuntimeInstallations {}
export interface StructuringModelInstallation extends Generated.StructuringModelInstallation {}
export interface StructuringModelInstallations extends Generated.StructuringModelInstallations {}
export interface StructuringModelOption extends Generated.StructuringModelOption {}
export interface StructuringModelOptions extends Generated.StructuringModelOptions {}
export interface RuntimeRequirement extends Generated.RuntimeRequirement {}
export interface RuntimeRequirements extends Generated.RuntimeRequirements {}
export interface StartCapture extends Generated.StartCapture {}
export interface StructuringProviderCapability
  extends Generated.StructuringProviderCapability {}
export interface OpenStructuringSession extends Generated.OpenStructuringSession {}
export interface StructuringSession extends Generated.StructuringSession {}
export interface StructuringBatch extends Generated.StructuringBatch {}
export interface StructuringSemanticBlock
  extends Generated.StructuringSemanticBlock {}
/**
 * A host may leave `protocolVersion` out: the schema lists it as optional and
 * the client writes it on the wire. The generated type marks it required only
 * because the generator treats `const` fields as always present.
 */
export interface SubmitStructuringBatch
  extends Omit<Generated.SubmitStructuringBatch, 'protocolVersion'> {
  readonly protocolVersion?: '2';
}
export interface RuntimeReady {
  readonly ready: boolean;
  readonly service: string;
  readonly apiVersion: string;
  readonly runtimeVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly captureDocumentSchemaSha256?: string;
  readonly contractSetVersion?: string;
  readonly capabilities: RuntimeCapabilities;
  readonly ocrCompute?: OcrComputePreflight | null;
  readonly message?: string | null;
}
export interface RuntimeCapabilities extends Generated.RuntimeCapabilities {}
export type CaptureLocator = Generated.CaptureLocator;
export type PageLocator = Generated.PageLocator;
export type TimeLocator = Generated.TimeLocator;
export type CaptureRequirementId = Generated.CaptureRequirementId;
export type CaptureSourceKind = Generated.CaptureSourceKind;
export type StructuringMode = Generated.StructuringMode;
export type SpokenLanguage = NonNullable<Generated.StartCapture['spokenLanguage']>;
export type StructuringSessionStatus = Generated.StructuringSessionStatus;
export type StructuringBatchStatus = Generated.StructuringBatchStatus;
export type CaptureStatus = Generated.CaptureStatus;
export type CaptureEventType = Generated.CaptureEventType;
export type OcrProjectionStatus = Generated.OcrProjectionStatus;
export type OcrPageStatus = Generated.OcrPageStatus;
export type OcrAdapterClass = Generated.OcrAdapterClass;
export type OcrComputeMode = Generated.OcrComputeMode;
export type OcrComputeNoticeCode = Generated.OcrComputeNoticeCode;
export type OcrComputeReasonCode = Generated.OcrComputeReasonCode;
export type IngestionStatus = Generated.IngestionStatus;
export type RuntimeInstallationStatus = Generated.RuntimeInstallationStatus;
export type StructuringModelOptionStatus = Generated.StructuringModelOptionStatus;
export type RuntimeRequirementStatus = Generated.RuntimeRequirementStatus;
export type IngestionMode = Generated.IngestionMode;
export type CaptureContractName = Generated.CaptureContractName;
export type CaptureContractInvariant = Generated.CaptureContractInvariant;
export type CaptureContractExtraPolicy = Generated.CaptureContractExtraPolicy;
export {
  CAPTURE_API_VERSION,
  CAPTURE_DOCUMENT_SCHEMA_ID,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_RUNTIME_VERSION,
  CONTRACT_MANIFEST_VERSION,
  RUNTIME_VERSION,
  CAPTURE_CONTRACT_INVARIANTS,
  CAPTURE_CONTRACT_EXTRA_POLICIES,
} from './private/generated-contracts.js';

/** Approved current runtime contract-set identity; update only with a release. */
export const CAPTURE_CONTRACT_SET_SHA256 =
  'e05c062bb49afc655fc6bf95cee7eb549c7b9802624c083ba6875d15f376a036';

export interface RuntimeDiscovery {
  readonly ready: RuntimeReady;
  readonly captureDocumentSchemaSha256: string;
  readonly contractIndex: Readonly<Record<string, unknown>>;
  readonly contractBundle: Readonly<Record<string, unknown>>;
}

export interface CaptureUpload {
  readonly fileName: string;
  readonly body: BodyInit | Uint8Array | ArrayBuffer;
  readonly mediaType?: string;
  readonly sourceKind: CaptureSourceKind;
  readonly targetLanguage?: string;
  readonly structuringMode?: 'runtime' | 'host';
  /**
   * PDF only: the source pages to read, one-based, ascending and without
   * duplicates, at most 500 (for example `[3, 7, 8, 20]`). OCR pages and page
   * locators keep these numbers. Omit it to read every page.
   */
  readonly pdfPageNumbers?: readonly number[];
  /**
   * Audio only: label who speaks each segment. Needs the optional
   * `speaker-diarization` unit; the capture then reports no partial transcript.
   */
  readonly identifySpeakers?: boolean;
  /**
   * Audio only: the language spoken in the recording. Omit it for Chinese, the
   * speech model's default.
   */
  readonly spokenLanguage?: SpokenLanguage;
  readonly clientRequestId: string;
  readonly signal?: AbortSignal;
}

export interface CaptureResult extends Generated.CaptureResult {}

export interface CaptureRuntimeClientOptions {
  readonly baseUrl: string | number;
  readonly transport?: RuntimeTransport;
  readonly bearerToken?: string | (() => string | Promise<string>);
  readonly fetch?: typeof globalThis.fetch;
  readonly expectedRuntimeVersion?: string;
  readonly expectedApiVersion?: string;
  readonly expectedSchemaVersion?: string;
  readonly expectedCaptureDocumentSchemaSha256?: string;
  /** Current approved contract-set identity; unknown runtime bundles fail closed. */
  readonly expectedContractSetSha256?: string;
  /** Explicit release-train allowlist for rolling contract-set identities. */
  readonly allowedContractSetSha256?: readonly string[];
  /** Number of transient responses to retry when the request is idempotent. */
  readonly maxRetries?: number;
  /** Base delay between retries. Tests and hosts may set this to zero. */
  readonly retryBackoffMs?: number;
}

export interface RuntimeTransportRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit;
  readonly signal?: AbortSignal;
}

export interface RuntimeTransport {
  request(request: RuntimeTransportRequest): Promise<Response>;
}

export interface RuntimeInMemoryRoute {
  readonly method?: RuntimeTransportRequest['method'];
  readonly path: string | RegExp;
  readonly handle: (request: RuntimeTransportRequest) => Response | Promise<Response>;
}

export type StructuringModelSummary = readonly StructuringModelOption[];
export type RuntimeRequirementSummary = readonly RuntimeRequirement[];
export type RuntimeInstallationSummary = RuntimeInstallation | StructuringModelInstallation;
export type RuntimeIngestion = Ingestion;
export type RuntimePartial = PartialCapture;
export type RuntimeEvent = CaptureEvent;
