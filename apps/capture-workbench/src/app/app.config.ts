import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  CAPTURE_CLIENT,
  CAPTURE_STRUCTURING_PROVIDER,
  CAPTURE_WORKBENCH_INPUTS,
} from '@gx/capture-workbench';
import { ValidationCaptureClientService } from './services/validation-client.service';
import { CaptureWorkbenchUiState } from './services/capture-workbench-ui-state.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    {
      provide: CAPTURE_CLIENT,
      useExisting: ValidationCaptureClientService,
    },
    {
      provide: CAPTURE_STRUCTURING_PROVIDER,
      useFactory: (client: ValidationCaptureClientService) =>
        client.structuringProvider ?? null,
      deps: [ValidationCaptureClientService],
    },
    {
      provide: CAPTURE_WORKBENCH_INPUTS,
      useFactory: (state: CaptureWorkbenchUiState) => ({
        config: () => state.config(),
      }),
      deps: [CaptureWorkbenchUiState],
    },
  ],
};
