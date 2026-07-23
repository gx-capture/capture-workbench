import type {
  CaptureClient,
  CaptureCompletedEvent,
  CaptureFailureV1,
  CapturePreprocessor,
  CaptureStructuringProvider,
  CaptureTaskView,
  RawCaptureV1,
} from '../contracts';
import type { ResolvedCaptureWorkbenchConfig } from '../contracts/workbench';
import type { Observable } from 'rxjs';

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
  ) => Observable<RawCaptureV1 | undefined>;
}

export interface SettledResource {
  readonly isLoading: () => boolean;
}

export interface CaptureTaskPatch {
  readonly taskId: string;
  readonly patch: Partial<CaptureTaskView>;
}

export type CaptureWorkflowFailure = CaptureFailureV1;
