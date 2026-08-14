# Modular Runtime and Host Release TODO

Only active release work remains here; completed migration history is kept out
of the working TODO.

- [ ] Build one exact-source candidate containing the v2 runtime asset, Python,
      TypeScript, and Java SDK artifacts, and record the shared contract-set
      SHA-256 in each manifest/lockfile.
- [ ] Publish the matching Windows runtime executable and manifest, then run
      engine-bearing OCR/Whisper smoke with cleanup evidence.
- [ ] Complete Cert Prep, Law Prep, and Capture Workbench consumer gates against
      that same immutable candidate, including clean installation/import probes.
- [ ] Verify the release ledger, route/manifest parity, generated-artifact
      checks, and contract discovery digest before promotion.
