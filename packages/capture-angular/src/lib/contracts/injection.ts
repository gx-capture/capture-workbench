import { InjectionToken, type Provider } from '@angular/core';
import type {
  CaptureClient,
  CapturePreprocessor,
  CaptureStructuringProvider,
} from './index';
import type { CaptureWorkbenchInputSource } from './workbench';

export const CAPTURE_CLIENT = new InjectionToken<CaptureClient>(
  'CAPTURE_CLIENT',
);
export const CAPTURE_STRUCTURING_PROVIDER =
  new InjectionToken<CaptureStructuringProvider>(
    'CAPTURE_STRUCTURING_PROVIDER',
  );
export const CAPTURE_PREPROCESSOR = new InjectionToken<CapturePreprocessor>(
  'CAPTURE_PREPROCESSOR',
);
export const CAPTURE_WORKBENCH_INPUTS =
  new InjectionToken<CaptureWorkbenchInputSource>('CAPTURE_WORKBENCH_INPUTS');

export function provideCaptureClient(client: CaptureClient): Provider {
  return { provide: CAPTURE_CLIENT, useValue: client };
}

export function provideCaptureStructuringProvider(
  provider: CaptureStructuringProvider,
): Provider {
  return { provide: CAPTURE_STRUCTURING_PROVIDER, useValue: provider };
}

export function provideCapturePreprocessor(
  preprocessor: CapturePreprocessor,
): Provider {
  return { provide: CAPTURE_PREPROCESSOR, useValue: preprocessor };
}

export function provideCaptureWorkbenchInputs(
  source: CaptureWorkbenchInputSource,
): Provider {
  return { provide: CAPTURE_WORKBENCH_INPUTS, useValue: source };
}
