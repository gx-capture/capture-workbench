import {
  ChangeDetectionStrategy,
  Component,
  inject,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatCard } from '@angular/material/card';
import { MatDivider } from '@angular/material/divider';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatSpinner } from '@angular/material/progress-spinner';
import { CaptureRuntimeComputeStatusComponent } from '@gx-capture/capture-workbench-ui';
import {
  DESKTOP_LOCALES,
  DESKTOP_MESSAGES,
  desktopLocale,
  desktopMessages,
  setDesktopLocale,
  type DesktopLocale,
} from './i18n/desktop-messages';
import { DesktopWorkspaceStore } from './services/desktop-workspace.store';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [
    MatButton,
    MatCard,
    MatDivider,
    MatFormField,
    MatInput,
    MatLabel,
    MatOption,
    MatSelect,
    MatSpinner,
    CaptureRuntimeComputeStatusComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(DesktopWorkspaceStore);
  protected readonly m = desktopMessages;
  protected readonly locale = desktopLocale;
  protected readonly locales = DESKTOP_LOCALES;

  constructor() {
    this.store.initialize();
  }

  protected setLocale(locale: DesktopLocale): void {
    setDesktopLocale(locale);
  }

  protected languageName(locale: DesktopLocale): string {
    return DESKTOP_MESSAGES[locale].languageName;
  }

  protected openFilePicker(): void {
    this.store.chooseSources();
  }

  protected partialFor(documentId: string) {
    return this.store.partialFor?.(documentId) ?? null;
  }
}
