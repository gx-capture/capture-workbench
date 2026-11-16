import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HlmCardImports } from '@spartan-ng/helm/card';
import {
  DESKTOP_LOCALES,
  desktopLanguageName,
  desktopLocale,
  desktopMessages,
  setDesktopLocale,
  type DesktopLocale,
} from '../i18n/desktop-messages';

@Component({
  selector: 'app-general-page',
  templateUrl: './general-page.html',
  imports: [HlmCardImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneralPage {
  protected readonly m = desktopMessages;
  protected readonly locale = desktopLocale;
  protected readonly locales = DESKTOP_LOCALES;

  protected languageName(locale: DesktopLocale): string {
    return desktopLanguageName(locale);
  }

  protected setLocale(locale: DesktopLocale): void {
    setDesktopLocale(locale);
  }
}
