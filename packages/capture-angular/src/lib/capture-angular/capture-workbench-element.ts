import {
  provideZonelessChangeDetection,
  type ApplicationConfig,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import {
  createCustomElement,
  type NgElement,
  type WithProperties,
} from '@angular/elements';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  shareReplay,
  throwError,
} from 'rxjs';
import {
  type CaptureClient,
  type CapturePreprocessor,
  type CaptureStructuringProvider,
  type CaptureWorkbenchConfig,
} from '../contracts';
import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  createCaptureWorkbenchCustomEvent,
  type CaptureWorkbenchCustomEventName,
} from './capture-workbench-events';
import { CaptureWorkbenchElementFacadeComponent } from './capture-workbench-element-facade';

export const CAPTURE_WORKBENCH_ELEMENT_TAG = 'capture-workbench';

const CAPTURE_WORKBENCH_DECLARATIVE_ATTRIBUTES = Object.freeze([
  'output-mode',
  'multiple',
  'target-language',
  'show-runtime-setup',
  'width',
  'height',
  'density',
] as const);

export interface CaptureWorkbenchElementOptions {
  /** Defaults to `capture-workbench`; the name must contain a hyphen. */
  readonly tagName?: string;
  /** Shared Angular providers, such as `provideCaptureClient(...)`. */
  readonly providers?: readonly (Provider | EnvironmentProviders)[];
}

export type CaptureWorkbenchElement = NgElement &
  WithProperties<{
    config: CaptureWorkbenchConfig;
    client: CaptureClient | null;
    structuringProvider: CaptureStructuringProvider | null;
    preprocessor: CapturePreprocessor | null;
  }>;

const registrations = new Map<string, Observable<void>>();

/**
 * Registers the framework-neutral capture element with Angular Elements.
 * Registration is idempotent for a tag name so independent bundles can safely
 * call it during startup.
 */
export function defineCaptureWorkbenchElement(
  options: CaptureWorkbenchElementOptions = {},
): Observable<void> {
  const tagName = options.tagName ?? CAPTURE_WORKBENCH_ELEMENT_TAG;
  if (!tagName.includes('-')) {
    return throwError(
      () =>
      new Error('A custom element tag name must contain a hyphen.'),
    );
  }

  const existing = registrations.get(tagName);
  if (existing) return existing;
  if (customElements.get(tagName)) return of(undefined);

  const applicationConfig: ApplicationConfig = {
    providers: [
      provideZonelessChangeDetection(),
      ...(options.providers ?? []),
    ],
  };
  const registration = defer(() => from(createApplication(applicationConfig)))
    .pipe(
      map((applicationRef) => {
      const elementConstructor = createCustomElement(
        CaptureWorkbenchElementFacadeComponent,
        { injector: applicationRef.injector },
      );
      // Angular Elements exposes every component input as an observed
      // attribute by default. Keep object-only inputs property-first by
      // narrowing the browser-facing attribute list after creation; their
      // generated property accessors remain fully managed by Angular.
      Object.defineProperty(elementConstructor, 'observedAttributes', {
        configurable: true,
        enumerable: true,
        value: CAPTURE_WORKBENCH_DECLARATIVE_ATTRIBUTES,
      });
      customElements.define(tagName, elementConstructor);
      return undefined;
      }),
      catchError((error: unknown) => {
      registrations.delete(tagName);
        return throwError(() => error);
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
  registrations.set(tagName, registration);
  return registration;
}

export type {
  CaptureWorkbenchCustomEventName,
};

export {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  createCaptureWorkbenchCustomEvent,
};
