import type { Observable } from 'rxjs';
import { CAPTURE_DOCUMENT_SCHEMA_VERSION } from '@gx-capture/capture-contracts';
import type {
  CaptureBlockV1,
  CaptureEventV2,
  CaptureDocumentV1,
  CaptureFailureV1,
  CaptureOperationV2,
  CaptureJobStage,
  CaptureReviewV1,
  CaptureSourceKind,
  PageLocatorV1,
  PartialCaptureV2,
  RawCaptureV1,
  RuntimeInstallationV1,
  RuntimeReadyV1 as GeneratedRuntimeReadyV1,
  RuntimeRequirementV1,
  StructuringMode,
  TimeLocatorV1,
} from '@gx-capture/capture-contracts';

export {
  CAPTURE_API_VERSION,
  CAPTURE_CONTRACT_EXTRA_POLICIES,
  CAPTURE_CONTRACT_INVARIANTS,
  CAPTURE_DOCUMENT_SCHEMA_ID,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_RUNTIME_VERSION,
  CONTRACT_MANIFEST_VERSION,
  RUNTIME_VERSION,
} from '@gx-capture/capture-contracts';
export type {
  CaptureBlockV1,
  CaptureEventV2,
  CaptureContractExtraPolicy,
  CaptureContractInvariant,
  CaptureContractName,
  CaptureDocumentV1,
  CaptureEngineV1,
  CaptureFailureV1,
  CaptureFailureV2,
  CaptureJobV1,
  CaptureJobStage,
  CaptureJobStatus,
  CaptureOperationV2,
  FinalizeIngestionV2,
  IngestionV2,
  OpenIngestionV2,
  CaptureReviewEditV1,
  CaptureReviewV1,
  CaptureLocatorV1,
  CaptureSourceKind,
  ErrorBodyV1,
  ErrorEnvelopeV1,
  PageLocatorV1,
  PartialCaptureV2,
  RawCaptureSegmentV1,
  RawCaptureV1,
  ReportStructuringFailureV1,
  ReportStructuringFailureV2,
  RuntimeArtifactDescriptorV1,
  RuntimeCapabilitiesV1,
  RuntimeInstallationStatus,
  RuntimeInstallationV1,
  RuntimeInstallationsV1,
  RuntimeModelInstallationV1,
  RuntimeModelOptionV1,
  RuntimeModelOptionStatus,
  RuntimeModelOptionsV1,
  RuntimeRequirementStatus,
  RuntimeRequirementV1,
  RuntimeRequirementsV1,
  StartRuntimeInstallationV1,
  StructuringMode,
  TimeLocatorV1,
} from '@gx-capture/capture-contracts';

/** Angular's API naming remains stable while the wire owner is generated. */
export type CaptureStructuringMode = StructuringMode;
export type CaptureRequirementId = RuntimeRequirementV1['requirementId'];
export type CapturePageLocatorV1 = PageLocatorV1;
export type CaptureTimeLocatorV1 = TimeLocatorV1;
export type CaptureBlockType = CaptureBlockV1['type'];
export type CaptureStructuringCandidateV1 = CaptureDocumentV1;

/**
 * A client receives arbitrary handshake versions so it can report incompatibility;
 * the generated release model intentionally narrows these fields to this release.
 */
export type RuntimeReadyV1 = Omit<
  GeneratedRuntimeReadyV1,
  'apiVersion' | 'runtimeVersion' | 'captureDocumentSchemaVersion'
> & {
  readonly apiVersion: string;
  readonly runtimeVersion: string;
  readonly captureDocumentSchemaVersion: string;
};

export type CaptureOutputMode = 'json' | 'text';
export type CaptureDensity = 'compact' | 'comfortable';

export type CaptureTaskStatus =
  | 'queued'
  | 'processing'
  | 'awaiting_confirmation'
  | 'reconciliation_required'
  | 'completed'
  | 'failed'
  | 'canceled';

