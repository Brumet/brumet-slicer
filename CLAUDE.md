# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Brumet Slicer is a Windows Electron desktop app (in Spanish) that lets a 3D-printing
business quote print jobs: the user drags in an STL/OBJ/3MF, the app slices it silently
with a bundled BambuStudio CLI, and computes a price from filament + energy + machine
wear + labor costs, then exports a branded PDF/CSV quote. It's a commercial product for
a single client (Brumet, Bogotá) — not an open-source library — so changes should
preserve exact pricing/business logic unless asked to change it.

## Commands

```bash
npm install         # install deps
npm start            # run the app in dev (electron .)
npm run build         # electron-builder --win (unsigned local build)
npm run publish       # electron-builder --win --publish always (builds + uploads to GitHub Releases)
npm run codigos       # node generar-codigos.js (license code generator — NOT in this repo, see below)
```

There is no test suite, linter, or CI configured in this repo — verify changes by running
`npm start` and exercising the flow manually (see Architecture below for what to click).

**Dev-only requirement:** a `BambuStudio/` folder containing `bambu-studio.exe` must sit at
the project root (see `slicer-bambu.js` `BAMBU_EXE` resolution). It's gitignored for size —
without it, slicing will fail but the UI still loads.

## Architecture

This is a plain Electron app with **no bundler/build step for source** — `main.js`,
`index.html`, `viewer.html`, and `slicer-bambu.js` are loaded as-is (`nodeIntegration: true`,
`contextIsolation: false` for the main/viewer windows), and business logic lives directly
inline in `<script>` tags in the HTML files rather than in separate modules. When editing UI
logic, go straight to the relevant `<script>` block in `index.html` or `viewer.html`.

### Process split

- **`main.js`** — Electron main process. Owns all IPC handlers, the BrowserWindows
  (`mainWin` + a separate `viewerWin`), error logging to disk + Discord webhook reporting,
  the auto-updater (`electron-updater`, checks GitHub Releases), settings/history
  persistence (JSON files under `app.getPath('userData')`), and PDF/CSV export (PDF is
  built as an HTML string in `buildPDFHTML()` and rendered off-screen via
  `printToPDF`).
- **`index.html`** — the main window: file drop zone, filament/printer selection, price
  calculation and results UI, settings modal (password-gated), license/trial screen,
  quote history, PDF/CSV/WhatsApp export.
- **`viewer.html`** — a *second* BrowserWindow with a Three.js 3D viewer for
  previewing/transforming a model (move/rotate/scale) before quoting. Talks back to
  `main.js`/`index.html` purely through IPC (`slice-from-viewer`, `sync-file`, `load-stl`,
  `open-stl-dialog`) — there's no direct reference between the two renderer contexts.
- **`slicer-bambu.js`** — the slicing engine. Wraps the bundled BambuStudio CLI
  (`bambu-studio.exe --slice 1 --outputdir ...`) as a child process and parses its
  `result.json` output for time/filament-weight per plate.

### Slicing pipeline (the core, non-obvious flow)

STL/OBJ files are **not** sliced directly — BambuStudio needs a `.3mf` project. So
`slicer-bambu.js` takes a printer-specific `.3mf` template from `perfiles/` (e.g.
`elevador_config.3mf` for the Bambu A1, referenced via `PLANTILLAS_IMPRESORA`), unzips it
with `adm-zip`, swaps in a freshly generated `3D/Objects/object_1.model` XML built from the
parsed STL/OBJ geometry, patches the item transform and `Metadata/plate_1.json` bbox for
positioning, and re-zips it as a temp `.3mf` before invoking the CLI. If the input is
already `.3mf`, it's passed straight through untouched (it already has its own config).

Key details to preserve if touching this path:
- **Unit auto-detection** (`calcularEscala`): bbox max < 1 → assume meters (×1000);
  < 10 → assume centimeters (×10); otherwise millimeters. This exact rule is duplicated
  in the 3D viewer's own scale logic — if the two diverge, the app quotes a different size
  than what the user sees on screen (there's a comment in the code referencing a real past
  bug from this).
- **Mesh repair** (`repararMalla`): welds duplicate vertices and fills small open-edge
  holes before handing geometry to BambuStudio, mimicking BambuStudio's own "repair"
  button — needed because many client STLs are non-manifold "triangle soup".
