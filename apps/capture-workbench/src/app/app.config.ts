import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideCaptureClient,
  provideCaptureStructuringProvider,
} from '@gx/capture-angular';
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
