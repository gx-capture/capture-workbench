export const DETERMINISTIC_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const DETERMINISTIC_SCHEMA_VERSION = '1';

export const DETERMINISTIC_FIXTURES = [
  {
    fileName: 'licensed-fixture.pdf',
    content: Buffer.from(
      '%PDF-1.7\nCAPTURE_TEXT:First page\fSecond page',
      'utf8',
    ),
    mediaType: 'application/pdf',
    locatorKind: 'page',
    expectedSegments: 2,
  },
  {
    fileName: 'licensed-fixture.png',
    content: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('CAPTURE_TEXT:Image words', 'utf8'),
    ]),
    mediaType: 'image/png',
    locatorKind: 'page',
    expectedSegments: 1,
  },
  {
    fileName: 'licensed-fixture.wav',
    content: Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'ascii'),
      Buffer.from('CAPTURE_TEXT:Hello|World', 'utf8'),
    ]),
    mediaType: 'audio/wav',
    locatorKind: 'time',
    expectedSegments: 2,
  },
] as const;
