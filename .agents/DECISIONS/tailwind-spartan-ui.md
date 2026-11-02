# Tailwind and Spartan UI decisions

2026-11-02 — user accepted §6 Q1 of `.agents/PLANS/workbench-ocr-asr-ux.md`.
This supersedes the Angular Material line of `standalone-desktop-product.md`.

- The desktop renderer (`apps/capture-workbench`) styles new UI with Tailwind 4
  utilities on semantic tokens (`--background`, `--primary`, `--sidebar`, …)
  defined once in `src/styles.css`, plus Spartan helm components. Components
  add no per-component stylesheet of their own.
- Helm components are copied into the app by the Spartan CLI, not shared with
  other repositories: `components.json` points the CLI at
  `apps/capture-workbench/src/app/ui`, in its Angular CLI layout
  (`<primitive>/src/index.ts`, `src/lib/hlm-*.ts`), which matches LAW's
  `libs/ui`. Add one with
  `pnpm nx g @spartan-ng/cli:ui <primitive> --angularCli=true --installPeerDependencies=false`.
  The CLI adds the `@spartan-ng/helm/<primitive>` path alias; the root ESLint
  config allows those aliases inside the app, and Sheriff tags the folders
  `shell:ui`.
- Generate a primitive only when a page uses it. Exports nobody calls (such as
  the CLI's `provide…Config()` helpers) are deleted rather than baselined, as
  the dead-code gate requires.
- Tailwind's preflight and utilities live in CSS layers, so the unlayered
  Material theme and the workspace's own stylesheet keep winning while
  Material remains on `/history`. That workspace was written against browser
  defaults, so `styles.css` reverts preflight inside `app-history-page`
  (`all: revert-layer`, `line-height: normal`); a page built with helm
  components must not be nested there. Phase 7 of the plan deletes that rule,
  Material, `history-page.css` and the prebuilt theme.
- Tailwind scans only `src/app/**/*.{html,ts}` (`source(none)` plus `@source`),
  so packages and tooling never add classes to the bundle.
- PR CI does not run `capture-workbench:build:production`, whose 10 kB
  `anyComponentStyle` budget fails only there. Every UI PR runs it locally.
