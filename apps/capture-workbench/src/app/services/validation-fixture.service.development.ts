import { Injectable, inject } from '@angular/core';
import { ValidationEnvironmentService } from './validation-environment.service';
import { DeterministicCaptureClientService } from './deterministic-capture.service';
import { DeterministicStructuringProviderService } from './deterministic-structuring.service';
import type { ValidationCaptureFixture } from '../contracts';

@Injectable({ providedIn: 'root' })
export class ValidationCaptureFixtureService {
  private readonly environment = inject(ValidationEnvironmentService);
  private readonly client = inject(DeterministicCaptureClientService);
  private readonly structuringProvider = inject(
    DeterministicStructuringProviderService,
  );

  select(): ValidationCaptureFixture | undefined {
    const requestedMode = new URLSearchParams(this.environment.search).get(
      'captureClient',
    );
    if (requestedMode !== 'deterministic-e2e') return undefined;

    return {
      mode: 'deterministic-e2e',
      client: this.client,
      structuringProvider: this.structuringProvider,
    };
  }
}
