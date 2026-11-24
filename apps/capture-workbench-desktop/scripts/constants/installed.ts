export const INSTALLED_EXECUTABLE_NAME = 'capture-workbench-desktop.exe';
export const UNINSTALLER_NAME = 'uninstall.exe';
export const PRODUCT_REGISTRY_KEY =
  'HKCU\\Software\\github\\Capture Workbench';
export const UNINSTALL_REGISTRY_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Capture Workbench';
export const REGISTRY_VIEWS = ['64', '32'];

/** The registry keys an installation of the named product writes. */
export function registryKeysForProduct(productName: string): {
  readonly productRegistryKey: string;
  readonly uninstallRegistryKey: string;
} {
  return {
    productRegistryKey: PRODUCT_REGISTRY_KEY.replace('Capture Workbench', productName),
    uninstallRegistryKey: UNINSTALL_REGISTRY_KEY.replace('Capture Workbench', productName),
  };
}

/**
 * The bytes of a source the fixture runtime recognizes: its text follows
 * `CAPTURE_TEXT:` behind the format's magic bytes. PDF pages are separated by
 * a form feed and recording lines by `|`; an image holds one text.
 */
export function fixtureSourceBytes(
  kind: 'pdf' | 'image' | 'recording',
  texts: readonly string[],
): Buffer {
  if (texts.length === 0 || (kind === 'image' && texts.length !== 1)) {
    throw new Error('A fixture source needs its texts: one for an image, one or more otherwise.');
  }
  if (kind === 'pdf') return Buffer.from(`%PDF-1.7\nCAPTURE_TEXT:${texts.join('\f')}`, 'utf8');
  if (kind === 'image') {
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`CAPTURE_TEXT:${texts[0]}`, 'utf8'),
    ]);
  }
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WAVE', 'ascii'),
    Buffer.from(`CAPTURE_TEXT:${texts.join('|')}`, 'utf8'),
  ]);
}

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
    sourceKind: 'pdf' as const,
    fileName: 'installed-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: fixtureSourceBytes('pdf', ['Installed PDF page one', 'Installed PDF page two']),
    locatorKind: 'page' as const,
    expectedSegments: 2,
    expectedTexts: ['Installed PDF page one', 'Installed PDF page two'],
  },
  {
    sourceKind: 'image' as const,
    fileName: 'installed-fixture.png',
    mimeType: 'image/png',
    buffer: fixtureSourceBytes('image', ['Installed image words']),
    locatorKind: 'page' as const,
    expectedSegments: 1,
    expectedTexts: ['Installed image words'],
  },
  {
    sourceKind: 'recording' as const,
    fileName: 'installed-fixture.wav',
    mimeType: 'audio/wav',
    buffer: fixtureSourceBytes('recording', ['Installed audio one', 'Installed audio two']),
    locatorKind: 'time' as const,
    expectedSegments: 2,
    expectedTexts: ['Installed audio one', 'Installed audio two'],
  },
] as const;
