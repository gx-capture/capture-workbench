import {
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  inject,
  input,
} from '@angular/core';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureFailedEvent,
  type CapturePreprocessor,
  type CaptureStructuringProvider,
  type CaptureTaskView,
  type CaptureWorkbenchConfig,
  type CaptureDensity,
  type CaptureOutputMode,
} from '../contracts';
import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  createCaptureWorkbenchCustomEvent,
} from './capture-workbench-events';
import { CaptureWorkbenchComponent } from './capture-angular';

/**
 * Angular-facing facade for the framework-neutral `capture-workbench` element.
 * Angular Elements owns this component's lifecycle and input property bridge;
 * capture behavior remains in CaptureWorkbenchComponent.
 */
@Component({
  selector: 'gx-capture-workbench-element-facade',
  imports: [CaptureWorkbenchComponent],
  template: `
    <gx-capture-workbench
      [config]="resolvedConfig()"
      [client]="client()"
      [structuringProvider]="structuringProvider()"
      [preprocessor]="preprocessor()"
      (completed)="onCompleted($event)"
      (failed)="onFailed($event)"
      (canceled)="onCanceled($event)"
      (taskChanged)="onTaskChanged($event)"
    />
  `,
})
export class CaptureWorkbenchElementFacadeComponent {
  private readonly hostElement = inject(ElementRef<HTMLElement>);

  readonly config = input<CaptureWorkbenchConfig>({}, {
    transform: configInput,
  });
  readonly client = input<CaptureClient | null>(null, {
    transform: objectOrNull,
  });
  readonly structuringProvider = input<CaptureStructuringProvider | null>(null, {
    transform: objectOrNull,
  });
  readonly preprocessor = input<CapturePreprocessor | null>(null, {
    transform: objectOrNull,
  });

  readonly outputMode = input<CaptureOutputMode | undefined>(undefined, {
    transform: enumAttribute(['json', 'text']),
  });
  readonly multiple = input<boolean | undefined>(undefined, {
    transform: optionalBooleanAttribute,
  });
  readonly targetLanguage = input<string | undefined>(undefined, {
    transform: optionalStringAttribute,
  });
  readonly showRuntimeSetup = input<boolean | undefined>(undefined, {
    transform: optionalBooleanAttribute,
  });
  readonly width = input<string | undefined>(undefined, {
    transform: optionalStringAttribute,
  });
  readonly height = input<string | undefined>(undefined, {
    transform: optionalStringAttribute,
  });
  readonly density = input<CaptureDensity | undefined>(undefined, {
    transform: enumAttribute(['compact', 'comfortable']),
  });

  protected readonly resolvedConfig = computed<CaptureWorkbenchConfig>(() => ({
    ...(this.outputMode() === undefined
      ? {}
      : { outputMode: this.outputMode() }),
    ...(this.multiple() === undefined ? {} : { multiple: this.multiple() }),
    ...(this.targetLanguage() === undefined
      ? {}
      : { targetLanguage: this.targetLanguage() }),
    ...(this.showRuntimeSetup() === undefined
      ? {}
      : { showRuntimeSetup: this.showRuntimeSetup() }),
    ...(this.width() === undefined ? {} : { width: this.width() }),
    ...(this.height() === undefined ? {} : { height: this.height() }),
    ...(this.density() === undefined ? {} : { density: this.density() }),
    ...this.config(),
  }));

  protected onCompleted(event: CaptureCompletedEvent): void {
    this.dispatch(CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed, event);
  }

  protected onFailed(event: CaptureFailedEvent): void {
    this.dispatch(CAPTURE_WORKBENCH_CUSTOM_EVENTS.failed, event);
  }

  protected onCanceled(event: CaptureTaskView): void {
    this.dispatch(CAPTURE_WORKBENCH_CUSTOM_EVENTS.canceled, event);
  }

  protected onTaskChanged(event: CaptureTaskView): void {
    this.dispatch(CAPTURE_WORKBENCH_CUSTOM_EVENTS.taskChanged, event);
  }

  private dispatch<T extends CaptureCompletedEvent | CaptureFailedEvent | CaptureTaskView>(
    type: (typeof CAPTURE_WORKBENCH_CUSTOM_EVENTS)[keyof typeof CAPTURE_WORKBENCH_CUSTOM_EVENTS],
    detail: T,
  ): void {
    this.hostElement.nativeElement.dispatchEvent(
      createCaptureWorkbenchCustomEvent(type, detail),
    );
  }
}

function configInput(value: unknown): CaptureWorkbenchConfig {
  return isRecord(value) ? (value as CaptureWorkbenchConfig) : {};
}

function objectOrNull<T>(value: unknown): T | null {
  return isRecord(value) ? (value as T) : null;
}

function optionalBooleanAttribute(value: unknown): boolean | undefined {
  return value === null || value === undefined
    ? undefined
    : booleanAttribute(value);
}

function optionalStringAttribute(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function enumAttribute<T extends string>(
  allowed: readonly T[],
): (value: unknown) => T | undefined {
  return (value: unknown) =>
    typeof value === 'string' && allowed.includes(value as T)
      ? (value as T)
      : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
