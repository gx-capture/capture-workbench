import type {
  CaptureDocumentV1,
  CaptureJobV1,
  RawCaptureV1,
} from '@gx/capture-workbench';

export interface FakeCaptureRecord {
  job: CaptureJobV1;
  raw: RawCaptureV1;
  result?: CaptureDocumentV1;
}
