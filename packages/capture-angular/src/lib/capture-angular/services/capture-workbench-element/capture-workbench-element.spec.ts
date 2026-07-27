import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  createCaptureWorkbenchCustomEvent,
  defineCaptureWorkbenchElement,
  type CaptureWorkbenchElement,
} from './capture-workbench-element';
import { CaptureWorkbenchElementFacadeComponent } from '../../components/capture-workbench-element-facade/capture-workbench-element-facade';
import { TestBed } from '@angular/core/testing';

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
      message: expect.stringMatching(/must contain a hyphen/u),
    }));
  });
});
