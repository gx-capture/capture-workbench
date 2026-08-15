import type {
  CaptureDocument,
  RawCapture,
} from '@gx-capture/capture-workbench-ui';

export type DesktopLibraryStatus =
  | 'queued'
  | 'processing'
  | 'persisting'
  | 'recovery_required'
  | 'awaiting_confirmation'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface DesktopLibrarySummary {
  readonly documentId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly status: DesktopLibraryStatus;
  readonly stage?: string;
  readonly captureId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly recoveryCode?: string;
  readonly recoveryMessage?: string;
}

export interface DesktopLibraryDetail extends DesktopLibrarySummary {
  readonly raw?: RawCapture;
  readonly result?: CaptureDocument;
}

export interface DesktopLibraryExport {
  readonly fileName: string;
  readonly mediaType: string;
  readonly content: string;
}

export interface DesktopRuntimeStatus {
  readonly status: 'starting' | 'ready' | 'failed' | 'stopped';
  readonly detail: string;
}
