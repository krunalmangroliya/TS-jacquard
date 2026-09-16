# Loom Clean

A separate local web application for preparing Jacquard artwork: **PNG → output read/pick and size → source-guided pixel cleanup → canvas color finishing → indexed BMP**. No account, cloud upload or AI service is required. The existing JDM application is independent of this folder.

## Open

On this PC double-click **Start-Loom-Clean.cmd**. The app opens at **http://127.0.0.1:4328**. The launcher builds and serves the production app with its local cleanup service. It reopens an existing Loom Clean server when available; otherwise keep its terminal open while working. Closing that terminal stops a server started by the launcher.

This checkout uses the existing parent `node_modules`, and the launcher also finds the Codex-bundled Node runtime when Node is not on the normal Windows PATH. For a standalone copy, install Node.js 22.12+ and run `npm install` inside this folder first.

```sh
npm start
npm run test
npm run build
```

Inside this existing workspace, the equivalent checks without npm are `node ../node_modules/typescript/bin/tsc --noEmit`, `node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --configLoader runner`, and `node ../node_modules/vite/bin/vite.js build --configLoader runner`.

The four native-service integration tests are opt-in: start the production studio with no cleanup running, set `LOOM_NATIVE_SMOKE=1` in the test process environment, and run the test command. Default unit tests do not need a running server.

`npm run dev` is available for editing the code. Use the launcher or `npm start` for design work: the largest sample caused a renderer crash in the development server during local testing, while the production build completed the same cleanup and export successfully. The production build still needs the source folder and Node dependencies for its local worker and sample library.

## Workflow

