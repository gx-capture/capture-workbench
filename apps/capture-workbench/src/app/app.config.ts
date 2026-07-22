import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideCaptureClient,
  provideCaptureStructuringProvider,
} from '@wodenwang820118/capture-angular';
import {
  deterministicStructuringProvider,
} from './deterministic-capture';
import { validationCaptureClient } from './validation-client';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideCaptureClient(validationCaptureClient.client),
    provideCaptureStructuringProvider(deterministicStructuringProvider),
  ],
};
