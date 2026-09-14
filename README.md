# JDM — Jacquard Design Master

A local design studio for tracing textile line art, coloring a reusable vector master with **up to six colors**, and exporting indexed BMPs at the loom's actual hook/pick density.

## Open the app

On this Windows PC, double-click **[Start-JDM.cmd](Start-JDM.cmd)**. It opens **http://127.0.0.1:4317** and reuses an existing JDM server when available. After the first setup, normal use does not need an internet connection.

For manual startup, use Node.js 22.12+ and pnpm:

```sh
pnpm install
pnpm build
pnpm start
```

Keep `pnpm start` running while using the app. For development with hot reload, run `pnpm dev` in a second terminal and open the displayed Vite URL. The launcher builds changed sources when starting a stopped app. During development, rebuild and restart after server changes.

## Design workflow

1. **New master** → choose **Black & White line art** or **Black & Gold artwork** → upload a PNG → adjust crop, threshold and detail → review the trace → **Create master**. Black-and-white regions start unassigned, with visible strokes at their estimated source width. Gold mode extracts the artwork from its dark ground and creates editable filled contours, preserving solid gold shapes and their fine dark cuts without adding an extra outline.
2. Choose a palette color, then **Fill (K)** a region. **Select (V)** a stroke to hide or restore its ink while preserving region boundaries. **Delete boundary** deliberately changes the topology.
3. Use objects, nodes, handles, pen and line for repairs. Node/handle drags update the connected curves and nearby fills immediately on the canvas. Successive edits can continue while exact regions and pixels finish in a separate background worker. Save/export waits for the latest completed result. The right panel includes palette editing/merging and object grouping, duplication, transforms, visibility and locking.
4. **Create size** → choose a machine profile → enter hooks/picks, inches, cm, or repeats across. The size keeps its own vector edits, cleanup settings and pixel corrections. Editing the master leaves existing sizes unchanged.
5. In size mode, inspect the final pixel grid, cleanup overlay and warnings. Use **Pixel pencil (B)** for final corrections, then **Export BMP**. PNG and a JSON report are also kept in export history.
6. Autosave keeps the current draft. **Save version** keeps a named checkpoint; History can compare or restore it. A size can explicitly **Review update from current master** before keeping a rebase.

Library supports name/tag search, duplicate, archive/restore, and reopening a downloaded master JSON. **Download master JSON** contains editable geometry; the export JSON sidecar is a report, not a complete design backup.

Shortcuts: `V` select, `A` nodes, `P` pen, `L` line, `K`/`G` fill, `E` erase edge, `B` pixel pencil, `Z` zoom. `Space` + drag pans; mouse wheel zooms; `Ctrl+0` fits; `Ctrl+1` shows actual pixels. `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo; `Ctrl+S` saves a version; `Ctrl+E` exports a size. `0`–`5` choose colors. Delete hides a selected stroke, or deletes the selected node in node mode. Pen/line uses Enter to finish and Escape to cancel; Alt-click a fill picks its color.

## Saved data and recovery

Everything stays in **`data/jdm/`**: workspace settings, designs, sources, thumbnails, retained versions and exports. Finish saving/exporting, close the editor tabs, then double-click **[Stop-JDM.cmd](Stop-JDM.cmd)** before backing up this entire folder. The stop shortcut verifies the server belongs to this workspace and leaves other processes alone. Replacing it with a backup restores the workspace; keep a separate copy before replacing anything. This folder and generated output are excluded from Git.

The browser also keeps a recovery draft before submitting an edit to the worker. Reopening the same design in the same browser restores unsaved work when its saved revision still matches. Conflicting drafts are retained for download and never silently substituted for newer saved work. Closing while an edit is pending may display the browser's leave-page prompt. Undo history lasts for the open editor session, up to 100 edits / 64 MB; saved versions survive restarts.

A second browser tab opens an already locked design as read-only. The server binds only to `127.0.0.1`; this edition is for one PC, with no account setup. See [ADR 004](docs/adr/004-local-product.md).

## Trial sample and current limits

The supplied floral panel is already in this PC's library. Its existing colors are **test placeholders** from the earlier trial. New black-and-white drawings remain unassigned for designer coloring; gold artwork starts with black ground and gold fills. Original files in `sample-input/` are unchanged. Gold **Balanced** limits contour simplification to one source pixel; **Keep fine detail** uses a smaller tolerance and more nodes.

The default **2400 hooks / 60 EPI / 48 PPI** profile is an example; replace its numbers in Settings before assessing production dimensions. Strokes scale with the design and retain an estimated width per edge. Width variation within one edge is approximated; tiny strokes/details can disappear on small grids. Hiding a stroke and merging a palette color are separate operations.

This is a **local trial app**. Dense panels still take several seconds to trace, open or finish exact pixel processing. The interactive canvas uses a local visual deformation during node/handle/object drags; the final worker result is authoritative. Large object transforms and duplication can still require processing after release. Tracing needs inspection; automatic gap repair is off by default and disabled for filled gold artwork. Straight repeat and panel modes are supported; half-drop/brick seam editing and nearest-node recovery during rebase remain future improvements. Conflicting rebase operations are listed for review.

Actual NedGraphics color/index handling and cleanup-time savings still need designer validation. Weave assignment, punching and loom-file generation remain in NedGraphics. The app makes no AI API calls.

## Verification and CLI

```sh
pnpm typecheck
pnpm test
pnpm eval
pnpm eval --browser
pnpm eval --editor
pnpm test:product
pnpm test:recovery
pnpm exec tsx scripts/test-editor-latency.ts
pnpm exec tsx scripts/test-gold-import.ts --contours
```

The shared TypeScript core runs in browser workers and Node. The synthetic golden suite compares geometry snapshots and BMP/PNG bytes at three sizes. The browser check compares BMP bytes with Node. These establish regression consistency, not woven appearance or measured cleanup savings. See [current status](docs/STATUS.md).

The earlier CLI and static stroke inspector remain available:

```sh
pnpm sample
pnpm jdm trace sample-input/design.png --out output/master.json
pnpm jdm render output/master.json --profile configs/example-machine.json --width-px 1200 --out output/design.bmp
pnpm jdm inspect output/master.json --width-px 1200 --out output/editor
pnpm jdm --help
```

`sample-input/*.jdm.json` files preserve reviewed import parameters for CLI sample runs. The supplied panel uses threshold 157, no automatic gap joins, panel mode, and 300/1200/2400-hook outputs. Generated reference art and provenance remain in [eval/references](eval/references/README.md).

The original [specification](JDM_SPEC_v1.md) remains unchanged; the user's later six-color, visible-stroke and local-app decisions are recorded in [ADR 003](docs/adr/003-visible-source-strokes.md) and [ADR 004](docs/adr/004-local-product.md).
