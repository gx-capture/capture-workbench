import type { Observable } from 'rxjs';
import { CAPTURE_DOCUMENT_SCHEMA_VERSION } from '@gx-capture/capture-runtime-client';
import type {
  CaptureBlock,
  CaptureEvent,
  CaptureDocument,
  CaptureOperation,
  CaptureResult,
  CaptureStatus,
  CaptureSourceKind,
  InstallableRequirementId,
  OperationFailure,
  PageLocator,
  PartialCapture,
  RawCapture,
  RuntimeInstallation,
  RuntimeReady as GeneratedRuntimeReady,
  RuntimeRequirement,
  SpokenLanguage,
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
  CaptureEventType,
  CaptureContractExtraPolicy,
  CaptureContractInvariant,
  CaptureContractName,
  CaptureDocument,
  CaptureEngine,
  CaptureOperation,
  CaptureResult,
  CaptureStatus,
  FinalizeIngestion,
  Ingestion,
  IngestionMode,
  IngestionStatus,
  OpenIngestion,
  OperationFailure,
  CaptureLocator,
  CaptureRequirementId,
  CaptureSourceKind,
  InstallableRequirementId,
  OcrAdapterClass,
  OcrComputeMode,
  OcrComputeNoticeCode,
  OcrComputePreflight,
  OcrComputeReasonCode,
  ErrorBody,
  ErrorEnvelope,
  PageLocator,
  PartialCapture,
  RawCaptureSegment,
  RawCapture,
  ReportStructuringFailure,
  RuntimeArtifactDescriptor,
  RuntimeCapabilities,
  RuntimeInstallationStatus,
  RuntimeInstallation,
  RuntimeInstallations,
  StructuringModelInstallation,
  StructuringModelOption,
  StructuringModelOptionStatus,
  StructuringModelOptions,
  RuntimeRequirementStatus,
  RuntimeRequirement,
  RuntimeRequirements,
  StructuringMode,
  TimeLocator,
} from '@gx-capture/capture-runtime-client';

export interface CaptureReviewEdit {
  readonly segmentId: string;
  readonly reviewedText: string;
}

export interface CaptureReview {
  readonly reviewVersion: number;
  readonly edits: readonly CaptureReviewEdit[];
}

/** Angular's API naming remains stable while the wire owner is generated. */
export type CaptureStructuringMode = StructuringMode;
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
  | CaptureStatus
  | 'queued'
  | 'uploading'
  | 'preprocessing'
  | 'loading-model'
  | 'transcribing'
  | 'identifying-speakers';

export interface StartRuntimeInstallationRequest {
  readonly clientRequestId: string;
  /** The structuring model is not installed here; a host installs a chosen model option. */
  readonly requirementId: InstallableRequirementId;
  /** Must only be set after an explicit user action. */
  readonly consent: true;
}

/** Upload one file and start its capture. */
export interface StartCaptureRequest {
  readonly clientRequestId: string;
  readonly file: File;
  readonly sourceKind: CaptureSourceKind;
  readonly structuringMode: CaptureStructuringMode;
  readonly targetLanguage?: string;
  /**
   * PDF only: the source pages to read, one-based, ascending and without
   * duplicates (for example `[3, 7]`). Omit it to read every page.
   */
  readonly pdfPageNumbers?: readonly number[];
  /** Audio only: label who speaks each segment. */
  readonly identifySpeakers?: boolean;
  /** Audio only: the language spoken in the recording. */
  readonly spokenLanguage?: SpokenLanguage;
  readonly signal?: AbortSignal;
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
  /** The idempotency key of the report; the HTTP client generates one when it is absent. */
  readonly clientRequestId?: string;
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
  startCapture(
    request: StartCaptureRequest,
  ): Observable<CaptureOperation>;
  getCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperation>;
  cancelCapture(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureOperation>;
  getPartial(
    id: string,
    signal?: AbortSignal,
  ): Observable<PartialCapture>;
  getRaw(id: string, signal?: AbortSignal): Observable<RawCapture>;
  getResult(
    id: string,
    signal?: AbortSignal,
  ): Observable<CaptureResult>;
  commitStructure(
    id: string,
    request: CommitStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperation>;
  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureOperation>;
  deleteCapture(
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
  /** Language of the built-in text. Defaults to Traditional Chinese. */
  readonly locale?: 'zh-TW' | 'en';
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
  /**
   * Label who speaks in audio captures and let the user name the speakers.
   * Needs the optional `speaker-diarization` unit installed in the runtime.
   */
  readonly identifySpeakers?: boolean;
  /**
   * The language spoken in audio captures, such as `ja`. Omit it for Chinese,
   * the speech model's default.
   */
  readonly spokenLanguage?: SpokenLanguage;
  /**
   * PDF captures only: the source pages to read, one-based, ascending and
   * without duplicates (for example `[3, 7]`). Omit it to read every page.
   */
  readonly pdfPageNumbers?: readonly number[];
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
  readonly error?: OperationFailure;
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
  readonly error: OperationFailure;
  readonly raw?: RawCapture;
}

export * from './injection';
export * from './workbench';
