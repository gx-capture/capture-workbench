import { DESKTOP_LOCALES, desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import type { SourceRejectionReason } from './desktop-library.service';
import { selectionRejectionMessages } from './source-selection-messages';

describe('source selection rejection messages', () => {
  afterEach(() => setDesktopLocale('zh-TW'));
  for (const locale of DESKTOP_LOCALES) {
    it(`groups each reason with a count in ${locale}`, () => {
      setDesktopLocale(locale);
      const reasons: SourceRejectionReason[] = ['unsupported', 'empty', 'tooLarge', 'notRegularFile', 'notLocal', 'unreadable', 'limitReached'];
      const messages = selectionRejectionMessages({ selections: [], rejected: [...reasons, ...reasons] });
      expect(messages).toEqual(reasons.map((reason) => desktopMessages().sourceRejections[reason](2)));
      expect(messages).toHaveLength(7);
      expect(new Set(messages).size).toBe(7);
      expect(messages.every((message) => message.includes('(2)'))).toBe(true);
    });
  }
});
