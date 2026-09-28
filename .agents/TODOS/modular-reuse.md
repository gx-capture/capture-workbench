# Modular Runtime and Host Release TODO

Only active release work remains here; completed migration history is kept out
of the working TODO.

- [x] Build one exact-source candidate containing the v2 runtime asset, Python,
      TypeScript, and Java SDK artifacts, and record the shared contract-set
      SHA-256 in each manifest/lockfile.
  Done: 0.4.1/0.4.2 candidates record the contract-set SHA-256 in every manifest.
- [x] Publish the matching Windows runtime executable and manifest, then run
      engine-bearing OCR/Whisper smoke with cleanup evidence.
  Done: 0.4.2 runtime executable, manifest, and OCR/Whisper engine zips on GitHub release `v0.4.2`.
- [x] Complete Cert Prep, Law Prep, and Capture Workbench consumer gates against
      that same immutable candidate, including clean installation/import probes.
  Done: consumer gates run 36329045296 (Cert Prep and LAW) against release candidate `a1b8234f…`.
- [x] Verify the release ledger, route/manifest parity, generated-artifact
      checks, and contract discovery digest before promotion.
  Done: release promotion run 36329671186 (registry verification, release ledger, promotion ledger).
