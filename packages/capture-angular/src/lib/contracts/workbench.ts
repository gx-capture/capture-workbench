import type {
  CaptureClient,
  CaptureCompletedEvent,
  CaptureFailedEvent,
  CaptureFailureV1,
  CaptureJobV1,
  CapturePreprocessor,
  CaptureStructuringCandidateV1,
  CaptureStructuringProvider,
  CaptureTaskView,
  CaptureWorkbenchConfig,
  RawCaptureV1,
  RuntimeReadyV1,
  RuntimeRequirementV1,
} from './index';

export interface ResolvedCaptureWorkbenchConfig {
  readonly enabledSources: readonly ('pdf' | 'image' | 'audio')[];
  readonly structuringMode: 'runtime' | 'host';
  readonly outputMode: 'json' | 'text';
  readonly multiple: boolean;
  readonly targetLanguage?: string;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly showRuntimeSetup: boolean;
  readonly hostStructuringOwner: 'component' | 'client';
  readonly hostManagedHandshake: boolean;
  readonly width: string;
  readonly height: string;
  readonly density: 'compact' | 'comfortable';
  readonly compatibleRuntimeMajor: number;
}

export interface RuntimeViewState {
  readonly status: 'idle' | 'checking' | 'ready' | 'needs-setup' | 'incompatible' | 'error';
  readonly ready?: RuntimeReadyV1;
  readonly requirements: readonly RuntimeRequirementV1[];
  readonly error?: string;
}

export interface RuntimeHandshake {
  readonly ready: RuntimeReadyV1;
  readonly requirements: readonly RuntimeRequirementV1[];
}

export interface RuntimeRequest {
  readonly client: CaptureClient | null;
  readonly compatibleRuntimeMajor: number;
  readonly structuringMode: 'runtime' | 'host';
}

export interface InternalCaptureTask {
  readonly file: File;
  readonly clientRequestId: string;
  readonly controller: AbortController;
}

export interface CaptureWorkbenchStoreOptions {
  readonly config?: CaptureWorkbenchConfig;
  readonly client?: CaptureClient | null;
  readonly structuringProvider?: CaptureStructuringProvider | null;
  readonly preprocessor?: CapturePreprocessor | null;
}

export interface CaptureWorkflowContext {
  readonly config: () => ResolvedCaptureWorkbenchConfig;
  readonly client: () => CaptureClient | null;
  readonly structuringProvider: () => CaptureStructuringProvider | null;
  readonly preprocessor: () => CapturePreprocessor | null;
}

export interface CaptureReconciliationContext {
  readonly client: () => CaptureClient | null;
  readonly getTask: (taskId: string) => CaptureTaskView | undefined;
  readonly updateTask: (
    taskId: string,
    patch: Partial<CaptureTaskView>,
  ) => CaptureTaskView | undefined;
  readonly requireReconciliation: (
    taskId: string,
    error: CaptureFailureV1,
    raw?: RawCaptureV1,
  ) => void;
  readonly failTask: (
    taskId: string,
    fileName: string,
    error: CaptureFailureV1,
    raw?: RawCaptureV1,
    stage?: CaptureTaskView['stage'],
  ) => void;
  readonly emitCompleted: (event: CaptureCompletedEvent) => void;
  readonly emitCanceled: (task: CaptureTaskView) => void;
  readonly tryGetRaw: (
    client: CaptureClient,
    captureId: string,
    signal?: AbortSignal,
  ) => Promise<RawCaptureV1 | undefined>;
}

export type CaptureWorkbenchStoreEvent =
  | { readonly type: 'completed'; readonly event: CaptureCompletedEvent }
  | { readonly type: 'failed'; readonly event: CaptureFailedEvent }
  | { readonly type: 'canceled'; readonly task: CaptureTaskView }
  | { readonly type: 'task-changed'; readonly task: CaptureTaskView };

export interface SettledResource {
  readonly isLoading: () => boolean;
}

export interface CaptureTaskPatch {
  readonly taskId: string;
  readonly patch: Partial<CaptureTaskView>;
}

export type CaptureWorkflowFailure = CaptureFailureV1;
export type CaptureWorkflowJob = CaptureJobV1;
export type CaptureWorkflowRaw = RawCaptureV1;
export type CaptureWorkflowCandidate = CaptureStructuringCandidateV1;
