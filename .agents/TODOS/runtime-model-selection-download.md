# Runtime model selection/download TODO

- [x] Bind model options and installations to the canonical v2 contract set.
  Done: `GET /v2/runtime/model-options` and model installations in the v2 contract set.
- [x] Add runtime-owned allowlist, active-selection persistence, and post-pull
      digest/size verification.
  Done: allowlist and selection in `capture_runtime/model_catalog.py`.
- [x] Verify the v2 model-option and installation routes alongside generic
      runtime requirement setup.
  Done: runtime route tests alongside requirement setup.
- [x] Make the Workbench Tauri bridge and Angular setup flow select and consent
      to a model before capture structuring is enabled.
  Done: model selection in the Workbench desktop workspace store and installation service.
- [x] Remove the fixed standalone 4B environment/profile from launch policy.
  Done: no fixed 4B profile remains in `capture_runtime/config.py`.
- [ ] Prove fresh app data performs no model pull before selection.
- [ ] Prove real 0.8B local test selection completes OCR and Audio E2E; do not
      commit or publish private fixtures or model bytes.
- [x] Freeze candidate catalog metadata and run fresh producer/consumer gates
      before tag-last release.
  Done: 0.4.2 consumer gates and promotion (runs 36329045296, 36329671186).
