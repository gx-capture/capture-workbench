import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatCard } from '@angular/material/card';
import { MatDivider } from '@angular/material/divider';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatSpinner } from '@angular/material/progress-spinner';
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
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  protected readonly store = inject(DesktopWorkspaceStore);
  protected readonly sourceInput = viewChild.required<ElementRef<HTMLInputElement>>('sourceInput');

  ngOnInit(): void {
    void this.store.initialize();
  }

  protected addFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files) void this.store.addFiles(input.files);
    input.value = '';
  }

  protected openFilePicker(): void {
    this.sourceInput().nativeElement.click();
  }

  protected dropFiles(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer?.files) void this.store.addFiles(event.dataTransfer.files);
  }
}
