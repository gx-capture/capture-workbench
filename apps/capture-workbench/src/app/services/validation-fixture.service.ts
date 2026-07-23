import { Injectable } from '@angular/core';
import type { ValidationCaptureFixture } from '../contracts';

@Injectable({ providedIn: 'root' })
export class ValidationCaptureFixtureService {
  select(): ValidationCaptureFixture | undefined {
    return undefined;
  }
}
