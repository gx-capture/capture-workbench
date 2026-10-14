import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideCaptureWorkbenchInputs } from '../../../contracts';
import type { RuntimeRequirement } from '../../../contracts';
import { NEVER, of } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-angular';
import {
  CaptureWorkbenchTestInputSource,
  DOCUMENT,
  RAW,
  captureWorkbenchRoot,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
  selectFiles,
  streamingOperation,
} from './capture-angular-test-support';

const READER: RuntimeRequirement = {
  requirementId: 'vertical-japanese-reader',
  kind: 'vertical-reader',
  displayName: 'Vertical Japanese reader',
  status: 'installable',
  requiredFor: ['pdf', 'image'],
  installStrategy: 'runtime-catalog',
  optional: true,
};

describe('CaptureWorkbenchComponent optional units', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;
  let inputSource: CaptureWorkbenchTestInputSource;

  beforeEach(async () => {
    inputSource = createCaptureWorkbenchTestInputSource();
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
      providers: [provideCaptureWorkbenchInputs(inputSource)],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  async function settle(): Promise<ShadowRoot> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return captureWorkbenchRoot(fixture);
  }

  it('does not hold up captures for an optional unit that is not installed', async () => {
    inputSource.client.set(
      fakeClient({ getRequirements: vi.fn(() => of([READER])) }),
    );
    inputSource.config.set({ structuringMode: 'runtime' });
    await settle();

    expect(fixture.componentInstance.store.requiredRequirements()).toEqual([]);
    expect(fixture.componentInstance.store.captureDisabled()).toBe(false);
  });

  it('offers the unit a finished capture missed and installs it on request', async () => {
    const startInstallation = vi.fn(() => NEVER);
    inputSource.client.set(
      fakeClient({
        getRequirements: vi.fn(() => of([READER])),
        startInstallation,
        getStreamingResult: vi.fn(() =>
          of({
            operation: streamingOperation('completed'),
            raw: RAW,
            result: {
              ...DOCUMENT,
              suggestedUnits: ['vertical-japanese-reader' as const],
            },
          }),
        ),
      }),
    );
    inputSource.config.set({ structuringMode: 'runtime' });
    await settle();
    selectFiles(fixture, [
      new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    const root = await settle();

    const hint = root.querySelector('[data-testid="capture-suggested-unit"]');
    expect(hint?.getAttribute('data-requirement-id')).toBe(
      'vertical-japanese-reader',
    );
    (hint?.querySelector('button') as HTMLButtonElement).click();
    await settle();

    expect(startInstallation).toHaveBeenCalledOnce();
    expect(startInstallation.mock.calls[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirementId: 'vertical-japanese-reader' }),
      ]),
    );
  });

  it('shows no offer when the result suggests nothing', async () => {
    inputSource.client.set(
      fakeClient({ getRequirements: vi.fn(() => of([READER])) }),
    );
    inputSource.config.set({ structuringMode: 'runtime' });
    await settle();
    selectFiles(fixture, [
      new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    const root = await settle();

    expect(root.querySelector('[data-testid="capture-suggested-unit"]')).toBeNull();
  });
});
