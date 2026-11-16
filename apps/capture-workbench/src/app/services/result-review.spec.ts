import type { RawCapture } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryEdits } from '../contracts';
import { applyResultEdit, sameResultEdits, buildResultSpeakers, resultLines, resultPages } from './result-review';

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


describe('result editing rules', () => {
  const empty: DesktopLibraryEdits = { schemaVersion: 1, updatedAtMs: 0, ocrPages: {}, transcriptLines: {}, speakerNames: {} };
  const detail = {
    documentId: 'doc', fileName: 'test', mediaType: 'audio/mpeg', byteLength: 1,
    createdAtMs: 0, updatedAtMs: 0, status: 'completed' as const,
    raw: { ...rawCapture(), speakers: [{ speakerId: 'sp1', displayName: 'Speaker' }] },
  };

  it('removes recognized page and line values, preserves empty corrections, and restores without mutation', () => {
    const page = applyResultEdit(detail, empty, { field: 'ocrPages', key: 1, text: '' }).edits;
    expect(page.ocrPages).toEqual({ '1': '' });
    expect(empty.ocrPages).toEqual({});
    expect(applyResultEdit(detail, page, { field: 'ocrPages', key: 1, text: 'page one' }).edits.ocrPages).toEqual({});
    const line = applyResultEdit(detail, empty, { field: 'transcriptLines', key: 's1', text: 'new' }).edits;
    expect(applyResultEdit(detail, line, { field: 'transcriptLines', key: 's1', text: 'line one' }).edits.transcriptLines).toEqual({});
    expect(applyResultEdit(detail, line, { field: 'transcriptLines', key: 's1', text: null }).edits.transcriptLines).toEqual({});
  });

  it('ignores orphan keys', () => {
    expect(applyResultEdit(detail, empty, { field: 'ocrPages', key: 99, text: 'new' }).edits).toBe(empty);
    expect(applyResultEdit(detail, empty, { field: 'transcriptLines', key: 'missing', text: 'new' }).edits).toBe(empty);
    expect(applyResultEdit(detail, empty, { field: 'speakerNames', key: 'missing', text: 'new' }).edits).toBe(empty);
  });

  it('trims names and removes empty or recognized names', () => {
    const named = applyResultEdit(detail, empty, { field: 'speakerNames', key: 'sp1', text: '  Alice  ' }).edits;
    expect(named.speakerNames).toEqual({ sp1: 'Alice' });
    for (const text of ['   ', 'Speaker']) {
      expect(applyResultEdit(detail, named, { field: 'speakerNames', key: 'sp1', text }).edits.speakerNames).toEqual({});
    }
  });

  it('checks UTF-8 bytes at page and line boundaries and never includes input in errors', () => {
    for (const command of [
      { field: 'ocrPages' as const, key: 1, text: 'a'.repeat(1024 * 1024) },
      { field: 'transcriptLines' as const, key: 's1', text: 'a'.repeat(64 * 1024) },
    ]) {
      expect(applyResultEdit(detail, empty, command).error).toBeNull();
      const rejected = applyResultEdit(detail, empty, { ...command, text: command.text + '\u4e00' });
      expect(rejected.edits).toBe(empty);
      expect(rejected.error).toBeTruthy();
      expect(rejected.error).not.toContain(command.text);
      expect(applyResultEdit(detail, empty, { ...command, text: '\u4e00'.repeat(command.text.length / 2) }).error).toBeTruthy();
    }
  });

  it('counts Unicode scalar characters and rejects C0 and C1 controls in names', () => {
    expect(applyResultEdit(detail, empty, { field: 'speakerNames', key: 'sp1', text: '  ' + '\u{1f600}'.repeat(100) + '  ' }).error).toBeNull();
    for (const text of ['a'.repeat(101), 'Alice\n', 'A\u0085B', 'A\u007fB']) {
      const result = applyResultEdit(detail, empty, { field: 'speakerNames', key: 'sp1', text });
      expect(result.error).toBeTruthy();
      expect(result.edits).toBe(empty);
    }
  });

  it('compares only map contents, independent of ordering and timestamps', () => {
    expect(sameResultEdits({ ...empty, ocrPages: { '1': 'a', '3': 'b' } }, { ...empty, updatedAtMs: 99, ocrPages: { '3': 'b', '1': 'a' } })).toBe(true);
    expect(sameResultEdits(empty, { ...empty, transcriptLines: { s1: '' } })).toBe(false);
  });
});
