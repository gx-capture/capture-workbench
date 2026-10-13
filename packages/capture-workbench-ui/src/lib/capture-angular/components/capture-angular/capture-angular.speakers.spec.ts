import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideCaptureWorkbenchInputs } from '../../../contracts';
import type {
  CaptureClient,
  CaptureDocument,
  RawCapture,
} from '../../../contracts';
import { of } from 'rxjs';
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

const SEGMENTS: RawCapture['segments'] = [
  {
    segmentId: 'segment-1',
    order: 0,
    locator: { kind: 'time', startMs: 0, endMs: 900 },
    text: 'Good morning',
    speaker: 'SPEAKER_00',
    speakerOverlap: false,
  },
  {
    segmentId: 'segment-2',
    order: 1,
    locator: { kind: 'time', startMs: 1100, endMs: 1900 },
    text: 'Hello there',
    speaker: 'SPEAKER_01',
    speakerOverlap: false,
  },
  {
    segmentId: 'segment-3',
    order: 2,
    locator: { kind: 'time', startMs: 2000, endMs: 2400 },
    text: 'mm',
    speaker: null,
    speakerOverlap: true,
  },
];

const SPOKEN: CaptureDocument = {
  ...DOCUMENT,
  rawSegments: SEGMENTS,
  blocks: SEGMENTS.map((segment) => ({
    blockId: `block-${segment.order + 1}`,
    order: segment.order,
    sourceSegmentId: segment.segmentId,
    type: 'transcript' as const,
    locator: segment.locator,
    sourceText: segment.text,
    targetText: segment.text,
  })),
  sourceText: 'Good morning\nHello there\nmm',
  targetText: 'Good morning\nHello there\nmm',
  diarizationEngine: {
    engine: 'speaker-diarization',
    model: 'pyannote-speaker-diarization-community-1',
    digest: `sha256:${'d'.repeat(64)}`,
    device: 'cpu',
  },
  speakers: [
    {
      speakerId: 'SPEAKER_00',
      sample: { kind: 'time', startMs: 0, endMs: 900 },
    },
    { speakerId: 'SPEAKER_01', sample: null },
  ],
};

describe('CaptureWorkbenchComponent speakers', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;
  let inputSource: CaptureWorkbenchTestInputSource;
  let startStreamingCapture: ReturnType<
    typeof vi.fn<NonNullable<CaptureClient['startStreamingCapture']>>
  >;

  beforeEach(async () => {
    inputSource = createCaptureWorkbenchTestInputSource();
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
      providers: [provideCaptureWorkbenchInputs(inputSource)],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
    startStreamingCapture = vi.fn<
      NonNullable<CaptureClient['startStreamingCapture']>
    >(() => of(streamingOperation('completed')));
    inputSource.client.set(
      fakeClient({
        startStreamingCapture,
        getStreamingResult: vi.fn(() =>
          of({
            operation: streamingOperation('completed'),
            raw: { ...RAW, segments: SEGMENTS },
            result: SPOKEN,
          }),
        ),
      }),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  async function capture(file: File): Promise<ShadowRoot> {
    fixture.detectChanges();
    selectFiles(fixture, [file]);
    await fixture.whenStable();
    fixture.detectChanges();
    return captureWorkbenchRoot(fixture);
  }

  const audio = () => new File(['audio'], 'meeting.wav', { type: 'audio/wav' });
  const resultText = (root: ShadowRoot) =>
    root.querySelector('[data-testid="capture-result"]')?.textContent ?? '';

  it('asks for speakers only for audio and only when configured', async () => {
    inputSource.config.set({ showRuntimeSetup: false, identifySpeakers: true });
    await capture(audio());
    expect(startStreamingCapture.mock.calls[0][0].identifySpeakers).toBe(true);

    selectFiles(fixture, [
      new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    expect(startStreamingCapture.mock.calls[1][0].identifySpeakers).toBe(false);
  });

  it('does not ask for speakers by default', async () => {
    inputSource.config.set({ showRuntimeSetup: false });
    await capture(audio());
    expect(startStreamingCapture.mock.calls[0][0].identifySpeakers).toBe(false);
  });

  it('lets the user listen to a sample, name a speaker, and uses the name', async () => {
    inputSource.config.set({
      showRuntimeSetup: false,
      identifySpeakers: true,
      outputMode: 'text',
    });
    const named = vi.fn();
    fixture.componentInstance.speakersNamed.subscribe(named);
    const root = await capture(audio());

    const rows = root.querySelectorAll('[data-testid="capture-speaker"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('audio')?.getAttribute('src')).toBe(
      'blob:recording#t=0,0.9',
    );
    expect(rows[1].querySelector('audio')).toBeNull();
    expect(resultText(root)).toBe(
      'SPEAKER_00: Good morning\nSPEAKER_01: Hello there\nmm',
    );

    const input = rows[0].querySelector('input') as HTMLInputElement;
    input.value = '  Ms. Lin ';
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(resultText(root)).toBe(
      'Ms. Lin: Good morning\nSPEAKER_01: Hello there\nmm',
    );
    expect(named).toHaveBeenCalledOnce();
    const event = named.mock.calls[0][0];
    expect(event.document.speakers[0]).toMatchObject({
      speakerId: 'SPEAKER_00',
      displayName: 'Ms. Lin',
    });
    expect(event.document.rawSegments).toEqual(SEGMENTS);

    input.value = '';
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(resultText(root)).toContain('SPEAKER_00: Good morning');
    expect(named.mock.calls[1][0].document.speakers[0].displayName).toBeNull();
  });

  it('needs the speaker unit only when the host asks for speakers', async () => {
    const unit = {
      requirementId: 'speaker-diarization' as const,
      kind: 'speaker-identification',
      displayName: 'Speaker identification',
      status: 'unavailable' as const,
      requiredFor: ['audio'],
      installStrategy: 'runtime-catalog',
      optional: true,
    };
    inputSource.client.set(fakeClient({ getRequirements: vi.fn(() => of([unit])) }));
    inputSource.config.set({ structuringMode: 'host' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.store.captureDisabled()).toBe(false);
    expect(fixture.componentInstance.store.requiredRequirements()).toEqual([]);

    inputSource.config.set({ structuringMode: 'host', identifySpeakers: true });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.store.requiredRequirements()).toEqual([unit]);
    expect(fixture.componentInstance.store.captureDisabled()).toBe(true);
  });

  it('shows no speaker section for a capture without speakers', async () => {
    inputSource.client.set(fakeClient());
    inputSource.config.set({ showRuntimeSetup: false });
    const root = await capture(
      new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
    );
    expect(root.querySelector('[data-testid="capture-speakers"]')).toBeNull();
  });
});
