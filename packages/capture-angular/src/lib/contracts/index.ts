import type { Observable } from 'rxjs';
import { CAPTURE_DOCUMENT_SCHEMA_VERSION } from './versions';

export type CaptureSourceKind = 'pdf' | 'image' | 'audio';
export type CaptureStructuringMode = 'runtime' | 'host';
export type CaptureOutputMode = 'json' | 'text';
export type CaptureDensity = 'compact' | 'comfortable';

export type CaptureRequirementId =
  | 'windowsml-ocr'
  | 'whisper-primary'
  | 'ollama-runtime'
  | 'capture-ollama-model';

export type CaptureJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CaptureJobStage =
  | 'queued'
  | 'extracting'
  | 'awaiting_structuring'
  | 'structuring'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CaptureTaskStatus =
  | 'queued'
  | 'processing'
  | 'awaiting_confirmation'
  | 'reconciliation_required'
  | 'completed'
  | 'failed'
  | 'canceled';

export type CaptureTaskStage = CaptureJobStage | 'uploading' | 'preprocessing';

export interface CapturePageLocatorV1 {
  readonly kind: 'page';
  readonly page: number;
  readonly boundingBox?: readonly [number, number, number, number] | null;
}

export interface CaptureTimeLocatorV1 {
  readonly kind: 'time';
  readonly startMs: number;
  readonly endMs: number;
}

export type CaptureLocatorV1 = CapturePageLocatorV1 | CaptureTimeLocatorV1;

export interface CaptureSourceV1 {
  readonly sha256: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: number;
}

export interface CaptureEngineV1 {
  readonly engine: string;
  readonly model: string;
  readonly digest: string;
  readonly device?: string | null;
}

export interface RawCaptureSegmentV1 {
  readonly segmentId: string;
  readonly order: number;
  readonly locator: CaptureLocatorV1;
  readonly text: string;
}

/**
 * Raw OCR/STT is diagnostic evidence, not a successful capture result.
 * Consumers must not persist it as a CaptureDocumentV1.
 */
export interface RawCaptureV1 {
  readonly schemaVersion: typeof CAPTURE_DOCUMENT_SCHEMA_VERSION;
  readonly diagnosticOnly: true;
  readonly source: CaptureSourceV1;
  readonly segments: readonly RawCaptureSegmentV1[];
  readonly sourceText: string;
  readonly extractionEngine: CaptureEngineV1;
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

export type CaptureBlockType =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'table'
  | 'quote'
  | 'transcript';

export interface CaptureBlockV1 {
  readonly blockId: string;
  readonly order: number;
  readonly sourceSegmentId: string;
  readonly type: CaptureBlockType;
  readonly locator: CaptureLocatorV1;
  readonly sourceText: string;
  readonly targetText: string;
}

export interface CaptureDocumentV1 {
  readonly schemaVersion: typeof CAPTURE_DOCUMENT_SCHEMA_VERSION;
  readonly source: CaptureSourceV1;
  readonly rawSegments: readonly RawCaptureSegmentV1[];
  readonly blocks: readonly CaptureBlockV1[];
  readonly sourceText: string;
  readonly targetText: string;
  readonly extractionEngine: CaptureEngineV1;
  readonly structuringEngine: CaptureEngineV1;
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly completedAt: string;
}

/** Host providers return a full candidate for runtime-side schema/provenance validation. */
export type CaptureStructuringCandidateV1 = CaptureDocumentV1;

export interface CaptureFailureV1 {
  readonly code: string;
  readonly message: string;
  readonly stage?: CaptureTaskStage | 'runtime' | 'input' | null;
  readonly retryable?: boolean;
}

export interface RuntimeReadyV1 {
  readonly ready: boolean;
  readonly service: 'capture-runtime';
  readonly apiVersion: string;
  readonly runtimeVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly capabilities: {
    readonly captureKinds: readonly CaptureSourceKind[];
    readonly structuringModes: readonly CaptureStructuringMode[];
    readonly supportsCancellation: boolean;
    readonly supportsRawDiagnostics: boolean;
    readonly maxUploadBytes: number;
  };
  readonly message?: string | null;
}

export type RuntimeRequirementStatus =
  | 'ready'
  | 'missing'
  | 'installable'
  | 'manual_action_required'
  | 'unavailable';

export interface RuntimeArtifactDescriptorV1 {
  readonly artifactUrl: string;
  readonly artifactFileName: string;
  /** Exact compressed artifact length, from 1 through 536870912 bytes. */
  readonly bytes: number;
  readonly sha256: string;
}

export interface RuntimeRequirementV1 {
  readonly requirementId: CaptureRequirementId;
  readonly kind: string;
  readonly displayName: string;
  readonly status: RuntimeRequirementStatus;
  readonly requiredFor: readonly string[];
  readonly installStrategy: string;
  readonly detail?: string | null;
  readonly artifact?: RuntimeArtifactDescriptorV1 | null;
}

export type RuntimeInstallationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'manual_action_required';

export interface RuntimeInstallationV1 {
  readonly installationId: string;
  readonly requirementId: CaptureRequirementId;
  readonly status: RuntimeInstallationStatus;
  /** Runtime wire value from 0 through 1. */
  readonly progress: number;
  readonly error?: CaptureFailureV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
}

export interface CaptureJobV1 {
  readonly captureId: string;
  readonly status: CaptureJobStatus;
  readonly stage: CaptureJobStage;
  readonly structuringMode: CaptureStructuringMode;
  /** Runtime wire value from 0 through 1. */
  readonly progress: number;
  readonly source?: CaptureSourceV1 | null;
  readonly error?: CaptureFailureV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
}

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

export interface CommitStructuredResultRequest {
  readonly clientRequestId: string;
  readonly candidate: CaptureStructuringCandidateV1;
}

export interface ReportStructuringFailureRequest {
  readonly code: string;
  readonly message: string;
}

export interface CaptureReviewEditV1 {
  readonly segmentId: string;
  readonly reviewedText: string;
}

export interface CaptureReviewV1 {
  readonly reviewVersion: 1;
  readonly edits: readonly CaptureReviewEditV1[];
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
  createCapture(request: CreateCaptureRequest): Observable<CaptureJobV1>;
  getCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1>;
  cancelCapture(id: string, signal?: AbortSignal): Observable<CaptureJobV1>;
  getRaw(id: string, signal?: AbortSignal): Observable<RawCaptureV1>;
  getResult(id: string, signal?: AbortSignal): Observable<CaptureDocumentV1>;
  /** Host clients use this after an explicit review confirmation. */
  confirmCapture?(
    id: string,
    request: ConfirmCaptureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1>;
  commitStructuredResult(
    id: string,
    request: CommitStructuredResultRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1>;
  reportStructuringFailure(
    id: string,
    request: ReportStructuringFailureRequest,
    signal?: AbortSignal,
  ): Observable<CaptureJobV1>;
  deleteCapture(id: string, signal?: AbortSignal): Observable<void>;
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

export * from './versions';
export * from './injection';
export * from './workbench';
