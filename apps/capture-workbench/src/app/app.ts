import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { desktopMessages, type ShellRoute } from './i18n/desktop-messages';
import { DesktopWorkspaceStore } from './services/desktop-workspace.store';

const SHELL_ROUTES: readonly ShellRoute[] = [
  'ocr',
  'asr',
  'history',
  'settings',
];

/**
 * The app shell: a fixed left navigation, the runtime status, and the routed
 * page. It starts the workspace store once, so every page and the status dot
 * share one runtime connection.
 */
@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(DesktopWorkspaceStore);
  protected readonly m = desktopMessages;
  protected readonly navItems = computed(() =>
    SHELL_ROUTES.map((route) => ({ route, label: this.m().nav[route] })),
  );

  constructor() {
    this.store.initialize();
  }
}
