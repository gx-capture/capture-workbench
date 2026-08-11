# Decision: feature-gated model-smoke fixture injection

Status: accepted for local model-smoke verification only.

Raw Win32 control automation was rejected because modern rfd/COM dialogs were
not consistently represented as a new owned or modal UIA window. Activating an
exact Tauri HWND still reproduced that failure in a picker-only test. Relaxing
selection to pre-existing Explorer windows is unsafe.

An arbitrary-path Tauri command was also rejected because it would make the
WebView a native filesystem authority. A renderer-only test hook was rejected
because it would bypass native source admission and remain present in ordinary
product bundles.

The selected design compiles one command only under `model-smoke-app-data`.
The launcher predeclares fixed opaque keys and native-only paths under its
owned run root. The command resolves a key, validates root ownership and file
policy, then calls the existing native import implementation. The normal UI
retry path starts real runtime processing. Evidence must explicitly identify
this as a deterministic picker bypass, not native-picker coverage.
