// The packaged app's WebView page, as the desktop smokes find it and move it
// between routes. The app opens on its OCR page.
import type { Page } from '@playwright/test';
import { defer, from, map, of, type Observable } from 'rxjs';

const PACKAGED_ORIGIN = 'http://tauri.localhost';

/** Whether a WebView2 target URL is the packaged app, on any of its pages. */
export function isPackagedWorkbenchUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).origin === PACKAGED_ORIGIN;
}

/**
 * Puts the packaged app on a route by pushing the path to the browser history
 * and dispatching `popstate`, without locating any element. The route renders
 * after this completes, so callers wait for what they need.
 */
export function navigatePackagedRoute(page: Page, targetPath: string): Observable<void> {
  if (!targetPath.startsWith('/')) {
    throw new Error(`Packaged route path must start with '/': ${targetPath}`);
  }
  return defer(() => {
    const currentUrl = page.url();
    if (URL.canParse(currentUrl) && new URL(currentUrl).pathname === targetPath) {
      return of(undefined);
    }
    return from(
      page.evaluate((routePath) => {
        if (location.pathname !== routePath) {
          history.pushState(null, '', routePath);
          dispatchEvent(new Event('popstate'));
        }
      }, targetPath),
    ).pipe(map(() => undefined));
  });
}
