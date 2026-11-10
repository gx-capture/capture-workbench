# Open work

Work is tracked in GitHub issues of `gx-capture/capture-workbench`
(Cert Prep and LAW items carry the `cross-repo` label). Release state
and procedure: [release-runbook.md](../GUIDES/release-runbook.md).

## Tracked in issues

- Workbench UI redesign around OCR and ASR, epic
  [#152](https://github.com/gx-capture/capture-workbench/issues/152): phases
  [#157](https://github.com/gx-capture/capture-workbench/issues/157) (OCR page),
  [#158](https://github.com/gx-capture/capture-workbench/issues/158) (ASR page),
  [#159](https://github.com/gx-capture/capture-workbench/issues/159) (result view and editing),
  [#160](https://github.com/gx-capture/capture-workbench/issues/160) (history table and export),
  [#161](https://github.com/gx-capture/capture-workbench/issues/161) (diagnostics; remove Angular Material),
  [#162](https://github.com/gx-capture/capture-workbench/issues/162) (Web Component sizes from the runtime),
  [#163](https://github.com/gx-capture/capture-workbench/issues/163) (packaged real OCR/ASR run, pixel baselines).
- Runtime items: speech recognition as a CUDA unit and a CPU-only mini unit
  [#154](https://github.com/gx-capture/capture-workbench/issues/154);
  recordings over 50 MiB by native path
  [#155](https://github.com/gx-capture/capture-workbench/issues/155);
  cross-process lock for the shared download cache
  [#185](https://github.com/gx-capture/capture-workbench/issues/185).
- DDD refactor, epic [#169](https://github.com/gx-capture/capture-workbench/issues/169):
  W5–W9 [#173](https://github.com/gx-capture/capture-workbench/issues/173)–[#177](https://github.com/gx-capture/capture-workbench/issues/177);
  real-input comparison after W2–W4
  [#240](https://github.com/gx-capture/capture-workbench/issues/240).
- TypeScript client spec files are not type-checked
  [#230](https://github.com/gx-capture/capture-workbench/issues/230).

- Runtime and OCR:
  restart reconciliation and host migration to the R3 lifecycle ("Option W",
  a decision for the user) [#246](https://github.com/gx-capture/capture-workbench/issues/246);
  iGPU selection test and installed proof [#247](https://github.com/gx-capture/capture-workbench/issues/247);
  vertical Japanese reader follow-ups (detector licence, DirectML evidence,
  furigana review) [#248](https://github.com/gx-capture/capture-workbench/issues/248);
  handwriting OCR quality [#250](https://github.com/gx-capture/capture-workbench/issues/250);
  model selection and isolated Ollama proofs [#251](https://github.com/gx-capture/capture-workbench/issues/251);
  late-bind race on the isolated Ollama port [#255](https://github.com/gx-capture/capture-workbench/issues/255).
- Workbench UI: playback of formats WebView2 cannot play [#249](https://github.com/gx-capture/capture-workbench/issues/249);
  engine uninstall in settings [#254](https://github.com/gx-capture/capture-workbench/issues/254).
- Maintenance: release version literals in tests (Capture, LAW, Cert Prep)
  [#253](https://github.com/gx-capture/capture-workbench/issues/253).

[recording-transcription.md](recording-transcription.md) keeps the pointers
that issue #155 links to.