export type CaptureTaskStage = CaptureJobStage | 'uploading' | 'preprocessing';

export interface StartRuntimeInstallationRequest {
  readonly clientRequestId: string;
  readonly requirementId: CaptureRequirementId;
  /** Must only be set after an explicit user action. */
  readonly consent: true;
}

export interface CreateCaptureRequest {
  readonly clientRequestId: string;
  readonly file: File;
  readonly sourceKind: CaptureSourceKind;
  readonly structuringMode: CaptureStructuringMode;
  readonly targetLanguage?: string;
  readonly signal?: AbortSignal;
}

/** The v2 upload-and-start operation used by the streaming runtime. */
export interface StartStreamingCaptureRequest {
  readonly clientRequestId: string;
  readonly file: File;
  readonly sourceKind: CaptureSourceKind;
  readonly structuringMode: CaptureStructuringMode;
  readonly targetLanguage?: string;
  readonly signal?: AbortSignal;
}

export interface CaptureStreamingResult {
  readonly operation: CaptureOperationV2;
  readonly raw: RawCaptureV1;
  readonly result: CaptureDocumentV1;
}

export interface CommitStreamingStructuredResultRequest {
  readonly clientRequestId: string;
  readonly candidate: CaptureStructuringCandidateV1;
}

export interface ReportStreamingStructuringFailureRequest {
  readonly clientRequestId?: string;
  readonly code: string;
  readonly message: string;
}

export interface CaptureEventStreamOptions {
  readonly signal?: AbortSignal;
  /**
   * Last received SSE event id/sequence. Replayed events resume after this id
   * and the runtime suppresses already-delivered events.
   */
  readonly lastEventId?: string | number;
}

export interface CommitStructuredResultRequest {
  readonly clientRequestId: string;
  readonly candidate: CaptureStructuringCandidateV1;
}

export interface ReportStructuringFailureRequest {
  readonly code: string;
  readonly message: string;
}

export interface ConfirmCaptureRequest {
  readonly clientRequestId: string;
  readonly review: CaptureReviewV1;
}

