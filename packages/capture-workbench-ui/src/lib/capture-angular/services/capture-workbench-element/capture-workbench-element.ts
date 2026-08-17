import {
  Injectable,
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
} from '../../../contracts';
import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  createCaptureWorkbenchCustomEvent,
  type CaptureWorkbenchCustomEventName,
} from '../capture-workbench-events/capture-workbench-events';
import { CaptureWorkbenchElementFacadeComponent } from '../../components/capture-workbench-element-facade/capture-workbench-element-facade';

export const CAPTURE_WORKBENCH_ELEMENT_TAG = 'capture-workbench';

const CAPTURE_WORKBENCH_REGISTRY_KEY = Symbol.for(
  '@gx-capture/capture-workbench-ui/custom-element-registrations',
);
const CAPTURE_WORKBENCH_ELEMENT_BRAND = Symbol.for(
  '@gx-capture/capture-workbench-ui/element',
);

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

@Injectable({ providedIn: 'root' })
export class CaptureWorkbenchElementRegistrationService {
  protected createAngularApplication(
    config: ApplicationConfig,
  ): ReturnType<typeof createApplication> {
    return createApplication(config);
  }

  /**
   * Registers the framework-neutral capture element with Angular Elements.
   * Registration is idempotent for a tag name so independent bundles can safely
   * call it during startup.
   */
  register(options: CaptureWorkbenchElementOptions = {}): Observable<void> {
    const tagName = options.tagName ?? CAPTURE_WORKBENCH_ELEMENT_TAG;
    if (!isValidCustomElementName(tagName)) {
      return throwError(
        () => new Error(`Invalid custom element tag name: ${tagName}`),
      );
    }

    const registrations = globalRegistrations();
    const existingRegistration = registrations.get(tagName);
    if (existingRegistration) return existingRegistration;
    const existingConstructor = customElements.get(tagName);
    if (existingConstructor) {
      return isCaptureWorkbenchElement(existingConstructor)
        ? of(undefined)
        : throwError(
            () =>
              new Error(
                `Custom element tag "${tagName}" is already owned by another constructor.`,
              ),
          );
    }

    const applicationConfig: ApplicationConfig = {
      providers: [
        provideZonelessChangeDetection(),
        ...(options.providers ?? []),
      ],
    };
    const registration: Observable<void> = defer(
      () => from(this.createAngularApplication(applicationConfig)),
    ).pipe(
      map((applicationRef) => {
        try {
          const winnerBeforeCreation = customElements.get(tagName);
          if (winnerBeforeCreation) {
            if (!isCaptureWorkbenchElement(winnerBeforeCreation)) {
              throw new Error(
                `Custom element tag "${tagName}" is already owned by another constructor.`,
              );
            }
            applicationRef.destroy();
            return undefined;
          }

          const elementConstructor = createCustomElement(
            CaptureWorkbenchElementFacadeComponent,
            { injector: applicationRef.injector },
          );
          Object.defineProperty(
            elementConstructor,
            CAPTURE_WORKBENCH_ELEMENT_BRAND,
            {
              configurable: false,
              enumerable: false,
              value: true,
              writable: false,
            },
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

          const winnerBeforeDefinition = customElements.get(tagName);
          if (winnerBeforeDefinition) {
            if (!isCaptureWorkbenchElement(winnerBeforeDefinition)) {
              throw new Error(
                `Custom element tag "${tagName}" is already owned by another constructor.`,
              );
            }
            applicationRef.destroy();
            return undefined;
          }
          customElements.define(tagName, elementConstructor);
          return undefined;
        } catch (error) {
          if (!applicationRef.destroyed) applicationRef.destroy();
          throw error;
        }
      }),
      catchError((error: unknown) => {
        if (registrations.get(tagName) === registration) {
          registrations.delete(tagName);
        }
        return throwError(() => error);
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    registrations.set(tagName, registration);
    return registration;
  }
}

function globalRegistrations(): Map<string, Observable<void>> {
  const owner = globalThis as typeof globalThis & {
    [key: symbol]: Map<string, Observable<void>> | undefined;
  };
  const existing = owner[CAPTURE_WORKBENCH_REGISTRY_KEY];
  if (existing) return existing;
  const registrations = new Map<string, Observable<void>>();
  Object.defineProperty(owner, CAPTURE_WORKBENCH_REGISTRY_KEY, {
    configurable: false,
    enumerable: false,
    value: registrations,
    writable: false,
  });
  return registrations;
}

function isCaptureWorkbenchElement(
  constructor: CustomElementConstructor,
): boolean {
  return (
    constructor as CustomElementConstructor & {
      [key: symbol]: unknown;
    }
  )[CAPTURE_WORKBENCH_ELEMENT_BRAND] === true;
}

function isValidCustomElementName(tagName: string): boolean {
  return /^[a-z][a-z0-9._-]*-[a-z0-9._-]*$/u.test(tagName);
}

const publicElementRegistrationService =
  new CaptureWorkbenchElementRegistrationService();

/** Thin public adapter for framework-neutral consumers. */
export function defineCaptureWorkbenchElement(
  options: CaptureWorkbenchElementOptions = {},
): Observable<void> {
  return publicElementRegistrationService.register(options);
}

export type { CaptureWorkbenchCustomEventName };

export { CAPTURE_WORKBENCH_CUSTOM_EVENTS, createCaptureWorkbenchCustomEvent };