- **Bed-size guard**: rejects (with a user-facing message) any model whose transformed
  bbox exceeds 256mm on any axis, instead of letting BambuStudio silently mis-slice it.
- **Multi-plate 3MF**: a `.3mf` can contain multiple plates; results are aggregated per
  plate (`camasData`) and also summed into top-level `tiempo`/`gramos`/`horas` fields for
  backward compatibility with single-plate UI code.
- When the viewer has applied a transform, the transformed STL (baked via `exportSTLBinary`
  in `viewer.html` and written to a temp file) is what gets sliced — passing the original
  file path instead would quote the wrong (untransformed) size.

### Pricing formula

```
costo = filamento + energía + desgaste_máquina + operario + espacio + fijos
precio = costo × markup   (markup defaults to 2.0×, i.e. 100% margin)
```

Implemented in `calcularPrecio()` in `index.html`. All the cost inputs (energy rate,
machine wear/lifetime, labor/hour, workspace/hour, fixed costs, filament tiers, markup)
live in a settings object persisted via `main.js`'s `load-settings`/`save-settings` IPC
handlers, with `DEFAULT_CFG` in `main.js` as the schema/fallback. A separate bulk-quantity
discount (`descuentoPorCantidad`) is applied on top, per line, and is intentionally kept
outside the per-unit formula.

### Settings access control

The settings modal is gated by a password check done client-side in `index.html`
(`checkPassword()`, comparing SHA-256 hashes) with two tiers: a full-access password
(all cost parameters) and a lower-privilege one (branding-only: logo, name, contact,
color). Don't lower this bar or expose the plaintext comparisons — this protects the
business owner's cost data from being edited by whoever is at the machine.

### Licensing

Trial/license state lives in `index.html`, not `main.js`: a local JSON file under
`AppData/Roaming/Brumet Slicer/license.json` tracks a 30-day trial or a 183-day licensed
period. Activation codes are validated against SHA-256 hashes in `licenses.json` (loaded
via the `load-license-hashes` IPC handler) — the code generator that produces those hashes
(`generar-codigos.js`) is deliberately excluded from git (see `.gitignore`) and requires a
master key that isn't in this repo.

### Error reporting

`main.js` logs errors to a rotating local file (`logs/brumet.log` under userData, capped
at 512KB with one backup) and also POSTs them to a Discord webhook for real-time
monitoring, rate-limited to 1 message/minute. The webhook URL lives in `webhook.json`,
which is gitignored (repo is public; a leaked webhook URL would need to be invalidated)
but *is* packaged into the built app via electron-builder's `files` list. Every successful
quote is also reported to the same webhook (`log-cotizacion`) to help catch suspicious
quotes, and approved orders (`aprobar-cotizacion`) are sent with the model file zipped as
an attachment (capped at Discord's 10MB limit).

### Packaging

`package.json`'s `build` config (electron-builder) packages `perfiles/` and
`BambuStudio/` as `extraResources` (outside the ASAR), with the BambuStudio bundle
filtered down to just what's needed at runtime (drops plugins, resource i18n/fonts/models/
etc. to shrink the installer). `slicer-bambu.js` and `main.js` resolve paths differently
for dev (`__dirname/...`) vs. packaged (`process.resourcesPath/...`) — keep both branches
in sync when adding new bundled resources.

## Conventions

- Code, comments, UI strings, and commit-worthy user-facing text are in **Spanish**
  (the client and its customers are Colombian) — match this when editing existing files.
  Currency formatting uses `es-CO` locale and Colombian pesos (COP).
- No module bundler, no TypeScript, no framework — plain `<script>` tags and CommonJS
  `require()` in the renderer (enabled by `nodeIntegration: true`). Don't introduce a
  build step or import system without discussing it first.
- Only `Bambu A1` currently has a real profile in `perfiles/`; `PLANTILLAS_IMPRESORA` in
  `slicer-bambu.js` also lists P1S/X1C templates that don't exist yet and safely fall back
  to the A1 default (`getPlantilla`) — adding real support for another printer means
  dropping a new `..._config.3mf` template into `perfiles/`.
