// The packaged app's WebView page, as the desktop smokes find and drive it.
// The app opens on its OCR page; the document workspace (source import,
// document cards, detail) that the smokes drive lives on the history page.
import type { Page } from '@playwright/test';
import { concatMap, defer, from, of, type Observable } from 'rxjs';

const PACKAGED_ORIGIN = 'http://tauri.localhost';
const HISTORY_PATH = '/history';

/** Whether a WebView2 target URL is the packaged app, on any of its pages. */
export function isPackagedWorkbenchUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).origin === PACKAGED_ORIGIN;
}

/**
 * The same navigation as {@link showHistoryWorkspace}, for a CDP
 * `Runtime.evaluate` expression: clicks the history link unless the page is
 * already there. The workspace renders after the expression returns, so
 * callers poll.
 */
export const SHOW_HISTORY_WORKSPACE_EXPRESSION = `if (location.pathname !== '${HISTORY_PATH}') {
  document.querySelector('[data-testid="nav-history"]')?.click();
}`;

/** Opens the history page from the left navigation, unless it is already shown. */
export function showHistoryWorkspace(page: Page): Observable<void> {
  return defer(() =>
    new URL(page.url()).pathname === HISTORY_PATH
      ? of(undefined)
      : from(page.getByTestId('nav-history').click()).pipe(
          concatMap(() =>
            from(
              page.getByTestId('workbench-root').waitFor({ state: 'attached' }),
            ),
          ),
        ),
  );
}
