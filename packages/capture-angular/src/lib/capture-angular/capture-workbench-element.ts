import {
  createComponent,
  provideZonelessChangeDetection,
  type ApplicationConfig,
  type ApplicationRef,
  type ComponentRef,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureFailedEvent,
  type CapturePreprocessor,
  type CaptureStructuringProvider,
  type CaptureTaskView,
  type CaptureWorkbenchConfig,
} from '../contracts';
import { CaptureWorkbenchComponent } from './capture-angular';

export const CAPTURE_WORKBENCH_ELEMENT_TAG = 'capture-workbench';

export const CAPTURE_WORKBENCH_CUSTOM_EVENTS = Object.freeze({
  completed: 'capture-completed',
  failed: 'capture-failed',
  canceled: 'capture-canceled',
  taskChanged: 'capture-task-changed',
  configError: 'capture-config-error',
} as const);

export type CaptureWorkbenchCustomEventName =
  (typeof CAPTURE_WORKBENCH_CUSTOM_EVENTS)[keyof typeof CAPTURE_WORKBENCH_CUSTOM_EVENTS];

export interface CaptureWorkbenchConfigError {
  readonly attribute: 'config';
  readonly message: string;
}

export interface CaptureWorkbenchElementOptions {
  /** Defaults to `capture-workbench`; the name must contain a hyphen. */
  readonly tagName?: string;
  /** Shared Angular providers, such as `provideCaptureClient(...)`. */
  readonly providers?: readonly (Provider | EnvironmentProviders)[];
}

export type CaptureWorkbenchElement = HTMLElement & {
  config: CaptureWorkbenchConfig;
  client: CaptureClient | null;
  structuringProvider: CaptureStructuringProvider | null;
  preprocessor: CapturePreprocessor | null;
};

const registrations = new Map<string, Promise<void>>();

/**
 * Registers the framework-neutral capture element. Registration is idempotent
 * for a tag name so independent bundles can safely call it during startup.
 */
export function defineCaptureWorkbenchElement(
  options: CaptureWorkbenchElementOptions = {},
): Promise<void> {
  const tagName = options.tagName ?? CAPTURE_WORKBENCH_ELEMENT_TAG;
  if (!tagName.includes('-')) {
    return Promise.reject(
      new Error('A custom element tag name must contain a hyphen.'),
    );
  }

  const existing = registrations.get(tagName);
  if (existing) return existing;
  if (customElements.get(tagName)) return Promise.resolve();

  const applicationConfig: ApplicationConfig = {
    providers: [
      provideZonelessChangeDetection(),
      ...(options.providers ?? []),
    ],
  };
  const registration = createApplication(applicationConfig)
    .then((applicationRef) => {
      customElements.define(
        tagName,
        createCaptureWorkbenchElementConstructor(applicationRef),
      );
    })
    .catch((error: unknown) => {
      registrations.delete(tagName);
      throw error;
    });
  registrations.set(tagName, registration);
  return registration;
}

