import type {
  CaptureClient,
  CaptureCompletedEvent,
  CaptureFailure,
  CapturePreprocessor,
  CaptureStructuringProvider,
  CaptureTaskView,
  RawCapture,
} from '../../../contracts';
import type { ResolvedCaptureWorkbenchConfig } from '../../../contracts/workbench';

export interface RuntimeRequest {
  readonly client: CaptureClient | null;
  readonly compatibleRuntimeMajor: number;
  readonly compatibleRuntimeMinor: number;
  readonly structuringMode: 'runtime' | 'host';
}

export interface InternalCaptureTask {
  readonly file: File;
  readonly clientRequestId: string;
  readonly controller: AbortController;
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
    error: CaptureFailure,
    raw?: RawCapture,
  ) => void;
  readonly failTask: (
    taskId: string,
    fileName: string,
    error: CaptureFailure,
    raw?: RawCapture,
    stage?: CaptureTaskView['stage'],
  ) => void;
  readonly emitCompleted: (event: CaptureCompletedEvent) => void;
  readonly emitCanceled: (task: CaptureTaskView) => void;
}

export interface SettledResource {
  readonly isLoading: () => boolean;
}

export interface CaptureTaskPatch {
  readonly taskId: string;
  readonly patch: Partial<CaptureTaskView>;
}

export type CaptureWorkflowFailure = CaptureFailure;
