import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  CaptureWorkbenchElementRegistrationService,
  createCaptureWorkbenchCustomEvent,
  defineCaptureWorkbenchElement,
  type CaptureWorkbenchElement,
} from './capture-workbench-element';
import { CaptureWorkbenchElementFacadeComponent } from '../../components/capture-workbench-element-facade/capture-workbench-element-facade';
import { type ApplicationConfig, type ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

describe('Capture Workbench custom element', () => {
  it('uses bubbling, composed events with stable names', () => {
    const event = createCaptureWorkbenchCustomEvent(
      CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed,
      { taskId: 'task-1', document: {} as never },
    );

    expect(event.type).toBe('capture-completed');
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
    expect(event.detail.taskId).toBe('task-1');

    const reviewEvent = createCaptureWorkbenchCustomEvent(
      CAPTURE_WORKBENCH_CUSTOM_EVENTS.reviewRequired,
      {
        id: 'task-1',
        fileName: 'scan.pdf',
        sourceKind: 'pdf',
        status: 'awaiting_confirmation',
        progress: 70,
      },
    );
    expect(reviewEvent.type).toBe('capture-review-required');
    expect(reviewEvent.bubbles).toBe(true);
    expect(reviewEvent.composed).toBe(true);
  });

  it('merges common primitive attributes below the config property', async () => {
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchElementFacadeComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(
      CaptureWorkbenchElementFacadeComponent,
    );
    fixture.componentRef.setInput('outputMode', 'text');
    fixture.componentRef.setInput('multiple', true);
    fixture.componentRef.setInput('width', '32rem');
    fixture.componentRef.setInput('config', {
      outputMode: 'json',
      width: '48rem',
      showRuntimeSetup: false,
    });
    fixture.detectChanges();

    const instance = fixture.componentInstance as unknown as {
      readonly resolvedConfig: () => Record<string, unknown>;
    };
    expect(instance.resolvedConfig()).toMatchObject({
      outputMode: 'json',
      multiple: true,
      width: '48rem',
      showRuntimeSetup: false,
    });
  });

  it('coerces boolean attributes and ignores invalid enum attributes', async () => {
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchElementFacadeComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(
      CaptureWorkbenchElementFacadeComponent,
    );
    fixture.componentRef.setInput('multiple', 'false');
    fixture.componentRef.setInput('outputMode', 'yaml');
    fixture.componentRef.setInput('density', 'dense');
    fixture.detectChanges();

    const instance = fixture.componentInstance as unknown as {
      readonly resolvedConfig: () => Record<string, unknown>;
    };
    expect(instance.resolvedConfig()).toMatchObject({ multiple: false });
    expect(instance.resolvedConfig()).not.toHaveProperty('outputMode');
    expect(instance.resolvedConfig()).not.toHaveProperty('density');
  });

  it('facade dispatches bubbling and composed completion events', async () => {
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchElementFacadeComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(
      CaptureWorkbenchElementFacadeComponent,
    );
    const received: Event[] = [];
    fixture.nativeElement.addEventListener(
      CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed,
      (event: Event) => received.push(event),
    );

    const facade = fixture.componentInstance as unknown as {
      onCompleted(event: { taskId: string; document: never }): void;
    };
    facade.onCompleted({ taskId: 'task-1', document: {} as never });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'capture-completed',
      bubbles: true,
      composed: true,
    });
  });

  it('ignores unsupported object attributes instead of treating strings as dependencies', async () => {
    const tagName = `capture-workbench-attribute-${Date.now()}`;
    defineCaptureWorkbenchElement({ tagName }).subscribe();
    await vi.waitFor(() => expect(customElements.get(tagName)).toBeDefined());
    const constructor = customElements.get(tagName) as
      | { readonly observedAttributes?: readonly string[] }
      | undefined;
    expect(constructor?.observedAttributes).toEqual([
      'output-mode',
      'multiple',
      'target-language',
      'show-runtime-setup',
      'width',
      'height',
      'density',
    ]);
    const element = document.createElement(tagName) as CaptureWorkbenchElement;
    const client = {} as CaptureWorkbenchElement['client'];
    element.client = client;
    element.setAttribute('client', 'not-a-client');
    element.setAttribute('structuring-provider', 'not-a-provider');
    element.setAttribute('preprocessor', 'not-a-preprocessor');
    element.config = { hostManagedHandshake: true, showRuntimeSetup: false };
    document.body.append(element);

    expect(element.config).toMatchObject({
      hostManagedHandshake: true,
      showRuntimeSetup: false,
    });
    expect(element.client).toBe(client);
    expect(element.querySelector('gx-capture-workbench')).not.toBeNull();
    element.remove();
  });

  it('mounts and reconnects through Angular Elements lifecycle', async () => {
    const tagName = `capture-workbench-reconnect-${Date.now()}`;
    defineCaptureWorkbenchElement({ tagName }).subscribe();
    await vi.waitFor(() => expect(customElements.get(tagName)).toBeDefined());
    const element = document.createElement(tagName) as CaptureWorkbenchElement;
    element.config = { hostManagedHandshake: true, showRuntimeSetup: false };

    document.body.append(element);
    expect(element.querySelector('gx-capture-workbench')).not.toBeNull();
    element.remove();
    document.body.append(element);
    expect(element.querySelector('gx-capture-workbench')).not.toBeNull();
    element.remove();
  });

  it('requires a valid custom-element tag name', async () => {
    let error: unknown;
    defineCaptureWorkbenchElement({ tagName: 'captureworkbench' }).subscribe({
      error: (value) => (error = value),
    });
    expect(error).toEqual(expect.objectContaining({
      message: expect.stringMatching(/invalid custom element tag name/iu),
    }));
  });

  it('shares one registration across service instances and repeated calls', async () => {
    const tagName = `capture-workbench-shared-${Date.now()}`;
    const first = new CaptureWorkbenchElementRegistrationService();
    const second = new CaptureWorkbenchElementRegistrationService();

    const firstRegistration = first.register({ tagName });
    expect(first.register({ tagName })).toBe(firstRegistration);
    expect(second.register({ tagName })).toBe(firstRegistration);

    await Promise.all([
      firstValueFrom(firstRegistration),
      firstValueFrom(second.register({ tagName })),
    ]);
    expect(customElements.get(tagName)).toBeDefined();
  });

  it('rejects a tag already owned by another constructor', async () => {
    const tagName = `capture-workbench-conflict-${Date.now()}`;
    customElements.define(tagName, class extends HTMLElement {});

    await expect(
      firstValueFrom(defineCaptureWorkbenchElement({ tagName })),
    ).rejects.toThrow(/already owned by another constructor/u);
  });

  it('evicts a failed registration so the same tag can be retried', async () => {
    const tagName = `capture-workbench-retry-${Date.now()}`;
    class RetryRegistrationService extends CaptureWorkbenchElementRegistrationService {
      private attempts = 0;

      protected override createAngularApplication(
        config: ApplicationConfig,
      ): Promise<ApplicationRef> {
        this.attempts += 1;
        return this.attempts === 1
          ? Promise.reject(new Error('expected startup failure'))
          : super.createAngularApplication(config);
      }
    }
    const service = new RetryRegistrationService();

    await expect(firstValueFrom(service.register({ tagName }))).rejects.toThrow(
      /expected startup failure/u,
    );
    await expect(
      firstValueFrom(service.register({ tagName })),
    ).resolves.toBeUndefined();
    expect(customElements.get(tagName)).toBeDefined();
  });

  it('destroys the race-losing Angular application when another branded bundle wins', async () => {
    const tagName = `capture-workbench-race-${Date.now()}`;
    let resolveApplication: ((application: ApplicationRef) => void) | undefined;
    let destroyed = false;
    class DelayedRegistrationService extends CaptureWorkbenchElementRegistrationService {
      protected override createAngularApplication(): Promise<ApplicationRef> {
        return new Promise((resolve) => {
          resolveApplication = resolve;
        });
      }
    }
    class WinningElement extends HTMLElement {}
    Object.defineProperty(
      WinningElement,
      Symbol.for('@gx-capture/capture-workbench-ui/element'),
      { value: true },
    );
    const service = new DelayedRegistrationService();
    const registration = firstValueFrom(service.register({ tagName }));
    customElements.define(tagName, WinningElement);
    const application = {
      get destroyed() {
        return destroyed;
      },
      destroy() {
        destroyed = true;
      },
    } as ApplicationRef;
    resolveApplication?.(application);

    await expect(registration).resolves.toBeUndefined();
    expect(destroyed).toBe(true);
    expect(customElements.get(tagName)).toBe(WinningElement);
  });
});
