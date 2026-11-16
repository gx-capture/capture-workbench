import { TestBed } from '@angular/core/testing';
import {
  DESKTOP_LOCALE_STORAGE_KEY,
  setDesktopLocale,
} from '../i18n/desktop-messages';
import { GeneralPage } from './general-page';

describe('GeneralPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  afterEach(() => {
    setDesktopLocale('zh-TW');
    localStorage.removeItem(DESKTOP_LOCALE_STORAGE_KEY);
  });

  it('renders both language options and switches between Traditional Chinese and English', () => {
    TestBed.configureTestingModule({ imports: [GeneralPage] });
    const fixture = TestBed.createComponent(GeneralPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('h2')?.textContent?.trim()).toBe('一般');
    expect(
      el.querySelector('[data-testid="general-language"] legend')?.textContent?.trim(),
    ).toBe('語言');

    const zh = el.querySelector(
      '[data-testid="general-language-option"][data-locale="zh-TW"]',
    ) as HTMLInputElement;
    const en = el.querySelector(
      '[data-testid="general-language-option"][data-locale="en"]',
    ) as HTMLInputElement;
    expect(zh.checked).toBe(true);
    expect(en.checked).toBe(false);

    en.click();
    fixture.detectChanges();

    expect(el.querySelector('h2')?.textContent?.trim()).toBe('General');
    expect(
      el.querySelector('[data-testid="general-language"] legend')?.textContent?.trim(),
    ).toBe('Language');
    expect(en.checked).toBe(true);
    expect(localStorage.getItem(DESKTOP_LOCALE_STORAGE_KEY)).toBe('en');

    zh.click();
    fixture.detectChanges();

    expect(el.querySelector('h2')?.textContent?.trim()).toBe('一般');
    expect(zh.checked).toBe(true);
    expect(localStorage.getItem(DESKTOP_LOCALE_STORAGE_KEY)).toBe('zh-TW');
  });
});
