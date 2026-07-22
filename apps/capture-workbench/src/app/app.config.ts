import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideCaptureClient,
  provideCaptureStructuringProvider,
} from '@wodenwang820118/capture-angular';
import { validationCaptureClient } from './validation-client';

const structuringProviders = validationCaptureClient.structuringProvider
  ? [provideCaptureStructuringProvider(validationCaptureClient.structuringProvider)]
  : [];

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideCaptureClient(validationCaptureClient.client),
    ...structuringProviders,
  ],
};
