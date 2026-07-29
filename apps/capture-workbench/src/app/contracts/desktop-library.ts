import type {
  CaptureDocumentV1,
  RawCaptureV1,
} from '@gx-capture/capture-workbench';

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
  readonly raw?: RawCaptureV1;
  readonly result?: CaptureDocumentV1;
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
