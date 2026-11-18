// The packaged app's WebView page, as the desktop smokes find it.

const PACKAGED_ORIGIN = 'http://tauri.localhost';

/** Whether a WebView2 target URL is the packaged app, on any of its pages. */
export function isPackagedWorkbenchUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).origin === PACKAGED_ORIGIN;
}
