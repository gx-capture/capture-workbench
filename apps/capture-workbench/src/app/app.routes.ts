import type { Routes } from '@angular/router';
import { HistoryPage } from './history/history-page';
import { PlaceholderPage } from './placeholder/placeholder-page';

/** The shell's pages; OCR is the home page (.agents/PLANS/workbench-ocr-asr-ux.md §2). */
export const appRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'ocr' },
  { path: 'ocr', component: PlaceholderPage, data: { page: 'ocr' } },
  { path: 'asr', component: PlaceholderPage, data: { page: 'asr' } },
  { path: 'history', component: HistoryPage },
  { path: 'settings', component: PlaceholderPage, data: { page: 'settings' } },
  { path: '**', redirectTo: 'ocr' },
];
