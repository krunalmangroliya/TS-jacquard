# JDM — Jacquard Design Master
## Technical Specification v1.0 (written for an AI coding agent)

Working name: **JDM**. Rename freely; keep the internal package names stable.

---

## 0. How to use this document (read first)

- Sections 1–4 explain the domain and the user. Read them fully before writing code; most bugs in this project will come from misunderstanding jacquard constraints, not from TypeScript.
- Section 5–7 are the architecture, data model and algorithms. **These decisions are final unless marked `[OPEN]`.** If you believe a decision is wrong, stop and ask the owner with a concrete alternative; do not silently deviate.
- Section 8 is the UI. The UI must stay small. Do not add tools, panels, modals or settings that are not listed here without asking.
- Section 9 defines tests and the eval harness. **No change to the core (trace / topology / render / export) is complete until the golden tests pass byte-identically or the snapshots are explicitly updated with a note.**
- Section 10 is the build order. Build M0 first, end to end, on the command line, before any UI.
- Appendix A is the prompt the owner gives to an external AI image model. The app itself makes **no AI API calls** in v1.
- Appendix C lists placeholders (e.g. machine numbers) the owner must fill in. Use the placeholder values for defaults and tests until replaced.

Conventions in this document: `[P1]` = must have for v1, `[P2]` = build after M2 if time allows, `[OPEN]` = decision not yet made, ask.

---

## 1. Product summary

### 1.1 The problem
Textile designers in Surat (India) create designs for electronic jacquard looms (sarees: body, border, pallu, daman). Today:

1. They hand-draw a sketch on paper.
2. They trace it in Photoshop with the pen tool, fill flat colors, and save at 300 DPI.
3. They open that raster in NedGraphics, set the loom "DPI" (ends per inch × picks per inch), and the downscale produces broken lines, stray pixels and mixed colors that must be cleaned **pixel by pixel**. This cleanup is the single biggest time cost.
4. They assign weaves and generate the loom file ("punching") in NedGraphics.
5. They keep the 300 DPI file so the same motif can be reused at other sizes — which restarts the cleanup every time.

### 1.2 What JDM does
JDM replaces steps 2–3 and the reuse problem:

- Input: a **clean line-art PNG** (black lines on white) of one **repeat unit**, produced outside the app by an AI image model from the designer's sketch (Appendix A). Photoshop is removed from the workflow.
- JDM traces the PNG into a **vector master**: a planar map of edges (editable curves with nodes) and faces (the enclosed regions), each face carrying one palette color (palette index = one yarn/weave in NedGraphics).
- From one master, the designer generates **any size** for any loom profile. JDM renders the vector directly onto the loom grid (width in hooks, height in picks, non-square pixels) with no anti-aliasing, a locked palette, and deterministic cleanup rules. Output: 8-bit indexed BMP that opens in NedGraphics with **near-zero manual pixel cleanup**.
- Small edits are done in JDM with a deliberately small tool set (select/move objects, move nodes, pen, line, fill, erase edge), either on the master or on a specific size. Edits on a size are vector edits, re-rendered through the same rules, so they stay clean. A tiny pixel-override layer exists for the last one or two pixels.
- Masters and sizes are versioned and stored in a searchable library.

### 1.3 Non-goals (v1)
- No weave assignment, no punching, no loom file formats (JC5/EP). NedGraphics keeps that job. JDM outputs BMP only.
- No saree layout / assembly of body + border + pallu. JDM works on one repeat unit at a time; repeating and assembly happen in NedGraphics.
- No AI API calls inside the app. The designer runs the cleanup prompt themselves and uploads the result.
- No general-purpose vector illustration features (gradients, text, effects, blend modes, layers as in Photoshop).
- No real-time multi-user editing of the same document.

### 1.4 Success criteria
- On the golden set of 10 real designs, at three sizes each, the number of pixels a designer still changes by hand after JDM's export is **≤ 20 %** of what they change today after a Photoshop downscale, and the wall-clock time per size is ≤ 20 %.
- Exports open in NedGraphics with exactly the intended number of colors and correct dimensions, first try.
- A designer who knows Photoshop is productive in JDM within one hour without a manual.

---

## 2. Users, context, UX principles

