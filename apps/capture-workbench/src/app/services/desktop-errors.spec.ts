// Verifies uninstall error messages and redaction.
import { setDesktopLocale } from '../i18n/desktop-messages';
import { redactSensitiveMessage, uninstallFailureMessage } from './desktop-errors';

describe('redactSensitiveMessage', () => {
  it('redacts bearer and token-shaped values and keeps the rest', () => {
    expect(redactSensitiveMessage('Bearer secret-token failed; token=other-secret, kept')).toBe(
      'Bearer [redacted] failed; token= [redacted], kept',
    );
  });

  it('leaves a missing message missing', () => {
    expect(redactSensitiveMessage(undefined)).toBeUndefined();
  });
});

describe('uninstallFailureMessage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('maps the desktop bridge HTTP status and redacts anything else', () => {
    const rejected = (status: number) =>
      new Error(`Capture Runtime request was rejected with HTTP ${status}.`);
    expect(uninstallFailureMessage(rejected(409))).toBe(
      '安裝或辨識還在進行，請稍後再移除',
    );
    expect(uninstallFailureMessage(rejected(422))).toBe('這項功能無法從這裡移除');
    expect(uninstallFailureMessage(rejected(404))).toBe('找不到這項功能');
    expect(uninstallFailureMessage(new Error('Bearer secret-token failed'))).toBe(
      'Bearer [redacted] failed',
    );
  });
});
