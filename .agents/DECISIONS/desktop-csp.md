# Desktop content security policy

Status: decided 2026-11-16 (product owner). The policy is `app.security.csp` and
`devCsp` in `apps/capture-workbench-desktop/src-tauri/tauri.conf.json`.

## Decision

The desktop app keeps a strict CSP. A desktop window has no cross-site
attackers, but a script that runs in it can call the application's commands
(read imported sources, import by path, delete documents, install engines), and
the app renders content it does not control: recognized text, transcripts, file
names, model output, and PDFs parsed by pdf.js. The CSP is the layer that holds
when escaping or a library fails.

`base-uri` is `'self'`, not `'none'`. `'none'` disables the `<base href="/">`
that Angular writes into `index.html`, so a direct load or a reload of a nested
route (`/settings/engines`, `/history/<id>/content`) resolved scripts and
styles under that route and showed a blank page
([#385](https://github.com/gx-capture/capture-workbench/issues/385)). With
`script-src 'self'` a foreign base could not load a script anyway; `'self'`
still refuses a base outside the app.

## What each directive is for

| Directive | Why it stays |
| --- | --- |
| `default-src 'self'` | Anything not listed below comes from the app only. |
| `script-src 'self'` | No inline script and no `eval`: injected content cannot run, and a parser bug that needs `eval` (pdf.js has had one) is blocked. pdf.js therefore runs with `useWasm: false`; there is no `wasm-unsafe-eval`. |
| `connect-src`, `img-src`, `media-src` | The window cannot send data out or load remote media. This is what backs "the recording does not leave this computer" at the window level. |
| `worker-src 'self' blob:` | The pdf.js worker is a bundled asset. |
| `style-src 'self' 'unsafe-inline'` | Angular component styles. |
| `base-uri 'self'` | See the decision above. |
| `object-src`, `frame-src`, `frame-ancestors`, `form-action` `'none'` | Cost nothing; nothing in the app needs them. |

## How it is checked

The browser e2e (`apps/capture-workbench-e2e`) has a second Playwright project,
`chromium-desktop-csp`: the whole reference flow runs against the production
build served with this policy as a response header
(`desktop-csp-server.ts`), including a direct load of a nested route and the
PDF page images. The packaged app (WebView2) is checked in the installed
acceptance.

## Open

`connect-src` allows `http://127.0.0.1:*`. The desktop renderer makes no direct
HTTP, WebSocket or EventSource call (it uses the application's commands), so
the entry may be removable from `csp`; not verified, and `devCsp` may still
need it.
