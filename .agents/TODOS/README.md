# Open work

Ordered by priority. Each line links to the TODO that holds the detail and
evidence rules. Release state and procedure: [release-runbook.md](../GUIDES/release-runbook.md).

## Next release

- Ship the blank-region OCR fix and PDF page progress, then rerun the online
  PDF OCR e2e against the new release — [pdf-ocr-only-extraction.md](pdf-ocr-only-extraction.md)

## Runtime and OCR

- Usable iGPU selection when the dGPU is positively unavailable, plus the
  `acceptance-real-ocr-gpu-selection` target — [capture-runtime-042-p2-hardening.md](capture-runtime-042-p2-hardening.md)
- PDF page-1 leg in Capture Workbench and with the original private PDF —
  [capture-runtime-042-p1-ocr-and-lifecycle.md](capture-runtime-042-p1-ocr-and-lifecycle.md)
- Real Whisper and isolated Ollama proofs — [capture-runtime-installer-size-reduction.md](capture-runtime-installer-size-reduction.md)
- Model selection proofs: no model pull before selection; 0.8B OCR and audio
  E2E — [runtime-model-selection-download.md](runtime-model-selection-download.md)
- Handwriting OCR quality (disclosed 0.4.2 limitation) needs a separate
  recognizer evaluation.
- Vertical Japanese text: recognized in the wrong column order with more
  errors (N1 PDF page 16). Evaluate `useTextlineOrientation` or a
  vertical-aware recognizer; either changes the OCR profile identity, so it
  ships as a release decision — [pdf-ocr-only-extraction.md](pdf-ocr-only-extraction.md)

## Maintenance

- Rustdoc for the remaining public `capture-sidecar-launcher` functions —
  [capture-large-file-refactor.md](capture-large-file-refactor.md)
