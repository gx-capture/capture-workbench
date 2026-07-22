import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  createCaptureWorkbenchCustomEvent,
  defineCaptureWorkbenchElement,
  parseCaptureWorkbenchConfigAttribute,
  serializeCaptureWorkbenchConfigAttribute,
  type CaptureWorkbenchElement,
} from './capture-workbench-element';

describe('Capture Workbench custom element', () => {
  it('round-trips the JSON-only config attribute', () => {
    const config = {
      multiple: false,
      outputMode: 'text' as const,
      theme: { accent: '#7c3aed' },
    };

    expect(parseCaptureWorkbenchConfigAttribute(null)).toEqual({});
    expect(
      parseCaptureWorkbenchConfigAttribute(
        serializeCaptureWorkbenchConfigAttribute(config),
      ),
    ).toEqual(config);
    expect(() => parseCaptureWorkbenchConfigAttribute('not-json')).toThrow(
      /valid JSON/u,
    );
    expect(() => parseCaptureWorkbenchConfigAttribute('[]')).toThrow(
      /JSON object/u,
    );
  });

  it('uses bubbling, composed events with stable names', () => {
    const event = createCaptureWorkbenchCustomEvent(
      CAPTURE_WORKBENCH_CUSTOM_EVENTS.configError,
      { attribute: 'config', message: 'invalid' },
    );

    expect(event.type).toBe('capture-config-error');
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
    expect(event.detail).toEqual({ attribute: 'config', message: 'invalid' });
  });

  it('mounts configuration from a property and rejects malformed attributes', async () => {
    const tagName = `capture-workbench-test-${Date.now()}`;
    await defineCaptureWorkbenchElement({ tagName });
    const element = document.createElement(tagName) as CaptureWorkbenchElement;
    const errors: Event[] = [];
    element.config = { hostManagedHandshake: true, showRuntimeSetup: false };
    element.addEventListener(CAPTURE_WORKBENCH_CUSTOM_EVENTS.configError, (event) =>
      errors.push(event),
    );
    document.body.append(element);

    expect(element.config.hostManagedHandshake).toBe(true);
    expect(element.textContent).toContain('Capture workbench');
    element.setAttribute('config', '[]');

    expect(errors).toHaveLength(1);
    expect(element.config.hostManagedHandshake).toBe(true);
    element.remove();
  });

  it('requires a valid custom-element tag name', async () => {
    await expect(
      defineCaptureWorkbenchElement({ tagName: 'captureworkbench' }),
    ).rejects.toThrow(/must contain a hyphen/u);
  });
});
