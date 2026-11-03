import type { Routes } from '@angular/router';
import { AsrPage } from './asr/asr-page';
import { HistoryPage } from './history/history-page';
import { OcrPage } from './ocr/ocr-page';
import { EnginesPage } from './settings/engines-page';

/** The shell's pages; OCR is the home page (.agents/PLANS/workbench-ocr-asr-ux.md §2). */
export const appRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'ocr' },
  { path: 'ocr', component: OcrPage },
  { path: 'asr', component: AsrPage },
  { path: 'history', component: HistoryPage },
  { path: 'settings', pathMatch: 'full', redirectTo: 'settings/engines' },
  { path: 'settings/engines', component: EnginesPage },
  { path: '**', redirectTo: 'ocr' },
];
