import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryEdits } from '../contracts';
import { buildResultSpeakers, resultLines, resultPages } from './result-review';

const edits: DesktopLibraryEdits = {
  schemaVersion: 1, updatedAtMs: 42,
  ocrPages: { '3': '', '99': 'orphan' },
  transcriptLines: { s1: 'edited line', missing: 'orphan' },
  speakerNames: { sp1: 'New name', missing: 'orphan' },
};

function rawCapture(): RawCapture {
  return {
    sourceText: 'recognized',
    segments: [
      { segmentId: 'p3b', order: 2, locator: { kind: 'page', page: 3 }, text: 'second' },
      { segmentId: 'p3a', order: 1, locator: { kind: 'page', page: 3 }, text: 'first' },
      { segmentId: 'p1', order: 0, locator: { kind: 'page', page: 1 }, text: 'page one' },
      { segmentId: 's1', order: 3, locator: { kind: 'time', startMs: 1000, endMs: 2000 }, speaker: 'sp1', text: 'line one' },
      { segmentId: 's2', order: 4, locator: { kind: 'time', startMs: 2000, endMs: 3000 }, speaker: 'sp1', text: 'line two' },
    ],
  } as unknown as RawCapture;
}

describe('result edit overlays', () => {
  it('keys whole OCR pages by page number, preserves order and ignores orphan edits', () => {
    const raw = rawCapture();
    const before = JSON.stringify(raw);
    expect(resultPages(raw, edits)).toEqual([
      { page: 1, text: 'page one', recognizedText: 'page one', edited: false },
      { page: 3, text: '', recognizedText: 'first\nsecond', edited: true },
    ]);
    expect(resultPages(raw)[1]).toEqual({ page: 3, text: 'first\nsecond', recognizedText: 'first\nsecond', edited: false });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('overlays segment text and the same speaker name on every line without mutation', () => {
    const raw = rawCapture();
    const speakers = [{ speakerId: 'sp1', displayName: 'Recognized name' }];
    const before = JSON.stringify({ raw, speakers, edits });
    const lines = resultLines(raw, speakers, edits);
    expect(lines.map(({ text, recognizedText, edited, speaker }) => ({ text, recognizedText, edited, speaker }))).toEqual([
      { text: 'edited line', recognizedText: 'line one', edited: true, speaker: 'New name' },
      { text: 'line two', recognizedText: 'line two', edited: false, speaker: 'New name' },
    ]);
    expect(buildResultSpeakers(speakers, null, edits)[0].displayName).toBe('New name');
    expect(resultLines(raw, speakers)[0]).toMatchObject({ text: 'line one', edited: false, speaker: 'Recognized name' });
    expect(buildResultSpeakers(speakers, null)[0].displayName).toBe('Recognized name');
    expect(JSON.stringify({ raw, speakers, edits })).toBe(before);
  });

  it('applies speaker names without a recognized speaker list and treats equal or empty text as edits', () => {
    const raw = rawCapture();
    const overlay = { ...edits, transcriptLines: { s1: '', s2: 'line two' } };
    expect(resultLines(raw, [], overlay).map((line) => [line.text, line.edited, line.speaker])).toEqual([
      ['', true, 'New name'], ['line two', true, 'New name'],
    ]);
  });

  it('does not treat inherited map properties as edits', () => {
    const raw = rawCapture();
    const inherited = Object.create({ '3': 'inherited' }) as Record<string, string>;
    expect(resultPages(raw, { ...edits, ocrPages: inherited })[1].edited).toBe(false);
  });
});
