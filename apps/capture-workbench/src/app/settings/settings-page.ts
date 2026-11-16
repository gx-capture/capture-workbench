import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { desktopMessages } from '../i18n/desktop-messages';

interface SettingsNavItem {
  readonly route: string;
  readonly testId: string;
  readonly label: string;
}

@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.html',
  imports: [HlmButtonImports, RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  protected readonly m = desktopMessages;
  protected readonly navItems = computed<readonly SettingsNavItem[]>(() => {
    const messages = this.m();
    return [
      {
        route: 'engines',
        testId: 'settings-nav-engines',
        label: messages.settingsEnginesTitle,
      },
      {
        route: 'compute',
        testId: 'settings-nav-compute',
        label: messages.settingsComputeTitle,
      },
      {
        route: 'general',
        testId: 'settings-nav-general',
        label: messages.settingsGeneralTitle,
      },
      {
        route: 'diagnostics',
        testId: 'settings-nav-diagnostics',
        label: messages.settingsDiagnosticsTitle,
      },
    ];
  });
}
