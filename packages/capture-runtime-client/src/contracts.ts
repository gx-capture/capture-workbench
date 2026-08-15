/** Public v2 DTO names. Generated contracts remain a private build input. */
/* eslint-disable @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type */
import type * as Generated from './private/generated-contracts.js';

export interface CaptureBlock extends Generated.CaptureBlock {}
export interface CaptureDocument extends Generated.CaptureDocument {}
export interface CaptureEngine extends Generated.CaptureEngine {}
export interface CaptureEvent extends Generated.CaptureEventV2 {}
export interface CaptureFailure extends Generated.CaptureFailureV2 {}
export interface CaptureOperation extends Generated.CaptureOperationV2 {}
export interface CaptureReviewEdit {
  readonly segmentId: string;
  readonly reviewedText: string;
}
export interface CaptureReview {
  readonly reviewVersion: number;
  readonly edits: readonly CaptureReviewEdit[];
}
export interface CaptureSource extends Generated.CaptureSource {}
export interface ErrorBody extends Generated.ErrorBodyV2 {}
export interface ErrorEnvelope extends Generated.ErrorEnvelopeV2 {}
export interface FinalizeIngestion extends Generated.FinalizeIngestionV2 {}
export interface Ingestion extends Generated.IngestionV2 {}
export interface OpenIngestion extends Generated.OpenIngestionV2 {}
export interface PartialCapture extends Generated.PartialCaptureV2 {}
export interface RawCaptureSegment extends Generated.RawCaptureSegment {}
export interface RawCapture extends Generated.RawCapture {}
export interface ReportStructuringFailure extends Generated.ReportStructuringFailureV2 {}
export interface RuntimeArtifactDescriptor extends Generated.RuntimeArtifactDescriptorV2 {}
export interface RuntimeInstallation extends Generated.RuntimeInstallationV2 {}
export interface RuntimeInstallations extends Generated.RuntimeInstallationsV2 {}
export interface RuntimeModelInstallation extends Generated.RuntimeModelInstallationV2 {}
export interface RuntimeModelInstallations extends Generated.RuntimeModelInstallationsV2 {}
export interface RuntimeModelOption extends Generated.RuntimeModelOptionV2 {}
export interface RuntimeModelOptions extends Generated.RuntimeModelOptionsV2 {}
export interface RuntimeRequirement extends Generated.RuntimeRequirementV2 {}
export interface RuntimeRequirements extends Generated.RuntimeRequirementsV2 {}
export interface StartCapture extends Generated.StartCaptureV2 {}
export interface RuntimeReady {
  readonly ready: boolean;
  readonly service: string;
  readonly apiVersion: string;
  readonly runtimeVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly captureDocumentSchemaSha256?: string;
  readonly schemaSha256?: string;
  readonly contractSetVersion?: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly message?: string | null;
}
export interface RuntimeStreamingCapabilities extends Generated.RuntimeStreamingCapabilitiesV2 {}
export type CaptureLocator = Generated.CaptureLocator;
export type PageLocator = Generated.PageLocator;
export type TimeLocator = Generated.TimeLocator;
export type CaptureRequirementId = Generated.CaptureRequirementId;
export type CaptureSourceKind = Generated.CaptureSourceKind;
export type StructuringMode = Generated.StructuringMode;
export type StreamingCaptureStatus = Generated.StreamingCaptureStatus;
export type StreamingEventType = Generated.StreamingEventType;
export type StreamingIngestionStatus = Generated.StreamingIngestionStatus;
export type RuntimeInstallationStatus = Generated.RuntimeInstallationStatus;
export type RuntimeModelOptionStatus = Generated.RuntimeModelOptionStatus;
export type RuntimeRequirementStatus = Generated.RuntimeRequirementStatus;
export type StreamingIngestionMode = Generated.StreamingIngestionMode;
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
  '5b93bcb557acca034386b6e9e47502efec91210331ecebabd9c470196d35fec3';

export interface RuntimeDiscovery {
  readonly ready: RuntimeReady;
  readonly streaming?: RuntimeStreamingCapabilities;
  readonly schemaSha256: string;
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
  readonly clientRequestId: string;
  readonly signal?: AbortSignal;
}

export interface CaptureStreamingResult extends Generated.CaptureStreamingResult {}

export interface CaptureRuntimeClientOptions {
  readonly baseUrl: string | number;
  readonly transport?: RuntimeTransport;
  readonly bearerToken?: string | (() => string | Promise<string>);
  readonly fetch?: typeof globalThis.fetch;
  readonly expectedRuntimeVersion?: string;
  readonly expectedApiVersion?: string;
  readonly expectedSchemaVersion?: string;
  readonly expectedSchemaSha256?: string;
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

export type RuntimeModelSummary = readonly RuntimeModelOption[];
export type RuntimeRequirementSummary = readonly RuntimeRequirement[];
export type RuntimeInstallationSummary = RuntimeInstallation | RuntimeModelInstallation;
export type RuntimeIngestion = Ingestion;
export type RuntimePartial = PartialCapture;
export type RuntimeEvent = CaptureEvent;