/** Parses the JSON-only `config` attribute. Object dependencies stay properties. */
export function parseCaptureWorkbenchConfigAttribute(
  value: string | null,
): CaptureWorkbenchConfig {
  if (value === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('The config attribute must contain valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new TypeError('The config attribute must contain a JSON object.');
  }
  return parsed as CaptureWorkbenchConfig;
}

/** Serializes a property value for declarative HTML without reflecting it automatically. */
export function serializeCaptureWorkbenchConfigAttribute(
  config: CaptureWorkbenchConfig,
): string {
  return JSON.stringify(config);
}

export function createCaptureWorkbenchCustomEvent<T>(
  type: CaptureWorkbenchCustomEventName,
  detail: T,
): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

function createCaptureWorkbenchElementConstructor(
  applicationRef: ApplicationRef,
): CustomElementConstructor {
  return class CaptureWorkbenchElementImpl extends HTMLElement {
    private componentRef?: ComponentRef<CaptureWorkbenchComponent>;
    private subscriptions: Array<{ unsubscribe(): void }> = [];
    private configValue: CaptureWorkbenchConfig = {};
    private clientValue: CaptureClient | null = null;
    private structuringProviderValue: CaptureStructuringProvider | null = null;
    private preprocessorValue: CapturePreprocessor | null = null;

    static get observedAttributes(): string[] {
      return ['config'];
    }

    get config(): CaptureWorkbenchConfig {
      return this.configValue;
    }

    set config(value: CaptureWorkbenchConfig) {
      if (!isRecord(value)) {
        throw new TypeError('Capture Workbench config must be an object.');
      }
      this.configValue = value;
      this.componentRef?.setInput('config', value);
    }

    get client(): CaptureClient | null {
      return this.clientValue;
    }

    set client(value: CaptureClient | null) {
      this.clientValue = value;
      this.componentRef?.setInput('client', value);
    }

    get structuringProvider(): CaptureStructuringProvider | null {
      return this.structuringProviderValue;
    }

    set structuringProvider(value: CaptureStructuringProvider | null) {
      this.structuringProviderValue = value;
      this.componentRef?.setInput('structuringProvider', value);
    }

    get preprocessor(): CapturePreprocessor | null {
      return this.preprocessorValue;
    }

    set preprocessor(value: CapturePreprocessor | null) {
      this.preprocessorValue = value;
      this.componentRef?.setInput('preprocessor', value);
    }

    connectedCallback(): void {
      if (this.hasAttribute('config')) this.applyConfigAttribute();
      if (this.componentRef) return;

      const componentRef = createComponent(CaptureWorkbenchComponent, {
        environmentInjector: applicationRef.injector,
        hostElement: this,
      });
      this.componentRef = componentRef;
      componentRef.setInput('config', this.configValue);
      componentRef.setInput('client', this.clientValue);
      componentRef.setInput(
        'structuringProvider',
        this.structuringProviderValue,
      );
      componentRef.setInput('preprocessor', this.preprocessorValue);
      this.subscriptions = [
        componentRef.instance.completed.subscribe((event) =>
          this.emit(CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed, event),
        ),
        componentRef.instance.failed.subscribe((event) =>
          this.emit(CAPTURE_WORKBENCH_CUSTOM_EVENTS.failed, event),
        ),
        componentRef.instance.canceled.subscribe((event) =>
          this.emit(CAPTURE_WORKBENCH_CUSTOM_EVENTS.canceled, event),
        ),
        componentRef.instance.taskChanged.subscribe((event) =>
          this.emit(CAPTURE_WORKBENCH_CUSTOM_EVENTS.taskChanged, event),
        ),
      ];
      applicationRef.attachView(componentRef.hostView);
      componentRef.changeDetectorRef.detectChanges();
    }

    disconnectedCallback(): void {
      const componentRef = this.componentRef;
      if (!componentRef) return;
      this.componentRef = undefined;
      for (const subscription of this.subscriptions) subscription.unsubscribe();
      this.subscriptions = [];
      applicationRef.detachView(componentRef.hostView);
      componentRef.destroy();
    }

    attributeChangedCallback(
      name: string,
      previous: string | null,
      current: string | null,
    ): void {
      if (name === 'config' && previous !== current) this.applyConfigAttribute();
    }

    private applyConfigAttribute(): void {
      try {
        this.config = parseCaptureWorkbenchConfigAttribute(
          this.getAttribute('config'),
        );
      } catch (error: unknown) {
        this.emit(CAPTURE_WORKBENCH_CUSTOM_EVENTS.configError, {
          attribute: 'config',
          message:
            error instanceof Error
              ? error.message
              : 'The config attribute is invalid.',
        } satisfies CaptureWorkbenchConfigError);
      }
    }

    private emit(
      type: CaptureWorkbenchCustomEventName,
      detail:
        | CaptureCompletedEvent
        | CaptureFailedEvent
        | CaptureTaskView
        | CaptureWorkbenchConfigError,
    ): void {
      this.dispatchEvent(createCaptureWorkbenchCustomEvent(type, detail));
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
