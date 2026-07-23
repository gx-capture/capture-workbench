import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  CAPTURE_CLIENT,
  CAPTURE_STRUCTURING_PROVIDER,
} from '@gx/capture-angular';
import { ValidationCaptureClientService } from './services/validation-client.service';

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
  ],
};
