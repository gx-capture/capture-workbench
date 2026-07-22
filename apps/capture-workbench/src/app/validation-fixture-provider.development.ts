import type {
  CaptureClient,
  CaptureStructuringProvider,
} from '@gx/capture-angular';
import {
  DeterministicCaptureClient,
  deterministicStructuringProvider,
} from './deterministic-capture';

export interface ValidationCaptureFixture {
  readonly mode: 'deterministic-e2e';
  readonly client: CaptureClient;
  readonly structuringProvider: CaptureStructuringProvider;
}

/** Enables deterministic fixtures only for the explicit development E2E path. */
export function selectValidationCaptureFixture(
  search: string,
): ValidationCaptureFixture | undefined {
  const requestedMode = new URLSearchParams(search).get('captureClient');
  if (requestedMode !== 'deterministic-e2e') return undefined;

  return {
    mode: 'deterministic-e2e',
    client: new DeterministicCaptureClient(),
    structuringProvider: deterministicStructuringProvider,
  };
}
