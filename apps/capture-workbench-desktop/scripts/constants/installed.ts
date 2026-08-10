export const INSTALLED_EXECUTABLE_NAME = 'capture-workbench-desktop.exe';
export const UNINSTALLER_NAME = 'uninstall.exe';
export const PRODUCT_REGISTRY_KEY =
  'HKCU\\Software\\github\\Capture Workbench';
export const UNINSTALL_REGISTRY_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Capture Workbench';
export const REGISTRY_VIEWS = ['64', '32'];

export const EXPECTED_REQUIREMENT_IDS = [
  'windowsml-ocr',
  'whisper-primary',
  'ollama-runtime',
  'capture-ollama-model',
];
export const CAPTURE_BLOCK_TYPES = new Set([
  'heading',
  'paragraph',
  'list-item',
  'table',
  'quote',
  'transcript',
]);
export const CHILD_ENVIRONMENT_ALLOWLIST = [
  'COMSPEC',
  'CUDA_PATH',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'USERPROFILE',
  'WINDIR',
];

export const INSTALLED_FIXTURES = [
  {
    sourceKind: 'pdf',
    fileName: 'installed-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(
      '%PDF-1.7\nCAPTURE_TEXT:Installed PDF page one\fInstalled PDF page two',
      'utf8',
    ),
    locatorKind: 'page',
    expectedSegments: 2,
    expectedTexts: ['Installed PDF page one', 'Installed PDF page two'],
  },
  {
    sourceKind: 'image',
    fileName: 'installed-fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('CAPTURE_TEXT:Installed image words', 'utf8'),
    ]),
    locatorKind: 'page',
    expectedSegments: 1,
    expectedTexts: ['Installed image words'],
  },
  {
    sourceKind: 'audio',
    fileName: 'installed-fixture.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'ascii'),
      Buffer.from(
        'CAPTURE_TEXT:Installed audio one|Installed audio two',
        'utf8',
      ),
    ]),
    locatorKind: 'time',
    expectedSegments: 2,
    expectedTexts: ['Installed audio one', 'Installed audio two'],
  },
] as const;
