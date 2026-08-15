import type {
  CaptureClient,
  CaptureCompletedEvent,
  CaptureFailedEvent,
  CapturePreprocessor,
  CaptureStructuringProvider,
  CaptureTaskView,
  CaptureWorkbenchConfig,
  RuntimeReady,
  RuntimeRequirement,
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
  readonly reviewBeforeCommit: boolean;
  readonly reviewEditable: boolean;
  readonly width: string;
  readonly height: string;
  readonly density: 'compact' | 'comfortable';
  readonly compatibleRuntimeMajor: number;
  readonly compatibleRuntimeMinor: number;
}

export interface RuntimeViewState {
  readonly status:
    | 'idle'
    | 'checking'
    | 'ready'
    | 'needs-setup'
    | 'incompatible'
    | 'error';
  readonly ready?: RuntimeReady;
  readonly requirements: readonly RuntimeRequirement[];
  readonly error?: string;
}

export interface RuntimeHandshake {
  readonly ready: RuntimeReady;
  readonly requirements: readonly RuntimeRequirement[];
}

export interface CaptureWorkbenchInputSource {
  /** Reads the current component configuration. Signal-backed readers are supported. */
  readonly config?: () => CaptureWorkbenchConfig;
  /** Reads the current client, falling back to `CAPTURE_CLIENT` when omitted/null. */
  readonly client?: () => CaptureClient | null;
  /** Reads the current provider, falling back to `CAPTURE_STRUCTURING_PROVIDER`. */
  readonly structuringProvider?: () => CaptureStructuringProvider | null;
  /** Reads the current preprocessor, falling back to `CAPTURE_PREPROCESSOR`. */
  readonly preprocessor?: () => CapturePreprocessor | null;
}

export type CaptureWorkbenchStoreEvent =
  | { readonly type: 'review-required'; readonly task: CaptureTaskView }
  | { readonly type: 'completed'; readonly event: CaptureCompletedEvent }
  | { readonly type: 'failed'; readonly event: CaptureFailedEvent }
  | { readonly type: 'canceled'; readonly task: CaptureTaskView }
  | { readonly type: 'task-changed'; readonly task: CaptureTaskView };
