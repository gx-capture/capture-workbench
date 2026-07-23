import {
  Component,
  ElementRef,
  Injectable,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  type CaptureClient,
  type CaptureCompletedEvent,
  type CaptureFailedEvent,
  type CapturePreprocessor,
  type CaptureStructuringProvider,
  type CaptureTaskView,
  type CaptureWorkbenchInputSource,
  type CaptureWorkbenchConfig,
  type CaptureDensity,
  type CaptureOutputMode,
  CAPTURE_WORKBENCH_INPUTS,
} from '../../../contracts';
import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  CaptureWorkbenchEventFactory,
} from '../../services/capture-workbench-events/capture-workbench-events';
import { CaptureWorkbenchComponent } from '../capture-angular/capture-angular';

/**
 * Angular-facing facade for the framework-neutral `capture-workbench` element.
 * Angular Elements owns this component's lifecycle and input property bridge;
 * capture behavior remains in CaptureWorkbenchComponent.
 */
@Injectable()
class CaptureWorkbenchElementInputBridge
  implements CaptureWorkbenchInputSource
{
  readonly config = signal<CaptureWorkbenchConfig>({});
  readonly client = signal<CaptureClient | null>(null);
  readonly structuringProvider = signal<CaptureStructuringProvider | null>(
    null,
  );
  readonly preprocessor = signal<CapturePreprocessor | null>(null);
}

@Component({
  selector: 'gx-capture-workbench-element-facade',
  imports: [CaptureWorkbenchComponent],
  providers: [
    CaptureWorkbenchElementInputBridge,
    {
      provide: CAPTURE_WORKBENCH_INPUTS,
      useExisting: CaptureWorkbenchElementInputBridge,
    },
  ],
  template: `
    <gx-capture-workbench
      (completed)="onCompleted($event)"
      (failed)="onFailed($event)"
      (canceled)="onCanceled($event)"
      (taskChanged)="onTaskChanged($event)"
    />
  `,
})
export class CaptureWorkbenchElementFacadeComponent {
  private readonly hostElement = inject(ElementRef<HTMLElement>);
  private readonly inputBridge = inject(CaptureWorkbenchElementInputBridge);
  private readonly eventFactory = inject(CaptureWorkbenchEventFactory);

  readonly config = input<CaptureWorkbenchConfig>(
    {},
    {
      transform: configInput,
    },
  );
  readonly client = input<CaptureClient | null>(null, {
    transform: objectOrNull,
  });
  readonly structuringProvider = input<CaptureStructuringProvider | null>(
    null,
    {
      transform: objectOrNull,
    },
  );
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

  private readonly inputBridgeEffect = effect(() => {
    this.inputBridge.config.set(this.resolvedConfig());
    this.inputBridge.client.set(this.client());
    this.inputBridge.structuringProvider.set(this.structuringProvider());
    this.inputBridge.preprocessor.set(this.preprocessor());
  });

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

  private dispatch<
    T extends CaptureCompletedEvent | CaptureFailedEvent | CaptureTaskView,
  >(
    type: (typeof CAPTURE_WORKBENCH_CUSTOM_EVENTS)[keyof typeof CAPTURE_WORKBENCH_CUSTOM_EVENTS],
    detail: T,
  ): void {
    this.hostElement.nativeElement.dispatchEvent(
      this.eventFactory.create(type, detail),
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
