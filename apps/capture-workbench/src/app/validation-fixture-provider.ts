import type {
  CaptureClient,
  CaptureStructuringProvider,
} from '@gx/capture-angular';

export interface ValidationCaptureFixture {
  readonly mode: 'deterministic-e2e';
  readonly client: CaptureClient;
  readonly structuringProvider: CaptureStructuringProvider;
}

/** Production builds intentionally expose no in-browser capture fixture. */
export function selectValidationCaptureFixture(
  search: string,
): ValidationCaptureFixture | undefined {
  void search;
  return undefined;
}