1. Upload a PNG or uncompressed BMP, or open **Local sample library**. The library scans this project's `sample` folder for source PNG / sized BMP pairs. It reads Read/Pick from filenames, including spaced notation such as `r 200 p 76`, and takes exact output dimensions from the sized BMP header. Completed files supply no cleanup pixels. Exact source colors are retained up to 256. Images above 256 colors require an explicit import-reduction choice. Transparent PNG pixels are placed over white. The PNG decoder preserves raw RGB samples rather than applying a screen color profile.
2. Enter **Read / Pick as effective output pixels per inch**, and choose finished size in inches/cm or exact output width/height. A loom's reed-count notation is not universally identical to pixels per inch. Source DPI is a suggested physical-size starting point, not a verified machine setting. The sample's 2400 × 5700 at approximately 300 DPI gives 8 × 19 inches; R96/P52 therefore gives 768 × 988 pixels. To match a 768 × 992 final grid, use explicit pixel dimensions. The app does not invent the extra four rows.
3. Select cleanup strength, grainy-shading cleanup and the actual primary outline ink. The suggestion uses luminance among recurring inks, so two accidental black pixels do not displace the real outline. It remains a suggestion. Optional protected palette colors cannot be removed or expanded by automatic cleanup. Enable wrapped edges only for a repeating tile, not an ordinary whole pallu panel. Check source orientation when the supplied sized layout is rotated; size alone cannot recover hidden layout edits.
4. Run **Clean artwork**. A worker measures source-pixel support, proposes bounded component cleanup and verifies short outline connections against the original. Sources above 24 million pixels or outputs above 4 million pixels use a separate local Node worker through the launcher; smaller jobs use a browser worker. Both run the same cleanup engine. The original stays intact. Cancellation terminates the active worker.
5. Compare **Sized original**, **Cleaned**, and **Changes**. Green marks added line pixels; magenta marks automatic speck/texture changes; cyan marks subsequent canvas edits. Zoom to individual pixels. A bounded overview and visible detail tiles keep large artwork from creating a full-size RGBA preview. The overview is smoothed below 100% zoom; 100% and larger use exact pixel display. **Cloth proportions** changes only the display aspect ratio using read/pick, never the exported grid.
6. Select a palette color, then **Fill connected region**, **One-pixel pencil**, or **Eyedropper**. A region fill uses four-neighbor connectivity; **Replace all occurrences** is an explicit global replacement. Add colors up to 256. Undo/redo retains up to 16 image states, including palette changes.
7. **Export BMP** saves a local copy under **output/exports/** and requests a browser download of the current edited image as an uncompressed 8-bit indexed BMP, with separate horizontal and vertical pixel-density metadata. PNG export is also available. The export endpoint runs on this local machine, not an external service. Palette indices are internal to this app; assign/confirm weaves in NedGraphics after import.
8. **New output** retains the original source and resets the output/editor. Changing settings then reprocessing always starts from that original, never an already-cleaned output.

Work is kept in the current browser tab's memory. Export the result before closing or replacing it. There is no account or autosave. Finished exports are retained in this project's **output/exports/** folder; the additional browser download location is controlled by the browser. When hosted as static files elsewhere, export falls back to a browser download without a local project copy. Large-image cleanup requires the local launcher because a static host has no Node cleanup endpoint.

## Cleanup approach

The engine is implemented in this project and does not import the existing JDM cleanup pipeline. It starts with an exact center-nearest baseline and source-area support. A second noise pass detects fields containing many tiny four-connected fragments: this catches grain that forms one large diagonal network and escaped the first version. Frozen regional evidence gates bounded palette-component voting while compact motifs, coherent strokes, ring centers and protected inks receive conservative treatment. Texture cleanup is explicit because decorative stippling can resemble unwanted specks.

Line repair now considers every ink, with the selected primary outline given priority. Facing endpoints nominate short connections; an exact path is traced through the original PNG and its actual course is projected onto the output grid. Source gradient coherence rejects isotropic grain connections. Protected colors, small holes and competing strokes veto repairs. Balanced mode allows up to three added cells per path; strong allows four. Each stage reads a frozen input, and repairs cannot seed further repairs in that stage. Original source gaps without a supporting path remain unchanged. Enlarging either axis disables line reconstruction.

No pretrained or trained neural network runs in this version. This is image processing, not a generative redraw. MobileSAM, SAM 2.1 Tiny and Florence-2 were researched, not executed; their region masks do not establish correct one-pixel repairs. The local research note is in `output/model-research.md`. Repeated-edge connectivity is supported; automatic discovery/copying of repeated interior motifs is not implemented. A future learned candidate classifier needs reviewed aligned labels, validation with entire design IDs held out, and evidence that it improves corrections over this baseline.

The engine does not assign weaves, check floats or produce machine files. Those steps remain in NedGraphics. Successful BMP parsing here does not substitute for a real NedGraphics import check.

## Limits and evaluation

- Input: up to 8192 pixels per side, 40 million pixels, 110 MB. PNG: non-interlaced 8-bit RGB/RGBA/gray, or 1/2/4/8-bit indexed/grayscale. Interlaced and 16-bit PNGs need to be saved in a supported format. BMP: uncompressed 1/4/8/24/32-bit, up to 256 distinct colors.
- Output: up to 8192 pixels per side and 8 million pixels total. These limits include the supplied 32.8-megapixel source and 5.5-megapixel target. Detail smaller than the output grid cannot always be retained. Strong cleanup needs closer inspection.
- Run `npm run evaluate` for this PC's supplied sample paths, or pass `--source`, `--sized`, and `--reference` paths. Reports and visual comparisons are written under `output/evaluation/`.
- `scripts/analyze-samples.ts` inventories all local triples and records orientation, palette and alignment issues under `output/sample-analysis/`. `scripts/engine-v1.ts` is the frozen first-version benchmark, never imported by the web app. V2 comparison artifacts are separate so the old result can be inspected honestly.
- Run `node ../node_modules/tsx/dist/cli.mjs scripts/evaluate-v2.ts --full` after the inventory to compare the ten PNG inputs and ten sized inputs against the frozen first version. The report checks dimensions, palette preservation, unchanged inputs and BMP round trips. `output/sample-analysis/v2-full-review.html` shows source-sized input, V1, V2 and the contextual completed reference side by side.
- The supplied completed sample is 768 × 992 and contains intentional recoloring and structural edits. It is contextual reference, not an aligned pixel-perfect label for the 768 × 988 sized image. Reports do not call singleton reduction accuracy or claim measured labor savings.
- Unit checks cover source-supported repairs, real gaps, protected colors, dot/hole preservation, edge connectivity, image import/export, deterministic processing and local/global editor operations. Real designer review and timed NedGraphics corrections on additional designs remain necessary to measure production quality.

User-supplied sample assets and generated reports stay local and are ignored by Git. The app itself does not send artwork to an external service.
