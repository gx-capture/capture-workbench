import type { Observable } from 'rxjs';
import { CAPTURE_DOCUMENT_SCHEMA_VERSION } from '@gx-capture/capture-runtime-client';
import type {
  CaptureBlock,
  CaptureEvent,
  CaptureDocument,
  CaptureFailure,
  CaptureOperation,
  StreamingCaptureStatus,
  CaptureReview,
  CaptureSourceKind,
  PageLocator,
  PartialCapture,
  RawCapture,
  RuntimeInstallation,
  RuntimeReady as GeneratedRuntimeReady,
  RuntimeRequirement,
  StructuringMode,
  TimeLocator,
} from '@gx-capture/capture-runtime-client';

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
} from '@gx-capture/capture-runtime-client';
export type {
  CaptureBlock,
  CaptureEvent,
  CaptureContractExtraPolicy,
  CaptureContractInvariant,
  CaptureContractName,
  CaptureDocument,
  CaptureEngine,
  CaptureFailure,
  CaptureOperation,
  FinalizeIngestion,
  Ingestion,
  OpenIngestion,
  CaptureReviewEdit,
  CaptureReview,
  CaptureLocator,
  CaptureSourceKind,
  ErrorBody,
  ErrorEnvelope,
  PageLocator,
  PartialCapture,
  RawCaptureSegment,
  RawCapture,
  ReportStructuringFailure,
  RuntimeArtifactDescriptor,
  RuntimeInstallationStatus,
  RuntimeInstallation,
  RuntimeInstallations,
  RuntimeModelInstallation,
  RuntimeModelOption,
  RuntimeModelOptionStatus,
  RuntimeModelOptions,
  RuntimeRequirementStatus,
  RuntimeRequirement,
  RuntimeRequirements,
  StructuringMode,
  TimeLocator,
} from '@gx-capture/capture-runtime-client';

/** Angular's API naming remains stable while the wire owner is generated. */
export type CaptureStructuringMode = StructuringMode;
export type CaptureRequirementId = RuntimeRequirement['requirementId'];
export type CapturePageLocator = PageLocator;
export type CaptureTimeLocator = TimeLocator;
export type CaptureBlockType = CaptureBlock['type'];
export type CaptureStructuringCandidate = CaptureDocument;

/**
 * A client receives arbitrary handshake versions so it can report incompatibility;
 * the generated release model intentionally narrows these fields to this release.
 */
export type RuntimeReady = Omit<
  GeneratedRuntimeReady,
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

export type CaptureTaskStage =
  | StreamingCaptureStatus
  | 'queued'
  | 'uploading'
  | 'preprocessing';

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
  readonly operation: CaptureOperation;
  readonly raw: RawCapture;
  readonly result: CaptureDocument;
}

export interface CommitStreamingStructuredResultRequest {
  readonly clientRequestId: string;
  readonly candidate: CaptureStructuringCandidate;
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
  readonly candidate: CaptureStructuringCandidate;
}

export interface ReportStructuringFailureRequest {
  readonly code: string;
  readonly message: string;
}

export interface ConfirmCaptureRequest {
  readonly clientRequestId: string;
  readonly review: CaptureReview;
}

export interface CaptureClient {
  getReady(signal?: AbortSignal): Observable<RuntimeReady>;
  getRequirements(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeRequirement[]>;
  startInstallation(
    request: StartRuntimeInstallationRequest,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation>;
  listInstallations(
    signal?: AbortSignal,
  ): Observable<readonly RuntimeInstallation[]>;
  getInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation>;
  cancelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Observable<RuntimeInstallation>;
  /**
   * Opens the authenticated v2 capture event stream as a cold Observable.
   * Each subscription performs a fresh fetch and unsubscribing aborts it.
   * Native EventSource must not be used because the runtime requires an
   * Authorization header.
   */
  captureEvents(
    id: string,
    options?: CaptureEventStreamOptions,
  ): Observable<CaptureEvent>;
  startStreamingCapture(
    request: StartStreamingCaptureRequest,
  ): Observable<CaptureOperation>;
  getStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperation>;
  cancelStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperation>;
  getStreamingPartial(
    id: string,
    signal?: AbortSignal,
  ): Observable<PartialCapture>;
  getStreamingRaw(id: string, signal?: AbortSignal): Observable<RawCapture>;
  getStreamingResult(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureStreamingResult>;
  commitStreamingStructuredResult(
    id: string,
    request: CommitStreamingStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperation>;
  reportStreamingStructuringFailure(
    id: string,
    request: ReportStreamingStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperation>;
  deleteStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<void>;
}

export interface CaptureStructuringRequest {
  readonly raw: RawCapture;
  readonly review?: CaptureReview;
  readonly documentContract: CaptureDocumentContract;
  readonly targetLanguage?: string;
  readonly signal: AbortSignal;
  readonly reportProgress: (percentage: number) => void;
}

export interface CaptureDocumentContract {
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
  ): Observable<CaptureStructuringCandidate>;
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
  readonly result?: CaptureDocument;
  readonly raw?: RawCapture;
  readonly review?: CaptureReview;
  readonly error?: CaptureFailure;
}

export interface CaptureCompletedEvent {
  readonly taskId: string;
  readonly document: CaptureDocument;
  readonly review?: CaptureReview;
}

export interface CaptureFailedEvent {
  readonly taskId: string;
  readonly captureId?: string;
  readonly fileName: string;
  readonly error: CaptureFailure;
  readonly raw?: RawCapture;
}

export * from './injection';
export * from './workbench';
