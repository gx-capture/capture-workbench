# Web Component follow-up

- [x] Migrate all executable and test `.mjs` scripts to Node 24-native `.ts`
      while keeping ESLint flat configuration on its supported `.mjs` loader.
      Verify: `pnpm nx run capture-workbench-desktop:package-qa-test`

- [x] Add a custom-element wrapper without changing `CaptureDocumentV1`.
      Verify: `pnpm nx run capture-angular:test`
- [x] Define `config` attribute/property serialization and stable DOM
      `CustomEvent` names; keep clients and providers property-only.
      Verify: `pnpm nx run capture-angular:test`
- [x] Add a framework-neutral consumer fixture and CDN loading example.
      Verify: `pnpm nx run capture-angular:clean-consumer-smoke`
- [x] Document CSP, authentication, styling tokens, and version compatibility.
      Verify: `pnpm nx run capture-angular:clean-consumer-smoke`

- [ ] After `@gx/capture-angular` is publicly published, load the CDN fixture
      from its final URL in a browser and record the result.
