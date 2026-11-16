// The packaged app's WebView page, as the desktop smokes find and drive it.
// The app opens on its OCR page; the document workspace (source import,
// document cards, detail) that the smokes drive lives on /workspace.
import type { Page } from '@playwright/test';
import { concatMap, defer, from, of, type Observable } from 'rxjs';

const PACKAGED_ORIGIN = 'http://tauri.localhost';
const HISTORY_PATH = '/workspace';

/** Whether a WebView2 target URL is the packaged app, on any of its pages. */
export function isPackagedWorkbenchUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).origin === PACKAGED_ORIGIN;
}

/**
 * The same navigation as {@link showHistoryWorkspace}, for a CDP
 * `Runtime.evaluate` expression: pushes `/workspace` to history and dispatches
 * `popstate` unless the page is already there. The workspace renders after the
 * expression returns, so callers poll.
 */
export const SHOW_HISTORY_WORKSPACE_EXPRESSION = `if (location.pathname !== '${HISTORY_PATH}') {
  history.pushState(null, '', '${HISTORY_PATH}');
  dispatchEvent(new Event('popstate'));
}`;

/** Opens the legacy workspace directly by updating the browser history. */
export function showHistoryWorkspace(page: Page): Observable<void> {
  return defer(() =>
    new URL(page.url()).pathname === HISTORY_PATH
      ? of(undefined)
      : from(
          page.evaluate((path) => {
            history.pushState(null, '', path);
            dispatchEvent(new Event('popstate'));
          }, HISTORY_PATH),
        ).pipe(
          concatMap(() =>
            from(
              page.getByTestId('workbench-root').waitFor({ state: 'attached' }),
            ),
          ),
        ),
  );
}
