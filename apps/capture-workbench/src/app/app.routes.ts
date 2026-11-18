import type { Routes } from '@angular/router';
import { AsrPage } from './asr/asr-page';
import { HistoryListPage } from './history/history-list-page';
import { OcrPage } from './ocr/ocr-page';
import { ResultContentPage } from './result/result-content-page';
import { ResultDetailsPage } from './result/result-details-page';
import { ResultExportPage } from './result/result-export-page';
import { ResultPage } from './result/result-page';
import { ResultSpeakersPage } from './result/result-speakers-page';
import { ComputePage } from './settings/compute-page';
import { DiagnosticsPage } from './settings/diagnostics-page';
import { EnginesPage } from './settings/engines-page';
import { GeneralPage } from './settings/general-page';
import { SettingsPage } from './settings/settings-page';

/** The shell's pages; OCR is the home page (.agents/PLANS/workbench-ocr-asr-ux.md §2). */
export const appRoutes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'ocr' },
  { path: 'ocr', component: OcrPage },
  { path: 'asr', component: AsrPage },
  { path: 'history', component: HistoryListPage },
  {
    path: 'history/:id',
    component: ResultPage,
    children: [
      { path: '', pathMatch: 'full', redirectTo: ({ queryParams }) => {
        const from = queryParams['from'] === 'history' ? '?from=history' : '';
        return `content${from}`;
      } },
      { path: 'content', component: ResultContentPage },
      { path: 'speakers', component: ResultSpeakersPage },
      { path: 'export', component: ResultExportPage },
      { path: 'details', component: ResultDetailsPage },
    ],
  },
  {
    path: 'settings',
    component: SettingsPage,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'engines' },
      { path: 'engines', component: EnginesPage },
      { path: 'compute', component: ComputePage },
      { path: 'general', component: GeneralPage },
      { path: 'diagnostics', component: DiagnosticsPage },
    ],
  },
  { path: '**', redirectTo: 'ocr' },
];
