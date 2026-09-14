# Local product status

The first complete local trial app is implemented: React editor, PNG import and trace review, six-color coloring, manual source-stroke hide/restore, node/handle/path tools, object editing, independent size variants, pixel corrections, indexed exports, searchable library, filesystem autosave, browser recovery, retained versions and explicit rebase review.

The owner explicitly selected use on this Windows PC. The loopback app and local filesystem storage replace the original studio server, Postgres and login deployment for this edition. Original production acceptance targets have not been declared passed. See [ADR 004](adr/004-local-product.md).

## Open and use

- Double-click `Start-JDM.cmd`, or run `pnpm build` then `pnpm start`.
- URL: http://127.0.0.1:4317
- Data: `data/jdm/`; original sample PNGs remain unchanged.
- Supplied sample: **Sample 1 · floral panel**, with six placeholder test colors. A separate trial copy and 1200-hook size were used to check editing/export without changing that master.
- Gold sample: **Sample 1 GB · Black & Gold**, traced from the full supplied PNG, is also in the library. Upload explicitly offers Black & White or Black & Gold. Mode is retained with the master; workspace palette settings remain unchanged. See [ADR 005](adr/005-gold-input.md).
- Black-and-white strokes start visible with a measured width per edge. Gold uses filled contours with no extra outline, retaining solid ink and fine dark engraving. Hiding a stroke retains its geometry, fills and width. A palette merge changes colors; boundary deletion changes region topology.

## Verified

- 201 unit/integration tests across the shared core and local server pass, including deferred geometry commits, sparse patches and history across face merges.
- 70 golden comparisons remain unchanged. Prior browser core checks matched all 30 synthetic BMPs with Node byte-for-byte.
- 13 browser controller checks pass for successive rapid node edits, pending-edit saves, writes during save, recovery failure/retry, ordered draft clearing, worker failure, unmount cleanup and separate tab locks. Reproduce with `pnpm test:recovery`.
- All 11 scenarios in the reusable real product smoke pass. It uses a fresh scratch build, an actual Fastify server and isolated data, with a real browser worker. It covers import/fill, save/reload, retained versions and restore, read-only second tab, size creation, pixel corrections, indexed BMP bytes, palette merge/undo and rebase review. Reproduce with `pnpm test:product`; its report is `output/product-smoke/report.json`.
- The actual customer sample was opened in the app, stroke `e27588` hidden, autosaved and versioned, compared with its original version, and made into a separate 1200 × 1431 size. Its BMP is 8-bit indexed with indices 0–5; BMP/PNG checksums match the stored export report. Source width 4.125 and the untouched original master were verified. Evidence: `output/local-app/customer-export-check.json`.
- The Windows launcher started the server hidden from a stopped state, and the saved library survived the restart. It also reuses a healthy server without replacing other processes.
- The entire 3072 × 4096 Gold PNG passed real browser import, review invalidation, save and editor opening; its stored source bytes match the original. Balanced tracing produces 180,939 nodes / 7,781 closed boundaries with 95.95% intersection-over-union against extracted gold ink. Metallic shading is reduced to one gold color. Evidence: `output/gb-import/ui-full-report.json`, `contour-report.json`, and `seeded-design.json`.
- Node, handle, drawing and deletion commits defer exact face/pixel processing to a cancellable nested worker. Stroke, fill and palette previews also update independently of the pixel result. A save barrier waits for the latest result while permitting subsequent quick edits. `scripts/test-editor-latency.ts` verifies the real dense worker, consecutive edits, save, undo and redo.
- Worker replies contain sparse geometry patches; unchanged model objects stay shared. Optimistic node patches use a small incident graph, with large table copies split into yielding tasks. Full IndexedDB recovery snapshots are written by the editor worker, and save barriers no longer send a redundant full graph to the UI.
- Production browser tests exercised three consecutive drags through the actual hook, nested workers, IndexedDB and isolated Fastify storage. All three saved on both samples. During drag/release, RAF p95 was 16.8 ms, with maxima of 50 ms (B/W) and 66.8 ms (Gold), and no gaps over 100 ms. The pointer-to-second-frame proxy p95 was 43.6 / 38.2 ms. Exact settlement/save after dragging took 9.45 / 10.39 seconds and still showed later UI gaps up to 316.6 / 550 ms. These are local browser measurements, not physical display scanout. Evidence: `output/canvas-integration/report.json` and `output/canvas-integration-gold/report.json`.

## Remaining validation and improvements

- Enter actual machine hooks/EPI/PPI and yarn palette values, then validate BMPs in the designer's NedGraphics installation.
- Measure cleanup time/pixels against Photoshop with a representative set of real designs. The original 80% reduction target is not yet measured.
- Dense panels still need several seconds for opening or exact rerenders. During dragging, the canvas deforms local curves and adjacent fills over a cached viewport; this visual preview is temporary and exports use the exact result. Large object transforms/duplication still process after release to preserve moved fill references.
- Temporary drag previews can show different crossing-stroke order, and exceptionally wide strokes at extreme zoom can leave outer fragments until the exact raster replaces the preview. These do not affect saved geometry or exported pixels.
- Very small strokes and minor details can fall below the output grid. Source-width variation within a single edge is approximated. Tracing and gap repair still need review.
- Straight repeat and panel modes are supported. Half-drop/brick seam editing is pending.
- Rebase replays by IDs and face references and reports skipped operations. Nearest-node recovery and conflict-location editing need improvement. Adoption checks whether the draft changed after the preview was created.
- Undo is bounded to 100 edits / 64 MB and lasts for the editor session. Versions are retained on disk. A forced browser/process kill during unfinished undo/redo can recover the last completed state; normal edits are written as pending before dispatch. A crash that skips lock release may leave a read-only lock until its five-minute expiry.
- Accounts, remote studio access, weave assignment and loom punching are outside this local edition.

The earlier CLI reports, generated reference image, source-stroke inspector and sessions remain available under `output/`, `eval/references/` and `docs/sessions/`. The original specification file has not been rewritten.
