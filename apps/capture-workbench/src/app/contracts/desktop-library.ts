import type {
  CaptureDocument,
  OcrComputePreflight,
  RawCapture,
} from '@gx-capture/capture-workbench-ui';
import type { OcrEvidenceV1 } from './ocr-evidence';

export type DesktopLibraryStatus =
  | 'queued'
  | 'processing'
  | 'persisting'
  | 'recovery_required'
  | 'awaiting_confirmation'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Choices stored with a file before a capture starts. */
export interface DesktopCaptureOptions {
  /** Pages `1..=K`. Omitted means the whole document, apart from any harness scope. */
  readonly pdfPageCount?: number | null;
  /** Optional spoken language tag (`zh`, `en`, `ja`, etc.) for speech recognition. */
  readonly spokenLanguage?: string | null;
  /** Whether to label speakers when speaker-diarization is ready. */
  readonly identifySpeakers?: boolean | null;
}

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
  readonly captureOptions?: DesktopCaptureOptions | null;
  /** True when the library has stored raw OCR or transcript text. */
  readonly hasRaw?: boolean;
}

export interface DesktopLibraryDetail extends DesktopLibrarySummary {
  readonly edits?: DesktopLibraryEdits;
  readonly editsUnreadable?: boolean;
  readonly raw?: RawCapture;
  readonly result?: CaptureDocument;
  readonly ocrEvidence?: OcrEvidenceV1;
}

export interface DesktopLibraryEdits {
  readonly schemaVersion: 1;
  readonly ocrPages: Readonly<Record<string, string>>;
  readonly transcriptLines: Readonly<Record<string, string>>;
  readonly speakerNames: Readonly<Record<string, string>>;
  readonly updatedAtMs: number;
}

export interface DesktopLibraryExport {
  readonly fileName: string;
  readonly mediaType: string;
  readonly content: string;
}

/** Whether a CUDA driver is present and speech recognition may use the GPU. */
export interface DesktopComputeStatus {
  readonly cudaAvailable: boolean;
  readonly preferGpu: boolean;
}

export interface DesktopRuntimeStatus {
  readonly status: 'starting' | 'ready' | 'failed' | 'stopped';
  readonly detail: string;
  readonly ocrCompute?: OcrComputePreflight | null;
  /**
   * Acceptance-only PDF scope advertised by the packaged harness. An omitted
   * value deliberately means the canonical all-page `1..N` behavior.
   */
  readonly pdfPageNumbers?: readonly number[];
}