- Users: professional jacquard designers. They use Photoshop and NedGraphics daily. They are not beginners, but they will not read documentation. English UI labels are fine (Photoshop is in English for them). Tooltips may later be localized to Gujarati `[P2]`.
- They think in **hooks and picks** (loom pixels) and in **inches/cm**. Both must be first-class everywhere a size appears.
- They care about the **final pixels**. The vector is the means; the pixel grid is the truth. In size mode the pixel result is always visible under the vector overlay.
- UX principles (enforce these when in doubt):
  1. One editor, two modes (Master / Size). Same tools, same shortcuts.
  2. At most 9 tools in the toolbar. No nested menus. No modal dialogs except destructive confirmations.
  3. Photoshop shortcuts where a Photoshop equivalent exists (Section 8.5).
  4. Everything is undoable. Autosave always. Nothing is lost by closing the tab.
  5. Warnings, not blockers: the app highlights problems (gaps, unassigned faces, sizes that don't divide the hook count) and offers a one-click fix, but never refuses to export (it warns).
  6. Defaults that work: a designer should be able to import → fill colors → generate size → export without opening a settings panel other than choosing a machine profile.

---

## 3. End-to-end workflow

```
Paper sketch
   │  (photo / scan)
   ▼
External AI image model (Nano Banana 2 or similar) with Prompt A (Appendix A)
   │  clean line-art PNG, black on white, 2K–4K, one repeat unit
   ▼
JDM: Import ─► Trace review (threshold, simplify) ─► Master v1 (edges + faces, all faces unassigned)
   │
   ▼
Master mode: Fill faces with palette colors, close gaps, optional object moves / node fixes ─► Save version
   │
   ▼
Size mode: choose machine profile, enter size (inch/cm or hooks × picks) ─► render ─► warnings
   │
   ├─► optional vector edits on this size (objects, nodes), optional pixel overrides
   ▼
Export: 8-bit indexed BMP (+ PNG + JSON sidecar) ─► NedGraphics (repeat, weaves, punching)
```

The designer returns to the same master for every new size, and to the same size variant for re-exports.

---

## 4. Glossary (domain terms the code must use consistently)

| Term | Meaning | Code name |
|---|---|---|
| Hook / end | One warp thread position. Design width in pixels = number of hooks used. | `hooks`, `widthPx` |
| Pick | One weft insertion. Design height in pixels = number of picks. | `picks`, `heightPx` |
| EPI | Ends (hooks) per inch → horizontal pixel density. | `epi` |
| PPI | Picks per inch → vertical pixel density. Usually ≠ EPI, so loom pixels are **not square**. | `ppi` |
| Machine profile | Named loom configuration: hooks, EPI, PPI. | `MachineProfile` |
| Repeat unit | The rectangle that NedGraphics will tile. One master = one repeat unit. | `Master.bounds` |
| Design units | Master coordinate space. 1 unit = 1 pixel of the source PNG (square). Origin top-left, y down. | `du` |
| Output pixels | Pixels of a generated size (loom grid). | `px` |
| Node | An editable point on an edge (anchor with optional bezier handles). | `Node` |
| Edge | A curve between two nodes, made of cubic bezier segments. Edges are region boundaries. Width 0 = invisible boundary (default). Width > 0 = a visible outline drawn in a palette color. | `Edge` |
| Face | A region enclosed by edges (derived from the planar map). Each face has one palette index or is unassigned. | `Face` |
| Ground | The outer face (everything not enclosed). Default palette index 0. | `groundFace` |
| Palette | Up to 16 entries; index = one yarn/weave in NedGraphics. Index 0 = ground by convention. Colors are for display only; the loom only sees indices. | `Palette` |
| Object | A group of edges (usually one motif: a flower, a keri/paisley, a leaf). Selecting and moving works on objects. | `DesignObject` |
| Master | The size-independent vector design + palette + objects + version history. | `Master` |
| Size variant | A master rendered for one machine profile at one size, with its own edits (an operation log on top of a master version), rules, pixel overrides and exports. | `SizeVariant` |
| Pixel override | A manual pixel value applied after rendering and rules. Last resort. | `PixelOverride` |
| Rules | Deterministic cleanup passes applied to the rendered grid. | `RuleConfig` |
| Golden set | 10 real designs used for regression and acceptance. | `/eval/golden` |

---

## 5. Architecture and tech stack

### 5.1 Decisions (final)
- **TypeScript everywhere.** One `core` package with zero DOM/Node dependencies runs unchanged in a browser Web Worker and in Node on the server. This guarantees the pixel preview in the browser and the exported file are byte-identical. Do not implement any rendering, tracing or topology in Python or a second language. Hot paths may move to Rust/Wasm later behind the same interfaces `[P2]`, only after M2 is accepted.
- **Web app** (React + Vite) served from the owner's server. Packaged desktop build (Tauri) is `[P2]`.
- **No vector-editor framework.** Do not build on Paper.js/Fabric/Konva; they cannot represent shared-edge planar maps. Small focused libraries are allowed: `bezier-js` (curve math), `simplify-js` (Douglas–Peucker), `flatbush` (spatial index), `pngjs`/`upng` (PNG), `zod` (schemas), `ulid`. Everything else is written in `core`.
- **Determinism is a feature.** Same inputs → same output bytes, on every machine, every time. Coordinates are snapped to fixed-point (1/64 du) on every commit; topology runs on integers scaled by 64. Never use `Math.random`, `Date`, locale or platform-dependent APIs inside `core`. IDs created inside `core` (nodes, edges, faces from trace/topology) are deterministic (content hash of the snapped geometry, or a sequence number within the run); ULIDs are only generated by the server/UI for documents, files and ops.
- **Operation log + snapshots.** Every edit is an operation (command). Undo/redo, size-variant deltas, version history and replay all use the same operation model (Section 7.8).

### 5.2 Monorepo layout (pnpm workspaces)
```
jdm/
  packages/core/          pure TS: geometry, trace, topology, render, rules, bmp, ops, schemas
  packages/eval/          CLI harness: run golden set, metrics, snapshot compare
  apps/web/               React + Vite; canvas; workers; editor UI
  apps/server/            Node + Fastify: auth, workspaces, files, export, versions (Postgres + local FS or S3-compatible storage)
  eval/golden/            10 real PNGs + expected outputs (checked in, LFS)
  docs/                   this spec, ADRs
```

### 5.3 Runtime shape
- Browser: UI thread only draws; all core work (trace, topology, render, rules) runs in a Web Worker via a typed message protocol. Transferable `ArrayBuffer`s for rasters.
- Server: same `core` for export; stores documents as JSON (versioned), rasters as PNG/BMP files. Postgres for metadata and search. Single workspace per studio, multiple logins, roles `admin` / `designer`.
- Concurrency: a document opened for editing is soft-locked (shows "being edited by X"); a second user gets read-only. `[P1]` simple lock with 5-minute heartbeat.

---

## 6. Data model

All persisted documents are JSON validated with `zod` schemas in `core/schemas`. Document/file/op IDs are ULIDs; geometry IDs produced by `core` are deterministic (Section 5.1). All numbers are finite. Coordinates in `du` unless stated.

```ts
// ---------- Workspace ----------
interface Workspace {
  id: string; name: string;
  machineProfiles: MachineProfile[];
  defaultPalette: Palette;                 // seeded on new masters
}

interface MachineProfile {
  id: string; name: string;                // e.g. "Staubli 2400 – Body"
  hooks: number;                           // total hooks available (integer > 0)
  epi: number;                             // ends per inch  (number > 0)
  ppi: number;                             // picks per inch (number > 0)
  notes?: string;
}

// ---------- Palette ----------
interface Palette { entries: PaletteEntry[] }          // length 1..16, indices 0..15 contiguous
interface PaletteEntry {
  index: number;                           // 0..15, 0 = ground
  name: string;                            // "Ground", "Zari", "Red weft" …
  displayRgb: [number, number, number];    // shown in the editor
  exportRgb: [number, number, number];     // written into BMP palette (defaults to displayRgb)
}

// ---------- Geometry (shared by Master and SizeVariant) ----------
interface Vec2 { x: number; y: number }

interface Node {
  id: string;
  p: Vec2;                                 // anchor position
  kind: 'corner' | 'smooth';               // smooth = handles kept collinear
}

interface BezierSegment {                  // cubic; endpoints are the nodes of the edge
  c1?: Vec2; c2?: Vec2;                    // absent → straight line between the surrounding anchors
}

interface Edge {
  id: string;
  nodeIds: string[];                       // ordered chain of ≥ 2 nodes; interior nodes are editable too
  segments: BezierSegment[];               // length = nodeIds.length - 1
  width: number;                           // in OUTPUT pixels; 0 = invisible boundary (default)
  colorIndex?: number;                     // required when width > 0
  z: number;                               // draw order among visible edges (higher on top)
}

interface Geometry {
  nodes: Record<string, Node>;
  edges: Record<string, Edge>;
  // Faces are DERIVED from edges by the topology engine (Section 7.2). Their colors are persisted here:
  faceColors: Record<string, FaceColor>;   // key = faceId (stable across commits via face tracking)
}

interface FaceColor {
  colorIndex: number | null;               // null = unassigned (shown as placeholder tint, exports as 0 with a warning)
  ref: Vec2;                               // a point deep inside the face at the time of assignment (pole of inaccessibility);
                                           // used to re-resolve the face if ids change (replay, tracking fallback)
}

interface DesignObject {
  id: string; name: string;                // "Object 3", renamable
  edgeIds: string[];
  locked: boolean; hidden: boolean;
}

// ---------- Master ----------
interface Master {
  id: string; workspaceId: string;
  name: string; tags: string[];
  createdAt: string; updatedAt: string;    // ISO strings, set by server only
  bounds: { w: number; h: number };        // repeat unit size in du (= source PNG size unless cropped at import)
  repeat: { type: 'straight' | 'half-drop' | 'brick' };
  palette: Palette;
  geometry: Geometry;
  objects: DesignObject[];
  source: { fileId: string; widthPx: number; heightPx: number; crop?: { x: number; y: number; w: number; h: number } };
  traceParams: TraceParams;                // what produced geometry v1 (for reproducibility)
  version: number;                         // increments on "Save version"
  thumbnailFileId?: string;
}

// ---------- Size variant ----------
type SizeInput =
  | { mode: 'physical'; unit: 'in' | 'cm'; width?: number; height?: number; linkAspect: boolean }
  | { mode: 'grid'; widthPx?: number; heightPx?: number; linkAspect: boolean }
  | { mode: 'fitAcross'; n: number };      // widthPx = floor(profile.hooks / n), height from aspect

interface SizeVariant {
  id: string; masterId: string; name: string;
  base: { masterVersion: number };         // master snapshot this variant was generated from
  profileId: string;
  sizeInput: SizeInput;
  widthPx: number; heightPx: number;       // resolved output grid (integers > 0)
  ops: Operation[];                        // edits applied on top of the base master snapshot (Section 7.8)
  rules: RuleConfig;
  pixelOverrides: PixelOverride[];         // applied last
  exports: ExportRecord[];
  version: number;
}

interface PixelOverride { x: number; y: number; colorIndex: number }   // output px coords

interface RuleConfig {
  minRegionPx: number;                     // default 4; 0 disables
  minThicknessPx: number;                  // default 0 (off); 2 recommended for small sizes
  removeCheckerboard: boolean;             // default true
  connectVisibleEdges4: boolean;           // default true (fill diagonal steps in visible edges so lines are 4-connected)
}

interface ExportRecord {
  id: string; createdAt: string; fileIdBmp: string; fileIdPng: string; fileIdJson: string;
  masterVersion: number; variantVersion: number; rulesUsed: RuleConfig; widthPx: number; heightPx: number;
  changedPixelsByRule: Record<string, number>;
}

// ---------- Versions ----------
interface VersionSnapshot<T> { docId: string; version: number; note: string; createdAt: string; by: string; doc: T }
```

Invariants (enforce in `core/validate.ts`, run before every save and in tests):
- Every `Edge.nodeIds[i]` exists; `segments.length === nodeIds.length - 1`; an edge has no repeated consecutive node.
- `Edge.width > 0 ⇒ colorIndex` defined and present in palette.
- Palette indices are `0..n-1` contiguous, `n ≤ 16`, index 0 exists.
- Every `DesignObject.edgeIds` entry exists; every edge belongs to exactly one object (the importer guarantees this; edits maintain it; a new edge drawn with the pen joins the object it connects to, else becomes a new object).
- `bounds.w, bounds.h ≥ 8` du. Node coordinates may lie outside bounds (they wrap in repeat mode, Section 7.9).
- `PixelOverride` coordinates within `[0, widthPx) × [0, heightPx)`.

---

## 7. Core algorithms (`packages/core`)

All functions are pure, synchronous, deterministic, and take plain data in / plain data out so they run in a worker and on the server.

### 7.1 Import and trace (`core/trace`)

Input: PNG (RGB/RGBA/gray), expected black lines on white, 1000–4096 px on the long side. Output: `Geometry` (nodes + edges, no colors), `DesignObject[]`, and `TraceReport`.

```ts
interface TraceParams {
  threshold: number | 'otsu';     // gray → binary; default 'otsu'; UI slider 0..255
  invert: boolean;                // true when lines are light on dark
  minSpeckArea: number;           // px, default = 0.0001 × imageArea (min 4)
  gapClosePx: number;             // default = 0.002 × longSide (≈ 8 px at 4K)
  spurPrunePx: number;            // default = 2 × lineWidthEstimate
  simplifyTolerance: number;      // Douglas–Peucker, du, default 1.0
  fitMaxError: number;            // bezier fit, du, default 1.5
  cornerAngleDeg: number;         // split into corner node when direction changes ≥ this, default 60
}
```

Pipeline (each step is a separate tested function):

1. **Binarize.** Convert to luminance. Threshold (Otsu by default). Optional invert. Result: `Uint8Array` 1 = line.
2. **Despeckle.** Remove line components with area < `minSpeckArea` (8-connected). Remove white holes < `minSpeckArea` inside lines (fills pinholes).
3. **Estimate line width.** Distance transform on line pixels; `lineWidthEstimate = 2 × median(distance of skeleton pixels)`. Report it.
4. **Skeletonize.** Zhang–Suen thinning to 1-px centerlines. (Do not use contour tracing: an outline drawn as a filled black stroke must become **one** centerline edge, never an inner + outer contour.)
5. **Graph extraction.** Classify skeleton pixels: endpoint (1 neighbor), junction (≥ 3 neighbors after junction clustering — merge adjacent junction pixels into one junction node), path pixel (2). Walk paths between junction/endpoints → polylines. Closed loops without junctions get one node at the topmost-leftmost pixel.
6. **Prune spurs.** Delete paths that end at an endpoint and are shorter than `spurPrunePx`; repeat until stable; re-cluster junctions.
7. **Auto-close gaps.** For each remaining endpoint: find the nearest point on any other path (or endpoint) within `gapClosePx`; connect with a straight segment if the endpoint's tangent points roughly toward it (angle ≤ 45°). Prefer endpoint–endpoint pairs. Record each auto-closed gap in the report so the UI can show them. Endpoints that remain become **gap warnings**.
8. **Simplify.** Douglas–Peucker per polyline with `simplifyTolerance`.
9. **Corner detection.** Mark polyline vertices where the turning angle ≥ `cornerAngleDeg` as corner nodes; junctions and endpoints are always nodes.
10. **Bezier fit.** Between consecutive corner/junction nodes fit cubic beziers (Schneider's algorithm, `fitMaxError`), splitting where needed; each split point becomes a smooth node. Target: a typical petal outline yields 4–8 nodes. Report `nodesPer1000du`.
11. **Snap.** Snap all coordinates to 1/64 du.
12. **Objects.** Connected components of the edge graph (edges sharing nodes) → one `DesignObject` each, named "Object 1..n" in reading order (top-left first).
13. **Topology + placeholder colors.** Run Section 7.2. All faces except ground get `colorIndex: null` with a deterministic placeholder tint for display (hash of faceId → hue). Ground gets index 0.

`TraceReport`: line width estimate, counts (nodes, edges, faces, objects), gaps auto-closed (list with positions), remaining open endpoints (list), spurs pruned, nodes per 1000 du. The import review screen shows the traced edges over the source PNG with sliders for `threshold`, `simplifyTolerance`, `fitMaxError`; the whole trace re-runs on change (budget ≤ 5 s at 4K in a worker; show progress).

Optional `[P2]` **Fill from reference**: if the designer also uploads a flat-color PNG of the same size (Prompt B), assign each face the dominant reference color inside it, snapped to the nearest palette `displayRgb` (Lab distance), leaving faces unassigned when the best match is farther than a threshold.

### 7.2 Topology: planar map and faces (`core/topo`)

Purpose: turn the edge set into faces with stable identities, at exact resolution-independent precision. This is the heart of the product; invest in tests.

**Algorithm (`buildPlanarMap(geometry, bounds, repeat)`)**
1. **Flatten.** Each bezier segment → polyline with adaptive subdivision, flatness tolerance 0.05 du. Straight segments stay as is.
2. **Fixed point.** Multiply by 64 and round to integers. Drop zero-length segments. Merge nodes closer than 1 unit (1/64 du).
3. **Clip / wrap to the repeat cell.** Section 7.9 defines how edges outside `bounds` re-enter. Result: all polyline segments lie within the cell rectangle `[0, w·64] × [0, h·64]`. The cell boundary is **not** an edge; faces extend to it.
4. **Arrangement.** Compute all pairwise segment intersections (sweep line or a uniform grid bucket approach — grid is fine: bucket size ≈ 64 du) and split segments at intersection points (rounded to integers; then re-check the split segments for new intersections until stable — usually 0–1 extra pass). Overlapping collinear segments are merged.
5. **DCEL.** Build half-edges; at every vertex sort outgoing half-edges by angle; link `next` pointers; walk cycles. Compute the signed area of every cycle. Cycles of one sign are outer boundaries of bounded faces; cycles of the other sign are inner boundaries (holes) of the face that encloses them. Which sign is which depends on the y-down axis convention — pick one, and pin it with the single-square test. The face that has no outer boundary is the unbounded face = **ground**, clipped to the cell.
6. **Holes.** Assign each hole cycle to the smallest enclosing bounded face (or to ground) by point-in-polygon of one of its vertices. Result: `Face { id, outer: Polygon | null (ground), holes: Polygon[], areaDu: number }` with polygons in du (divide by 64). Face ids are deterministic: hash of the rounded `ref` point on first appearance; `trackFaces` (below) carries ids forward across edits.
7. **Dangling edges** (a vertex of degree 1) do not split faces; they appear inside a face. Keep them: if `width > 0` they are decorative visible lines; if `width === 0` they are reported as **gap warnings**.
8. **Reference point.** For each face compute the pole of inaccessibility (Mapbox "polylabel" algorithm, precision 0.5 du). Store as `face.ref`.

**Face identity across commits (`trackFaces(prevFaces, prevColors, newFaces)`)**
- Rasterize both face sets to a label map at a fixed working resolution (long side 1024) and compute the overlap matrix (counts of pixels per prev×new pair). This is cheap and robust.
- Match greedily by largest overlap ratio `overlap / min(areaPrev, areaNew)`; a match requires ratio ≥ 0.5. Matched faces keep the previous `faceId` and `FaceColor`.
- New face with no match (created by drawing a line through a face, or a new closed shape): inherit the color of the previous face with the largest overlap (split case); if none, `null`.
- Two previous faces mapped to one new face (merge, usually a gap opened): the new face takes the color of the larger previous face and a **conflict warning** is raised listing both colors and the location (`ref` of the smaller).
- Fallback resolution by `FaceColor.ref`: if a stored color's face id is missing (replay onto a different master version), find the new face containing `ref`; if that face has no color, assign it.
- Ground is always identified as the unbounded face and keeps index 0 (it can be recolored; the "ground" label is about topology, not color).

**Hit testing**: `faceAt(p)` = point-in-polygon over faces (with holes) using a `flatbush` index on face bounding boxes. `edgeAt(p, tolerance)` = nearest flattened segment within tolerance (tolerance in screen pixels converted to du).

**Performance targets**: ≤ 100 ms for 2 000 edges / 5 000 nodes on a full rebuild. Incremental rebuild (only objects whose bounding box changed, plus their neighbors) is `[P2]`; design the API so it can be added (`buildPlanarMap` takes an optional previous result + dirty rect).

**Tests (golden, in `core/topo/__tests__`)**: single square; two squares touching on one edge; nested squares (hole); crossing lines forming 4 faces; T-junction; dangling line inside a face; tangent circles; coincident overlapping segments; a shape moved across the repeat boundary; 1 000 random closed shapes (fuzz) checked against Euler's formula `V − E + F = 1 + C` (C = components) and against a raster flood-fill oracle.

### 7.3 Objects (`core/objects`)

- An object owns edges. Faces are not owned; a face is "of" the object whose edges bound the majority of its perimeter (computed when needed for display in the object list).
- **Transform** (move / scale / rotate / flip) applies an affine to every node (anchor + handles) of the object's edges. Nodes shared with another object (edges of two objects meeting at a node) are moved too, and the other object's edge end follows — this is the expected behavior for touching motifs; the warnings panel shows it as "shared node moved".
- **Group / Ungroup**: group = union of edge sets into one object; ungroup = split by connected components.
- **Duplicate**: deep copy of edges + nodes with new ids, offset by (10, 10) du or placed at drop position; face colors are copied by mapping the duplicated faces via the `ref` points transformed with the same offset.
- Objects have `locked` (no selection/edit) and `hidden` (not rendered, not exported; warn on export if any hidden).

### 7.4 Size math (`core/size`)

Given `master.bounds` (Wd × Hd du), `profile` (hooks, epi, ppi) and `SizeInput`:

```
physical:   widthPx  = round(widthIn × epi)          (cm → in: ÷ 2.54)
            heightPx = round(heightIn × ppi)
            if only one given and linkAspect: the other from the master aspect
                heightPx = round(widthPx × (Hd / Wd) × (ppi / epi))
                widthPx  = round(heightPx × (Wd / Hd) × (epi / ppi))
grid:       widthPx / heightPx given directly; missing one from aspect as above
fitAcross:  widthPx = floor(hooks / n); heightPx from aspect
```

Always return both representations for display: `{ widthPx, heightPx, widthIn: widthPx/epi, heightIn: heightPx/ppi }` and the checks:
- `hooks % widthPx !== 0` → warning "150 does not divide 2400; nearest valid: 150 (16 repeats)… " → offer the two nearest divisors as one-click options.
- `widthPx > hooks` → warning.
- Faces whose area at this size is `< rules.minRegionPx` → count them ("12 small regions will be removed"), list positions.
- `widthPx × heightPx > 40 000 000` → refuse (memory).

Mapping design → output space: `u = x × widthPx / Wd`, `v = y × heightPx / Hd`. Output pixel `(i, j)` covers `[i, i+1) × [j, j+1)`; its center is `(i + 0.5, j + 0.5)`. The anisotropy (non-square loom pixel) is entirely in this mapping; nothing else in the pipeline needs to know about EPI/PPI.

Screen display of the output grid ("true proportion" toggle): each output pixel is drawn `1 / epi` wide and `1 / ppi` tall, i.e. height/width ratio = `epi / ppi`.

### 7.5 Render pipeline (`core/render`)

`render(geometryAtSize, palette, widthPx, heightPx, rules, overrides) → { grid: Uint8Array (indices), report: RenderReport }`

Fixed order; each stage is a pure function on the grid so it can be unit-tested and diffed:

1. **Faces.** For each face (ground first, then faces sorted by area descending, so small faces inside large ones win): transform outer + holes to output space, scanline-fill with the **pixel-center rule** (a pixel is inside if its center is inside by non-zero winding; centers exactly on an edge use the top-left rule so every center belongs to exactly one face). Write `colorIndex` (unassigned → 0, counted in the report). Because faces partition the cell, every pixel is written exactly once except numeric ties handled by the tie rule.
2. **Visible edges.** For edges with `width > 0`, in ascending `z`: flatten to output space; a pixel gets `edge.colorIndex` if its center is within `width / 2` of the polyline (distance to segment). Width is in output px and does **not** scale with size — this is what keeps outlines intact at small sizes. Minimum effective width 1 px.
3. **Rules** (Section 7.6), in order: `connectVisibleEdges4` → `minThickness` → `minRegion` → `removeCheckerboard`. Each records the set of changed pixels.
4. **Pixel overrides.** Apply `pixelOverrides` last (ignore out-of-range).
5. **Palette guard.** Assert every value < palette length. Count colors used.

`RenderReport`: `{ unassignedFaces: number, changedPixelsByRule: Record<rule, number>, changedPixelsMask: Uint8Array (bit per rule), colorsUsed: number[], smallFacesRemoved: {x,y}[] }`.

Determinism: integer scanline with fixed-point coordinates (multiply output-space coordinates by 256 and round). No floating-point accumulation across rows.

### 7.6 Cleanup rules (`core/rules`)

Each rule: `(grid, w, h, palette, cfg) → changedPixels[]`. Neighborhood = 4-connected unless stated. "Majority neighbor" = the most frequent color among the 8 neighbors that is not the pixel's own color; ties → lowest index.

- **connectVisibleEdges4** (default on): for each visible-edge color, find diagonal steps (pixels `(x,y)` and `(x+1,y+1)` of color c where `(x+1,y)` and `(x,y+1)` are not c) and set `(x+1,y)` to c (choose the candidate whose current color has the larger region; if equal, `(x+1,y)`). Only applies to pixels written by stage 2 (keep a mask from the render).
- **minThickness** (default off; k = 2 when on): per color, morphological opening with a k×k structuring element on that color's mask; pixels removed by the opening are set to their majority neighbor. Skip visible-edge pixels.
- **minRegion** (default 4): per color, 4-connected components with area < `minRegionPx` → set to the majority color along the component's border. Skip components of visible-edge pixels only if the edge rule is on (a thin line is intentional).
- **removeCheckerboard** (default on): 2×2 blocks whose diagonal pairs are equal and the two diagonals differ (`a b / b a`) → set the block to the color with the larger surrounding count.

Rules never introduce a color not in the palette and never touch pixels covered by a pixel override (overrides are applied after, so this is automatic).

### 7.7 Export (`core/bmp`, `core/exportPng`)

**BMP** — 8-bit indexed, uncompressed (`BI_RGB`):
- `BITMAPFILEHEADER` (14 bytes): `'BM'`, file size, 0, 0, offset = 14 + 40 + 256×4.
- `BITMAPINFOHEADER` (40 bytes): size 40, width, height **positive** (rows stored bottom-up — write the last grid row first so the image displays upright), planes 1, bitCount 8, compression 0, imageSize, xPelsPerMeter = round(epi / 0.0254), yPelsPerMeter = round(ppi / 0.0254), colorsUsed 256, importantColors 0.
- Palette: 256 entries `[B, G, R, 0]`; entries 0..n-1 from `exportRgb`, remaining entries black.
- Rows padded to a multiple of 4 bytes.
- Byte-level golden test against a hand-verified 4×3 image.

**PNG** — 8-bit indexed with the same palette (for viewing and for the eval harness).

**Sidecar JSON** — `{ master: {id,name,version}, variant: {id,name,version}, profile, widthPx, heightPx, widthIn, heightIn, palette, rules, changedPixelsByRule, exportedAt, app: 'JDM x.y' }`.

**Preview PNG** (optional, `[P2]`) — the grid stretched to true proportions for sharing on WhatsApp/phone.

File naming: `{masterName}_{widthPx}x{heightPx}_{profileName}_v{variantVersion}.bmp` with unsafe characters replaced by `_`.

`[OPEN]` Confirm with the owner that NedGraphics imports 8-bit indexed BMP as-is (versus 24-bit). Both writers are trivial; default to 8-bit indexed.

### 7.8 Operations, undo/redo, versions, replay (`core/ops`)

Every edit in the editor is an `Operation` object applied by `applyOp(doc, op) → doc'` (pure; returns a new immutable document) with `invert(op, docBefore)` for undo.

```ts
type Operation =
  | { t: 'moveNodes'; nodes: { id: string; from: Vec2; to: Vec2 }[]; controls?: { edgeId: string; segIndex: number; from: BezierSegment; to: BezierSegment }[] }  // anchors and the affected handles in one op
  | { t: 'setNodeKind'; id: string; from: 'corner'|'smooth'; to: 'corner'|'smooth' }
  | { t: 'insertNode'; edgeId: string; segIndex: number; tParam: number; node: Node }
  | { t: 'deleteNode'; edgeId: string; node: Node; index: number }
  | { t: 'addEdge'; edge: Edge; nodes: Node[]; objectId: string }
  | { t: 'deleteEdge'; edge: Edge; orphanNodes: Node[]; objectId: string }
  | { t: 'transformObjects'; objectIds: string[]; matrix: [number, number, number, number, number, number] } // affine, invertible
  | { t: 'setFaceColor'; faceId: string; ref: Vec2; from: number|null; to: number|null }
  | { t: 'setEdgeStyle'; edgeId: string; from: { width: number; colorIndex?: number }; to: { width: number; colorIndex?: number } }
  | { t: 'group'; objectIds: string[]; result: DesignObject } | { t: 'ungroup'; objectId: string; results: DesignObject[] }
  | { t: 'duplicateObjects'; sources: string[]; created: { objects: DesignObject[]; edges: Edge[]; nodes: Node[]; faceColors: FaceColor[] } }
  | { t: 'setPalette'; from: Palette; to: Palette }
  | { t: 'setPixelOverride'; pixels: { x: number; y: number; from: number|null; to: number|null }[] }   // size variants only
  | { t: 'setRules'; from: RuleConfig; to: RuleConfig }                                                 // size variants only
  | { t: 'setObjectFlags'; id: string; from: {locked:boolean;hidden:boolean}; to: {locked:boolean;hidden:boolean} };
```

- **Undo/redo**: a linear history of ops per open document, unbounded within the session; coalesce continuous drags into one op on mouse-up.
- **Autosave**: the client sends ops in batches (≤ 1 s latency); the server appends them to the document's draft log and materializes the document. Reloading the page restores the draft.
- **Save version**: creates `VersionSnapshot` (full document) with a note; the draft log is compacted. List, restore (restore = new version whose doc equals the old one), and visual compare of two versions (side-by-side renders) `[P1]`.
- **Size variant = base master version + ops**. `materialize(variant) = replay(masterSnapshot(base.masterVersion), variant.ops)`. Cache the materialized geometry in the variant document for speed; recompute on load if the base or ops changed.
- **Re-base a variant onto a newer master version** `[P1 minimal, P2 full]`: replay `variant.ops` on the new snapshot. Ops resolve targets by id; if an id is missing, fall back to nearest node / face containing `ref` within a tolerance (5 du); if that fails, the op is skipped and listed as a conflict. The designer sees "12 of 14 edits re-applied, 2 conflicts" with locations and chooses **Keep re-based** or **Keep old base**. Never re-base silently.

### 7.9 Repeat mode (`core/topo/wrap`)

- `repeat.type` defines tiling offsets: `straight` → `(w, 0), (0, h)`; `half-drop` → columns shift vertically by `h/2`; `brick` → rows shift horizontally by `w/2`.
- Topology on the cell uses the **9-tile trick**: every edge is replicated at the 8 neighboring tile offsets, all replicas are clipped to the cell, then the arrangement is built. A shape crossing the right border therefore appears re-entering on the left. Faces cut by the cell boundary that are one face across the seam are unified for color purposes: two faces are "seam-adjacent" when their boundary segments on opposite cell borders coincide after the tiling offset; unify them in `trackFaces` (union-find) so a fill on one side colors both. `[P1]` for `straight`; `half-drop` and `brick` for **preview** in `[P1]` and for seam-unified editing in `[P2]`.
- **Show repeat** toggle draws a 3×3 tiled preview of the current render (size mode) or of the vector (master mode) at reduced opacity for the 8 neighbors; editing in the center cell updates neighbors live.
- Exports are always exactly one cell (`widthPx × heightPx`); NedGraphics repeats.

---

## 8. UI specification (`apps/web`)

### 8.1 Screens
1. **Library** — grid of masters (thumbnail, name, tags, #sizes, updated). Search by name/tag. Buttons: `New master` (opens Import), open master. Each master card expands to its size variants. `[P2]` visual similarity search.
2. **Import** — drop a PNG → shows source with traced edges overlaid (edges in cyan, nodes hidden, gaps as red dots, auto-closed gaps as yellow dots). Controls: `Threshold` slider (with live binarized thumbnail), `Detail` slider (maps to `simplifyTolerance` and `fitMaxError` together: Low / Medium / High presets plus fine slider), `Invert` toggle, optional crop rectangle for the repeat cell, `Repeat type` (straight default). Stats line: "2 objects · 340 nodes · 58 faces · 3 open ends". Button `Create master`.
3. **Editor** — one screen, two modes selected by a segmented control in the top bar: `Master` / `Size ▾` (dropdown lists this master's size variants + `New size…`).
4. **Settings** — machine profiles (list, add, edit: name, hooks, EPI, PPI), default palette, users.

### 8.2 Editor layout
```
┌──────────────────────────────────────────────────────────────────────────┐
│ Top bar: [Master | Size ▾]  Undo Redo   Zoom [fit][100%][px]  Toggles: Nodes · Boundaries · Repeat · True proportion · Pixel grid · Changed pixels · Overrides   Save version │
├────┬─────────────────────────────────────────────────────┬──────────────┤
│ T  │                                                     │ Palette      │
│ o  │                Canvas                               │ Objects      │
│ o  │   master mode: vector on white                      │ Size & Rules │ (size mode)
│ l  │   size mode: rendered pixels + vector overlay       │ Warnings     │
│ s  │                                                     │              │
├────┴─────────────────────────────────────────────────────┴──────────────┤
│ Status: cursor x,y (du and px and inch) · zoom · selection (n objects, n nodes) · last autosave │
└──────────────────────────────────────────────────────────────────────────┘
```

### 8.3 Tools (exactly these in v1; keys in parentheses)
| Tool | Key | Behavior |
|---|---|---|
| Select | V | Click object to select; Shift+click adds; drag on empty = marquee; drag selection = move (Shift constrains to axis); 8 handles = scale (Shift = uniform), rotate outside corners; Alt+drag = duplicate; arrow keys nudge 1 du (Shift = 10); in size mode nudge = 1 output px and moves snap to output pixel grid. Flip H / Flip V buttons appear in the top bar when something is selected, plus numeric W / H / angle fields. |
| Node | A | Shows nodes of the selected object(s) only. Drag node; drag handles (Alt = break symmetry → corner); double-click on an edge inserts a node; Delete removes selected nodes (edge re-fits through neighbors); Alt+click node toggles corner/smooth. Click an unselected object selects it. |
| Pen | P | Click = corner node; click-drag = smooth node with handles; click on an existing node or edge snaps and connects (creating a junction); Enter/Esc/double-click finishes; closing onto the start node closes the loop. New edges get `width 0`; they join the object they connected to, else form a new object. |
| Line | L | Click-click polyline of straight segments with the same snapping/connect rules as Pen. Shift = 45° steps. |
| Fill | K | Click a face → set it to the current palette color. Alt+click = eyedropper (picks that face's color). Shift+click fills all faces with the same current color as the clicked face **inside the same object**. Fill stays active for rapid coloring. |
| Erase edge | E | Click an edge (the whole chain between two junctions/ends) to delete it; adjacent faces merge (the larger keeps its color). Alt+click = delete only the segment under the cursor between its two nodes. |
| Pixel pencil | B | **Size mode only.** Paints pixel overrides with the current palette color, 1 px brush (Shift+click = line). Right-click/Alt = clear override under cursor. |
| Zoom | Z | Click zoom in, Alt+click out; scroll wheel zooms around cursor; Space+drag pans (all modes). |
| Edge style | — | Not a toolbar tool: a small popover in the top bar when an edge is selected (Select tool clicks an edge when no object is hit): `Width (px)` 0–8 and color. Default 0. |

No other tools. Explicitly excluded from v1: boolean operations, offset path, text, gradients, brushes, layers, smart guides, align/distribute (`[P2]`: align/distribute and live symmetry are the first candidates).

### 8.4 Panels
- **Palette**: 16 swatch slots in a 4×4 grid; empty slots show `+`. Click = current color (highlighted). Double-click = edit name / display color / export color. Right-click = "Select faces with this color", "Merge into…" (re-index; asks confirmation). Each swatch shows a small count of faces using it. Index numbers visible (designers map index → weave in NedGraphics).
- **Objects**: list with name, small thumbnail, eye (hide), lock. Multi-select mirrors canvas selection. Buttons: Group, Ungroup, Duplicate, Delete. Rename by double-click.
- **Size & Rules** (size mode only): machine profile dropdown; unit toggle `in / cm / hooks×picks`; width and height fields with a link-aspect chain icon; `Fit N across` field; the resolved line "150 × 96 px = 2.50 × 2.00 in — 16 repeats across 2400 hooks ✓"; rules with their defaults (minRegion number, minThickness toggle+number, checkerboard toggle, connect edges toggle); `Re-render` happens automatically; `Export BMP` button (also Ctrl+E); list of previous exports with download links.
- **Warnings**: live list; clicking an item zooms to it. Types: open end (gap) with `Close` action (connects to nearest edge within 3× gapClose); unassigned face with `Fill` action (uses current color); color conflict (merge) with both colors; small faces to be removed at this size; width does not divide hooks (with nearest options); hidden objects present; unassigned faces on export.

### 8.5 Shortcuts (Photoshop-aligned)
V select · A node (Photoshop's direct selection) · P pen · L line · K fill (paint bucket is G in Photoshop; offer both G and K) · E erase · B pencil · Z zoom · Space pan · Ctrl+Z / Ctrl+Shift+Z undo/redo · Ctrl+A select all · Ctrl+D deselect · Ctrl+G / Ctrl+Shift+G group/ungroup · Ctrl+J duplicate · Delete · Ctrl+0 fit · Ctrl+1 100 % · Ctrl+E export · Ctrl+S save version · Tab hides panels · `[` `]` cycle palette color · 1–9,0 select palette index 1–10 directly.

### 8.6 Canvas rendering
- Master mode: white cell, faces filled with `displayRgb` (unassigned = placeholder tint at 60 % + diagonal hatch), invisible edges drawn as 1-px hairlines in 40 % gray (toggle "Boundaries", on by default; in size mode it hides the whole vector overlay so the designer can inspect pure pixels), visible edges in their color at their width scaled to the current zoom, selection in blue, nodes as 6-px squares (corner) / circles (smooth), handles as thin lines with dots. The "Nodes" toggle shows nodes of the selection in any tool; the Node tool always shows them.
- Size mode: the rendered grid drawn with nearest-neighbor scaling (no smoothing) at the current zoom; true-proportion toggle stretches vertically by `epi/ppi`; vector overlay (edges as hairlines, selection, nodes) on top; pixel grid lines appear at zoom ≥ 800 %; "Changed pixels" overlay tints pixels touched by rules (one tint per rule, legend in the panel); "Overrides" overlay outlines override pixels.
- Live re-render on every geometry change in size mode, debounced 50 ms, in the worker; while a drag is in progress render only the dirty rectangle (bounding box of the moved geometry, expanded by the max rule kernel) `[P1]`, full render on mouse-up.
- Screen rendering via a single `<canvas>` with an offscreen backing bitmap for the pixel grid; vector overlay drawn on top each frame. Target 60 fps for pan/zoom, ≤ 100 ms feedback on edits at ≤ 2 000 edges.

### 8.7 Empty states and first run
- New workspace: prompt to create one machine profile (with the placeholder example prefilled, Appendix C).
- New master after import: banner "All regions are unassigned. Pick a color and click regions to fill." with a `Got it`.
- New size: the Size panel opens with the last used profile and unit.

---

## 9. Tests, eval harness, determinism, performance

### 9.1 Unit tests (vitest, in `core`)
- `size`: the formulas in 7.4 with the worked examples in Appendix B; rounding; cm; fitAcross; divisor suggestions.
- `bmp`: byte-level golden for a 4×3 indexed image; row padding; bottom-up orientation (assert first file row = last grid row); palette bytes.
- `topo`: the golden cases listed in 7.2; Euler-formula fuzz; face tracking (move, split, merge, replay by `ref`).
- `rules`: each rule on 8×8 synthetic grids, before/after fixtures; rules never emit out-of-palette indices; overrides untouched.
- `render`: pixel-center rule on a triangle at 3 sizes; visible edge width constant across sizes; ties (edge through pixel centers) deterministic.
- `trace`: synthetic images (rectangles, circles, a drawn "flower" with a 6-px gap) → expected node/edge/face counts within ranges; spur pruning; gap auto-close.
- `ops`: apply/invert round-trip for every op type; replay onto a modified base with id fallback by `ref`.

### 9.2 Golden set (`eval/golden`, run by `packages/eval` CLI: `pnpm eval`)
- 10 real cleaned PNGs from the owner (placeholders: synthetic images until provided). For each: trace with defaults → metrics JSON (`nodes, edges, faces, objects, openEnds, autoClosed, nodesPer1000du, traceMs`) → render at three sizes (small / medium / large, defined per file in `golden.json`) → PNG + BMP + `changedPixelsByRule`.
- Snapshot compare: outputs must be **byte-identical** to `eval/golden/expected/`. Any diff fails CI. Updating expected outputs requires `pnpm eval --update` and a commit message line `EVAL-UPDATE: <reason>`.
- Metric budgets in `golden.json` (per file): max nodesPer1000du, max openEnds after auto-close, max changed pixels per rule per size. Exceeding a budget fails.
- "Cleanup effort proxy" reported per size: `changedPixelsTotal + 50 × unassignedFaces + 200 × openEnds` — used to compare pipeline changes over time.

### 9.3 Determinism test
CI renders the golden set once in Node and once in headless Chromium (Playwright, inside a Web Worker) and asserts byte-identical BMPs.

### 9.4 Performance budgets (CI on a mid laptop; fail if exceeded by > 25 %)
- Trace 4096×3072: ≤ 5 s.
- Full topology rebuild, 2 000 edges: ≤ 100 ms.
- Full render 2400×3000 px with rules: ≤ 1 s; 300×300: ≤ 30 ms.
- Editor: pan/zoom 60 fps at 5 000 nodes; edit feedback ≤ 100 ms.

### 9.5 Definition of done for any core change
Tests green, golden byte-identical or explicitly updated, budgets met, ADR note in `docs/adr/` if a decision in this spec changed (with owner approval).

---

## 10. Build order and acceptance

**M0 — Core pipeline on the command line (no UI).**
`pnpm jdm trace in.png --out master.json` · `pnpm jdm fill master.json --auto-placeholders` · `pnpm jdm render master.json --profile p.json --width-in 2.5 --out out.bmp` · `pnpm eval`. Includes: trace, topology, face tracking, size math, render, rules, BMP/PNG/JSON export, golden harness, determinism test.
*Acceptance:* the 10 golden PNGs render at 3 sizes each; BMPs open in NedGraphics with exact dimensions and ≤ palette count colors; a designer's manual cleanup on 3 of them is measured against the Photoshop baseline (target ≤ 20 %). **Do not start M1 until the owner has seen M0 outputs in NedGraphics.**

**M1 — Library, Import, Master mode.**
Auth + workspace, Library, Import review, Editor with Select / Node / Pen / Line / Fill / Erase / Zoom, Palette, Objects, Warnings (gaps, unassigned, conflicts), undo/redo, autosave, Save version, restore, compare.
*Acceptance:* a designer imports a cleaned PNG and produces a fully colored master with zero open ends in ≤ 15 minutes for a typical butta; all edits undoable; reload restores state.

**M2 — Size mode and export.**
Machine profiles, Size & Rules panel, live pixel preview with overlays, size-mode edits (object/node), Pixel pencil overrides, export with sidecar and history, straight-repeat preview and wrap topology.
*Acceptance:* from a saved master, three sizes are generated and exported in ≤ 5 minutes total; changed-pixel overlay and warnings are correct; exports byte-identical between browser and server.

**M3 — Re-base and polish** `[P2]`.
Variant re-base onto newer master versions with conflicts; half-drop/brick seam editing; fill-from-reference; align/distribute; live symmetry; similarity search; Gujarati tooltips; Tauri build.

Sequencing note: coding speed is not the constraint on this project; validation with designers and golden data is. Every milestone ends with a designer session, and the results (minutes, pixels changed, complaints) go into `docs/sessions/`.

---

## Appendix A — External AI cleanup prompts (used by the designer, outside JDM)

The designer photographs or scans the sketch, runs it through an image-editing model (e.g. Nano Banana 2 / Gemini image, or another model with image-to-image editing) with **Prompt A**, and uploads the resulting PNG to JDM. Run the prompt 2–3 times and keep the best result. Request the highest resolution the model offers (4K if available) and PNG output.

### Prompt A — sketch to clean line art (primary)
```
You are preparing a hand-drawn textile design sketch for a jacquard weaving CAD system that will auto-trace the lines into closed vector regions. Convert the attached sketch into clean, flat, black-and-white LINE ART.

Requirements:
1. Pure black (#000000) lines on a pure white (#FFFFFF) background only. No gray, no color, no anti-aliasing halos, no gradients, no shading, no hatching, no texture, no filled areas.
2. All lines thin and of the same uniform thickness everywhere in the image.
3. The lines are boundaries between color regions. Every shape must be fully CLOSED so it can be filled with color later. Close every gap and connect line ends that were meant to meet. Do not leave open or dangling strokes, except intentional short detail lines inside a shape.
4. Keep the composition exactly: the same motifs, the same count of motifs, the same positions, proportions and sizes as in the sketch. Do not add motifs, do not remove motifs, do not rearrange or re-center anything. You may smooth wobbly strokes into clean, confident curves; you may not change what is drawn.
5. Remove everything that is not the design: paper texture, shadows, creases, smudges, pencil noise, construction and guide lines, ruler marks, grid lines, text, signatures, fingers, and any background objects.
6. Flat, straight-on top view: no perspective, no page curvature, no border or frame, no drop shadow, no watermark.
7. Keep the same aspect ratio as the sketch and keep the design filling the canvas the way the sketch does. Do not crop motifs at the edges and do not add margins.
8. Output a single PNG at the highest resolution available.
```

**Variants** (append one line to Prompt A):
- *Light / faithful*: `Change nothing about the shapes themselves; only remove noise, even out line thickness and close gaps.`
- *Heavy / regularize*: `You may also make mirrored motifs perfectly symmetric, even out spacing between repeated motifs, and drop details smaller than 1% of the image width.`
- *Repeat unit*: `This image is one repeat tile; the design continues across the left/right (and top/bottom) edges. Keep the edge cuts exactly as drawn so the tile still repeats.`

### Prompt B — optional flat-color reference (`[P2]` fill-from-reference)
```
Using the attached clean black-and-white line art as the exact geometry, fill every enclosed region with ONE flat solid color chosen only from this list: #FF0000, #0000FF, #00FF00, #FFFF00, #FF00FF, #00FFFF, #FF8000, #8000FF. Regions that should be woven with the same yarn get the same color. Keep the black lines exactly as they are. No gradients, no shading, no texture, no new lines, no changes to any shape. Output PNG at the same size as the input.
```
(The colors are placeholders; JDM maps them to palette indices. Real yarn colors are never needed in the reference image.)

### Designer checklist before uploading to JDM
- Black lines, white background, no gray areas (JDM's threshold slider handles slightly gray lines, but large gray areas will trace badly).
- Zoom in on joins: every shape closed. Small gaps are auto-closed by JDM; large ones show as red dots in Import.
- Overlay the output on the sketch (or compare side by side): no motif added or lost.
- Same aspect ratio as the sketch; at least 2 000 px on the long side.
- If lines came out too thick or too thin, re-run with `Make the lines thinner/thicker but keep everything else identical.`

---

## Appendix B — Worked examples and fixtures

**Placeholder machine profile** (replace with real numbers, Appendix C): `hooks = 2400, epi = 60, ppi = 48`.

1. Master from a 3000×2400 px PNG → `bounds = 3000 × 2400 du`. Designer asks width 2.5 in, link aspect:
   `widthPx = round(2.5 × 60) = 150`; `heightPx = round(150 × (2400/3000) × (48/60)) = round(96) = 96` → **150 × 96 px = 2.50 × 2.00 in**; `2400 / 150 = 16` repeats ✓.
2. Same master, grid input 300 × 200: physical `300/60 = 5.00 in`, `200/48 = 4.17 in`; aspect check: expected height at 300 wide = `300 × 0.8 × 0.8 = 192`; the designer entered 200, so the design is stretched 4 % vertically — show an info note, do not block.
3. Fit 7 across 2400 hooks: `widthPx = floor(2400/7) = 342`; `2400 % 342 = 6` → warning; nearest exact: 8 across → 300, 6 across → 400.
4. Screen "true proportion": a pixel is `1/60 in` wide and `1/48 in` tall → drawn 1.25× taller than wide.
5. Visible edge width 2 px: at 150 px wide the outline is 2 px; at 1200 px wide it is still 2 px.
6. Pixel-center rule: output pixel `(i, j)` center `(i + 0.5, j + 0.5)`; a face boundary passing through `x = 3.5` puts column 3's centers exactly on it → top-left rule assigns them to the face on the right/below consistently.
7. BMP fixture (4×3, palette 0=white 1=red 2=black; grid rows top→bottom `[0 0 1 1] [0 2 2 1] [2 2 2 2]`): file rows are written bottom→top, each row padded from 4 to 4 bytes (already aligned), `bfOffBits = 14 + 40 + 1024 = 1078`, `biSizeImage = 12`.

---

## Appendix C — Placeholders and open items for the owner

| # | Item | Default used until answered |
|---|---|---|
| C1 | Real machine profiles (name, hooks, EPI, PPI) for the pilot designers | `2400 / 60 / 48` placeholder |
| C2 | 10 real cleaned PNGs for `eval/golden` + the corresponding sketch photos | synthetic fixtures |
| C3 | Confirm NedGraphics accepts 8-bit indexed BMP directly (and whether palette RGB values matter to their weave-assignment workflow) | 8-bit indexed |
| C4 | Typical color count per design (sets the default palette seed) | 8 entries seeded, 16 max |
| C5 | Is half-drop or brick repeat needed for the first pilots? | straight only in M2 |
| C6 | Hosting: owner's server (Linux, Docker) — domain, storage location, backup policy | Docker Compose, local FS |
| C7 | Photoshop baseline measurement for 3 designs (minutes and pixels changed after downscale) — needed for the M0 acceptance number | none |