export interface CaptureClient {
  getReady(signal?: AbortSignal): Observable<RuntimeReadyV1>;
  getRequirements(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeRequirementV1[]>;
  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1>;
  listInstallations(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeInstallationV1[]>;
  getInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1>;
  cancelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallationV1>;
  /**
   * Opens the authenticated v2 capture event stream as a cold Observable.
   * Each subscription performs a fresh fetch and unsubscribing aborts it.
   * Native EventSource must not be used because the runtime requires an
   * Authorization header.
   */
  captureEvents(
    id: string,
    options?: CaptureEventStreamOptions,
  ): Observable<CaptureEventV2>;
  startStreamingCapture(
    request: StartStreamingCaptureRequest,
  ): Observable<CaptureOperationV2>;
  getStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2>;
  cancelStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2>;
  getStreamingPartial(
    id: string,
    signal?: AbortSignal,
  ): Observable<PartialCaptureV2>;
  getStreamingResult(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureStreamingResult>;
  commitStreamingStructuredResult(
    id: string,
    request: CommitStreamingStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2>;
  reportStreamingStructuringFailure(
    id: string,
    request: ReportStreamingStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperationV2>;
  deleteStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<void>;
}

export interface CaptureStructuringRequest {
  readonly raw: RawCaptureV1;
  readonly review?: CaptureReviewV1;
  readonly documentContract: CaptureDocumentContractV1;
  readonly targetLanguage?: string;
  readonly signal: AbortSignal;
  readonly reportProgress: (percentage: number) => void;
}

export interface CaptureDocumentContractV1 {
  readonly schemaVersion: typeof CAPTURE_DOCUMENT_SCHEMA_VERSION;
  /** SHA-256 of the canonical CRLF-terminated release schema bytes. */
  readonly schemaSha256: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}

/**
 * Host applications can implement this interface with their existing Ollama or
 * other LLM provider. Capture Workbench itself still ships and validates the
 * isolated runtime provider path.
 */
export interface CaptureStructuringProvider {
  structure(
    request: CaptureStructuringRequest,
  ): Observable<CaptureStructuringCandidateV1>;
}

export interface CapturePreprocessRequest {
  readonly file: File;
  readonly sourceKind: CaptureSourceKind;
  readonly signal: AbortSignal;
}

export interface CapturePreprocessor {
  preprocess(request: CapturePreprocessRequest): Observable<File>;
}

export interface CaptureWorkbenchLabels {
  readonly title?: string;
  readonly eyebrow?: string;
  readonly chooseFiles?: string;
  readonly emptyState?: string;
  readonly runtimeTitle?: string;
  readonly runtimeReady?: string;
  readonly installRuntime?: string;
  readonly retryRuntime?: string;
  readonly cancel?: string;
  readonly reconcile?: string;
  readonly cancelAndReconcile?: string;
  readonly remove?: string;
  readonly exportJson?: string;
  readonly exportText?: string;
  readonly exportRaw?: string;
  readonly reviewTitle?: string;
  readonly reviewDescription?: string;
  readonly originalText?: string;
  readonly reviewedText?: string;
  readonly restoreOriginal?: string;
  readonly confirmReview?: string;
  readonly discardReview?: string;
}

export interface CaptureWorkbenchTheme {
  readonly accent?: string;
  readonly background?: string;
  readonly foreground?: string;
  readonly muted?: string;
  readonly border?: string;
  readonly danger?: string;
}

export interface CaptureWorkbenchConfig {
  readonly enabledSources?: readonly CaptureSourceKind[];
  readonly structuringMode?: CaptureStructuringMode;
  readonly outputMode?: CaptureOutputMode;
  readonly multiple?: boolean;
  readonly targetLanguage?: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly showRuntimeSetup?: boolean;
  /**
   * `component` invokes the injected CaptureStructuringProvider after raw extraction.
   * `client` means the host backend owns provider invocation and the component only polls.
   */
  readonly hostStructuringOwner?: 'component' | 'client';
  /**
   * Explicitly delegates capability/version handshake enforcement to the host.
   * Hiding setup UI alone never disables the package handshake.
   */
  readonly hostManagedHandshake?: boolean;
  /** Pause host-owned structuring until the user explicitly confirms OCR. */
  readonly reviewBeforeCommit?: boolean;
  /** Allow editing review text; review remains read-only when false. */
  readonly reviewEditable?: boolean;
  readonly width?: string;
  readonly height?: string;
  readonly density?: CaptureDensity;
  readonly theme?: CaptureWorkbenchTheme;
  readonly labels?: CaptureWorkbenchLabels;
  readonly compatibleRuntimeMajor?: number;
  /**
   * Expected runtime minor while the client is on 0.x. Override only during
   * a coordinated rollback or temporary split-minor compatibility window.
   */
  readonly compatibleRuntimeMinor?: number;
}

export interface CaptureTaskView {
  readonly id: string;
  readonly captureId?: string;
  readonly fileName: string;
  readonly sourceKind: CaptureSourceKind;
  readonly status: CaptureTaskStatus;
  readonly stage?: CaptureTaskStage;
  readonly progress: number;
  readonly result?: CaptureDocumentV1;
  readonly raw?: RawCaptureV1;
  readonly review?: CaptureReviewV1;
  readonly error?: CaptureFailureV1;
}

export interface CaptureCompletedEvent {
  readonly taskId: string;
  readonly document: CaptureDocumentV1;
  readonly review?: CaptureReviewV1;
}

export interface CaptureFailedEvent {
  readonly taskId: string;
  readonly captureId?: string;
  readonly fileName: string;
  readonly error: CaptureFailureV1;
  readonly raw?: RawCaptureV1;
}

export * from './injection';
export * from './workbench';
