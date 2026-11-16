import type { Routes } from '@angular/router';
import { AsrPage } from './asr/asr-page';
import { HistoryPage } from './history/history-page';
import { OcrPage } from './ocr/ocr-page';
import { ResultContentPage } from './result/result-content-page';
import { ResultDetailsPage } from './result/result-details-page';
import { ResultPage } from './result/result-page';
import { ResultSpeakersPage } from './result/result-speakers-page';
import { EnginesPage } from './settings/engines-page';

/** The shell's pages; OCR is the home page (.agents/PLANS/workbench-ocr-asr-ux.md §2). */
export const appRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'ocr' },
  { path: 'ocr', component: OcrPage },
  { path: 'asr', component: AsrPage },
  { path: 'history', component: HistoryPage },
  {
    path: 'history/:id',
    component: ResultPage,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'content' },
      { path: 'content', component: ResultContentPage },
      { path: 'speakers', component: ResultSpeakersPage },
      { path: 'details', component: ResultDetailsPage },
    ],
  },
  { path: 'settings', pathMatch: 'full', redirectTo: 'settings/engines' },
  { path: 'settings/engines', component: EnginesPage },
  { path: '**', redirectTo: 'ocr' },
];
