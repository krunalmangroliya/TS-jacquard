# 2026-09-12 — first local JDM product

## User decisions

The owner requested the complete product, with improvements to follow, and explicitly chose a local application on this PC. Prior decisions remain: no more than six colors; source-width strokes visible by default; manual stroke hiding/restoration; minor detail loss can be acceptable when reducing output size. The original spec remains reference material and was not rewritten.

## Delivered workflow

- React/Vite studio and loopback Fastify API with atomic filesystem storage.
- PNG import, crop/threshold/detail review, visible source-width vector trace and unassigned faces.
- Master/size editor: fill, edge visibility/style, nodes/handles, pen/line, erase, object grouping/transforms, palette editing/merge and undo/redo.
- Separate machine-sized variants, pixel corrections, cleanup/protected colors and direct indexed BMP/PNG/report export.
- Searchable library, duplicate, archive/restore, disk autosave, browser recovery, second-tab locks, retained versions and comparisons.
- Explicit rebase preview with conflict reporting and stale-preview protection.
- Windows startup shortcut, local data documentation and repeatable product/recovery test harnesses.

## Evidence

The real customer PNG and its original imported master were preserved. A copy was used to hide edge e27588, retaining its 4.125 source-unit width, autosave, create version 2, compare with version 1 and create a 1200 × 1431 size. The UI exported a 1,718,278-byte 8-bit BMP using indices 0–5. Both BMP/PNG hashes matched the stored export sidecar. The original master still showed the edge. The server was stopped and successfully started hidden by the launcher; saved records and versions remained available.

Automated checks: 153 unit/integration tests; 70 unchanged golden comparisons; 12 controller recovery/race checks; 11 real Fastify/browser product scenarios with zero browser errors, including ten exact exported pixel corrections, stale rebase edits, and archive/restore. TypeScript and production build pass. Prior core browser verification matched 30 synthetic BMPs byte-for-byte with Node.

Reproduce browser product checks with `pnpm test:product` and recovery checks with `pnpm test:recovery`. These use isolated storage and fresh test browser contexts. Reports and inspected screenshots are in `output/product-smoke/`, `output/hook-robustness-result.json` and `output/local-app/customer-export-check.json`.

## What this session does not establish

The default loom profile and current customer sample colors remain placeholders. The app still needs real NedGraphics verification, designer feedback and measured cleanup savings. Dense-panel opening/full renders can take several seconds. Per-edge source widths approximate internal taper; subpixel details may disappear. Half-drop/brick seam editing, dirty-area rendering and nearest-node rebase recovery are future improvements. Browser undo history is bounded and session-local; retained versions are on disk. Forced termination during unfinished undo/redo may recover the last completed state.
