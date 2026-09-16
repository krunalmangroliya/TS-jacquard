# Raster cleanup improvement plan

Status: first implementation slice completed, 2026-09-15; full release verification and broader quality acceptance are tracked in [STATUS](../STATUS.md). This document retains the remaining plan and distinguishes implemented behavior from conditional future work. Existing saved designs keep their settings and legacy outline processing. No model has been installed.

## Outcome

Reduce the designer's remaining pixel corrections in NedGraphics while preserving intended outlines, small decoration, distinct colors, repeat geometry, and exact indexed BMP output. A lower speck count alone is not success. The manually cleaned sample is the visual reference; measured manual correction effort is the eventual product outcome.

## Implemented first slice

1. **Source sizing contract:** import now explicitly distinguishes ordinary artwork from a prepared loom grid. Version-1 source interpretation records confirmed read/EPI and pick/PPI; `bounds.pixelAspect` is `1` for artwork, source EPI/PPI for a known grid, or `null` for an unknown grid. Unknown grids remain usable with explicit dimensions and cannot use linked proportions/Fit across. BMP/PNG density is a suggestion that needs user selection, not a sizing command. Filename text is ignored. Pixel/crop dimensions remain unchanged, no image is automatically rotated, and legacy masters retain their existing interpretation. Source density is entered during import; adding it later currently requires reimporting.
2. **Conservative outline option:** new outline selections use a saved algorithm choice. Preservation and repair read one unchanged sampled baseline, so accepted preservation pixels cannot amplify repair. Source-supported proposals must also retain local competing-color connections and sampled details; a joint check rejects edits that would leave new isolated competing pixels. Existing saved configurations without the algorithm field keep the earlier method. The editor offers a comparison before updating legacy processing.
3. **Reviewable gentle cleanup:** the existing `minRegionPx: 2` speck rule is exposed through a preview with checkerboard, thin-detail and outline processing off. Current/proposed views share the same grid and detail crop, show changed pixels and per-color area deltas, and retain area/color restrictions, protected colors and pixel overrides. Applying is one undoable change; keeping current or closing makes no changes. Applying a stale preview is blocked. Changes can restore detail removed by prior settings, so the review describes differing pixels rather than a count of fixed defects.
4. **Low-use color review:** colors used in **0.1% or less** of an image are listed with exact pixel counts, percentages and swatches. Raster masters count the full-resolution imported raster/crop, not the smaller preview; size variants count the final output after cleanup and manual edits. A similar, more common export shade can be suggested, but only **Review merge** opens manual controls and the user decides whether and where to merge. Unused colors are listed separately; small accents are never automatically merged.

The first slice does **not** implement automatic decorative-dot classification, a multi-color optimizer, repeated-motif normalization, a trained model, or a guarantee of no NedGraphics cleanup. The matched manual-reference/held-out-design evaluation below remains necessary.

### Two-sample implementation check

All methods were compared at the same original output grid within each sample: patto **1478 × 667**, pallu **768 × 988**. Source state hashes, crops, color-area counts and two measured runs per case are in `output/cleanup-v2/report.json`.

| Sample / mode | Pixels changed from nearest | Isolated pixels before → after | Newly isolated pixels |
| --- | ---: | ---: | ---: |
| Patto, legacy preservation + repair | 53,879 | 248 → 233 | 93 |
| Patto, conservative preservation + repair | 56 | 248 → 243 | 0 |
| Patto, conservative + minimum region 2 | 297 | 248 → 2 | 0 |
| Pallu, conservative preservation + repair | 188 | 2,061 → 2,061 | 0 |
| Pallu, conservative + minimum region 2 | 2,249 | 2,061 → 0 | 0 |

“Isolated” means a same-color pixel with no same-color neighbor in its surrounding eight pixels. The speck-only controls remain important: patto changed 246 pixels and reached 2 isolated pixels; pallu changed 2,061 and reached 0. Outline processing therefore does not get credit for the reduction already delivered by basic speck removal. Patto conservative combined changed gold area by about **+0.015%**, versus **+14.67%** in the legacy combined mode. Fewer changes support the goal of avoiding expansion, but do not establish that all retained or removed details are correct.

**Second review changed the implementation again.** An initial conservative preservation trial still restored disconnected fragments and introduced 377 / 27 new isolated pixels on patto / pallu. It was rejected. Final preservation requires a connected source-supported fragment of at least three pixels, rejects solid 2 × 2 additions and skips expansion beside already sampled outline ink. Repair requires source connections at the actual sampled anchors and checks all affected neighboring colors. Final conservative cases introduced no new isolated pixels on these two inputs.

The second measured runs for combined processing were approximately **385 / 360 ms** for patto / pallu; with speck removal, **518 / 380 ms**. These are two observations per case, not a latency distribution, and exclude full source-file decoding. They do not establish the larger-input performance targets below.

Remaining algorithm limits: source proof is bounded to 4,096 pixels; processing needs downsampling without enlarging either axis; outline proof is clipped at image edges and does not bridge repeat seams. Ambiguous gaps are left unchanged. Explicit speck/thickness rules can still remove intentional dots or fine detail, including the chosen outline unless protected. The legacy mode keeps its earlier implicit outline protection so existing exports remain reproducible.

## Implemented second slice — selected line repairs and source review

The supplied r6 export exactly matches size revision 6, with 12 used colors and 246 gentle-cleanup edits. Isolated same-color pixels fell from 248 to 2. Its 633 RGB differences from r21 consist of 246 cleanup edits and 387 explicit palette replacements. A 12-pixel black dash became brown but remained a spatial mark; merging a rare color is not semantic mark removal. Evidence: `output/cleanup-r6-review/findings.md`.

- Added explicit **1–8 repair colors**, independent of the preservation ink. All candidates read one frozen sampled grid; different target colors at the same pixel or within two pixels are rejected symmetrically. Unset lists retain old output paths. Lists survive save/export, palette merge/Undo and safe master rebase.
- Added optional aligned **Imported source / Current size / Proposed cleanup** detail panes, coordinate navigation, bounded worker source-crop decoding and late-response guards. Source uses the review palette, including the designer's prior merges. Large source windows are explicitly labelled when sampled.
- Small-region preview defaults to an inclusive **1-pixel** limit, equivalent to existing minimum region 2. Limits through 64 are explicit proposals; they do not become global defaults. Preview lists up to 4,096 changed tiles and supports manual coordinates beyond them. Scope changes replace the rule scope, so they can restore previously cleaned pixels outside it; they do not accumulate local cleanup passes.

Two reviews compared stronger region removal, one-ink preservation/repair and selected multi-ink repair. Increasing minimum region 2→3 changes 378 r6 pixels; gold+cream selected repair instead changes 101 final pixels (91 accepted line proposals plus downstream speck effects). Two overlapping cross-ink proposals are rejected. Isolated pixels remain 2, with no new ones. Pallu gold+blue changes 307 pixels, again with no new isolated pixels. Twelve prior sampled buffers remain byte-identical when no new list is used. These are bounded connection changes, not a reconstruction or a measured NedGraphics time saving. Full evidence and alternative measurements: `output/cleanup-next-review/findings.md`.

No model was added. Automatic fragment classification, local-pass accumulation, repeated-motif reconstruction and independent manual-reference/time-saving acceptance remain pending.

## Evidence and constraints

- Supplied app export: 1478 × 667, 15 used colors, ordinary nearest sampling; all cleanup and outline-repair switches off, with zero cleanup changes. The downloaded file matches its saved revision-21 export by SHA-256.
- Manual file: 384 × 1478, 13 used colors. Rotation without resampling gives 1478 × 384. App and reference differ in repeat coverage, vertical scale and palette semantics.
- In the delivered files, isolated same-color pixels under 8-neighbor connectivity are 248 versus 2, or 25.16 versus 0.35 per 100,000 pixels. Some isolated pixels may be intentional. See `output/bmp-comparison-20260915/analysis.md` and `metrics-summary.json`.
- The current preservation/repair pass supports one selected outline color, mostly adds that color, and can thicken lines. It does not classify decoration versus noise or optimize multi-color boundaries.
- Before this slice, import stored source pixel dimensions/crop but no interpreted source density. The linked-size formula treated source pixel aspect as artwork aspect and applied target PPI/EPI. The new explicit interpretation addresses that limitation for new imports; it does not reinterpret old masters or prove that density explains this sample's differing repeat coverage.
- Local machine: Intel i5-10400F, 12 logical CPUs, 16 GB RAM; previously checked GT 710 with 2 GB VRAM. CPU-first processing and a responsive browser are requirements. No inference speed is assumed from a model's published GPU benchmark.

### Existing-option experiment completed during planning

The nearest render exactly reproduced the supplied BMP. All candidates below use that same source and 1478 × 667 grid with outline color 0 (gold), so the reference's different geometry does not confound this comparison.

| Mode | Changed pixels | Isolated same-color pixels (8 neighbors) | Gold area change |
| --- | ---: | ---: | ---: |
| Nearest | 0 | 248 | 0% |
| Preserve only | 43,763 | 462 | +11.92% |
| Repair only | 1,141 | 231 | +0.31% |
| Combined | 53,879 | 233 | +14.67% |

Preserve-only visibly introduces toothed edges; combined narrows other colors' channels, with brown area falling 14.60% and green 10.11%. Repair changes 10,116 pixels after preservation versus 1,141 alone: one pass amplifies the next. Combined improves gold's singleton count while worsening that of other colors. Repair-only is a restrained comparator, not yet a proven manual-quality result. Single measured runtimes were 170/309/425/733 ms; they are not a timing distribution. Evidence: `output/cleanup-plan-ablation/findings.md` and `report.json`.

A second control tested existing `minRegionPx: 2` with checkerboard, preservation and repair off. Global cleanup changed just 246 pixels and reduced singletons from 248 to 2, introducing no new singletons; it retained 371 small components belonging to larger diagonal regions. Restricting it to cream in the selected flower crop changed one pixel and none outside the selection. That pixel closes a tiny cream hole in an ornament, so its intended role still requires review. **Basic speck removal already works; matching the manual singleton count is not proof of matching its detail quality.** Evidence: `output/cleanup-plan-ablation/speck-report.json` and `compare-speck-cream-edit.png`.

**Decision changed after the second review and additional control:** reuse the existing conservative speck-removal rule in a reviewable preview; add detail checks and restrained gap proposals with competing-color protection. Prioritize settings guidance and the preservation-induced regressions. Defer the broader multi-color optimizer, vector reconstruction and models until a specific unresolved case justifies them. Do not recommend the existing preservation/combined mode globally for this design.

## Decision process: two reviews for every material choice

1. First review: state the observed defect, compare a simple method and at least one alternative on identical input/size, and record quality, damage and runtime. Keep the existing renderer as a baseline.
2. Second review: challenge the tentative winner on thin parallel lines, real gaps, dots, palette permutations, repeat seams, and another design/scale. Inspect the worst crops. Record whether the original decision survived or changed.

Record a short decision entry: alternatives, evidence, failure cases, choice, and remaining uncertainty. Neither a passing unit suite nor an attractive whole-image screenshot substitutes for this review.

## Phase 1 — Establish a valid benchmark and sizing contract

Implementation status: sizing contract and unchanged-grid two-sample ablation are implemented. Matched single-repeat manual-reference alignment, region labels and independently reviewed acceptance coverage remain pending.

### Deliverables

- Freeze source/export/reference hashes, palette mappings, source crop, rotation, repeat phase, exact output dimensions and density in a benchmark manifest. Keep source designs unchanged.
- Two distinct evaluations: (a) candidate-versus-current output at the user's actual 1478 × 667 size; (b) matched single-repeat/crop evaluation against the manual reference at its 1478 × 384 grid. Do not squeeze two repeats into one to create an apparent match.
- The manual grid is diagnostic. It does not authorize changing the user's production geometry to 1478 × 384.
- Align reference regions using design landmarks and one recorded crop/scale/rotation. Avoid elastic warping that could hide bad geometry. Mark noncorresponding artwork and unmapped colors explicitly; report the excluded coverage.
- Include flower engraving, thin leaves, diagonal bands, border diamonds, legitimate dots, close parallel lines, true gaps, multicolor junctions and repeat joins. Preserve both the output pixel view and a density-correct physical view.
- Run the existing nearest, preserve-only, repair-only and combined options before implementing their replacements. Publish the actual output crops and changed-pixel/area statistics.
- The conservative current-rule speck-removal control and selected-color/area variant are complete for this sample. Carry them into the benchmark. Separate source noise left untouched, sampling loss, preservation-induced damage and differing production geometry.
- Clarify import sizing: distinguish ordinary artwork from an already prepared pixel grid; retain usable density/orientation metadata as a suggestion, allow explicit pixel dimensions, and show one repeat and physical size before cleanup. Missing or suspicious metadata must not silently change the design.

The implemented sizing contract is `targetHeight = targetWidth × sourceHeight/sourceWidth × sourcePixelHeight/sourcePixelWidth × targetPPI/targetEPI`. Ordinary artwork uses source pixel aspect 1; a prepared loom grid with confirmed source density uses `sourcePixelHeight/sourcePixelWidth = sourceEPI/sourcePPI`. An unknown prepared grid keeps explicit pixel dimensions. BMP/PNG density is an optional suggestion; filename text is not parsed. Versioned source interpretation preserves existing sizes and exports by leaving old fields absent. A 1478 × 384 prepared source at 200/76 remains 1478 × 384 with that target profile; linking width 1478 at 96/52 produces height 547. The master physical preview uses source aspect, while a size preview uses target density.

### Exit checks

The same crop and size are used within every candidate comparison; palette hue changes are not scored as topology errors. A design whose repeat is uncertain remains usable for internal baseline comparisons but is not treated as exact training ground truth.

Relevant files: `apps/web/src/image-input.ts`, `ColorImageImport.tsx`, `Editor.tsx`; `packages/core/src/size.ts`, `types.ts`; new evaluation utilities under `packages/eval/src/`.

## Phase 2 — Compare two pixel-processing approaches

### A. Improve the existing source-supported rules

Implementation status: the bounded conservative outline method and reviewable existing speck rule are implemented as described above. Semantic decisions about intended dots and the broader protected-detail/independent-design quality review remain pending.

- This is the first implementation experiment. Generate bounded gap and speck proposals from a frozen nearest-sampled baseline. Newly added pixels cannot become unrestricted evidence for subsequent repairs. Resolve overlapping proposals deterministically and recheck constraints before applying a batch.
- Reuse `minRegionPx: 2` as the conservative speck baseline; do not rebuild a removal algorithm whose basic function is already present. Present its proposed removed regions for review and add source-supported detail retention where reviewed examples show false removals. Keep current defaults and saved configurations unchanged until those decisions are validated.
- Preserve useful line fragments using the source footprint, local direction and neighboring color regions.
- Evaluate targeted gap filling and speck removal separately. An isolated target pixel supported by an intentional source dot is a keep candidate.
- Before accepting an edit, inspect what is removed from the competing color: a narrow channel, valid dot, component connection or real gap. Track local width and per-color area changes as well as the chosen outline's continuity. Abstain when the available evidence cannot distinguish decoration from damage.
- Use explicit protected pixels/regions and marked regression fixtures to encode protected holes, dots and paths; do not assume the algorithm already knows their meaning. Check joint edits as a batch because individually acceptable edits can damage a feature together.
- Keep existing color/area/protection/override controls and deterministic worker/export behavior.

This is the lower-complexity baseline. It may be sufficient for some designs, but its present one-color emphasis can favor one region at another's expense.

### B. Multi-color boundary and stroke processing

Status: pending and conditional on reviewed failures of approach A; no multi-color optimizer is installed.

- Defer this experiment until A fails on identified, reviewed regions. Advance only the mechanism needed by those cases.
- Measure each output cell's source-color coverage and local boundary direction. Use existing palette labels only; avoid RGB averaging and automatic palette reduction.
- Stream footprint statistics or keep sparse local color candidates. Never allocate a dense output-pixel × 256-color coverage array. Budget source-feature caches and candidate batches before adding tiled infrastructure.
- Generate a small set of local pixel proposals near suspect boundaries. Rank proposals by source support, line continuity, retained holes/gaps, region width and minimal displacement.
- Treat both sides of a boundary together, instead of running independent dilation for every color. Independent dilation would produce overlap and order-dependent color choices.
- Distinguish solid areas, narrow lines and repeated dot/hatch texture. Preserve texture where evidence is strong; defer ambiguous changes to review.
- A protected line, hole, component or region is a hard constraint. Ordinary small components may be removed only through the explicit speck-removal decision. Global preservation of every source component is neither possible after strong reduction nor compatible with cleanup.
- Improve repeated border motifs only when their phase and correspondence are reliable; never copy one motif over intentionally different neighbors.
- Bound displacement and processing area, record changed pixels, and reject proposals that introduce a protected-region merge, hole closure or palette violation. Unrepresentable fine detail is reported for review rather than guessed.

### Selection rule

Choose A if its quality is comparable and runtime/complexity are lower. Choose B only if it retains more reviewed detail or reduces correction effort without unacceptable damage. A contour-to-vector-to-raster experiment is a fallback for unresolved smooth-boundary cases, not a mandatory rewrite of the imported design.

Repeated-motif normalization, automatic full texture classification and contour conversion are outside the first implementation slice. Local source evidence and explicit protected detail are sufficient to begin testing A.

Relevant files: `packages/core/src/raster-outline.ts`, `rules.ts`, `render.ts`; likely new source-feature and candidate-processing modules. Version any new saved algorithm/configuration so later releases reproduce existing exports.

## Phase 3 — Palette and review workflow

Implementation status: exact low-use color counts, manual merge review, and current/proposed cleanup comparisons are implemented. Per-color location highlighting, semantic defect categories and an uncertainty-ranked review queue remain future work.

- Suggest nearly identical shades with their pixel counts and highlighted locations. Let the user keep every color or explicitly merge chosen entries; never infer that 15 colors must become 13.
- Separate "remove a stray pixel", "join a broken line", and "retain a decorative dot" in the preview. Do not report every changed pixel as a corrected defect.
- Offer original/current/proposed views at the same zoom, an overlay of changes, and small crops of the most uncertain changes. Show clearly when cleanup is off or a selected scope contains no eligible pixels.
- Make a conservative cleanup preview easy to discover. Explain what it would remove or connect, retain protected colors/dots, and let the designer keep the original. A preview preset is a starting proposal, not a universal rule that all singleton pixels are unwanted.
- Retain existing area/color restrictions, per-color protection, manual pixel edits, undo/redo, save/reload and indexed export. Apply accepted changes as one undoable action with exact export reproduction.
- Add a compact quality summary of candidate breaks/specks, protected details and remaining review points. It must describe measurements, not promise zero further cleanup.

## Phase 4 — Add a small model only if it solves a measured gap

Status: pending and conditional. No model/runtime dependency has been added, and model benefit has not been demonstrated on these defects.

Two different possible needs must be evaluated separately:

1. **Selection assistance:** test a lightweight segmentation model against current rectangle/color selection and a simple connected-region selection baseline. Its output is a user-reviewed region mask; it does not directly replace final pixel colors.
2. **Ambiguous defect decisions:** compare a small CPU classifier with the explicit rules using local source/target patches and region features. Predict keep/remove/repair confidence for bounded candidate edits. Deterministic palette/topology constraints still decide whether an edit is allowed.

There is no assumed pretrained model that already understands this textile's decorative dots. Training needs reviewed examples, including correct details as negative examples. Crops or repeats from the same design must stay together when splitting training, validation and test data. Synthetic damage may supplement examples but cannot establish real-design quality by itself.

Start by labeling concrete proposed edits on the actual app grid. That avoids pretending the mismatched manual BMP is a pixel-exact training target. The model scores whether a proposal is appropriate; "review" is an abstention policy for uncertainty, not necessarily a separate ground-truth class.

Start with rules and a small feature classifier before training a patch neural network. If model value is demonstrated, pin the runtime/model version, verify the code and weight licenses, retain a local fallback, and record the model hash plus accepted mask/edits for reproducible exports. The user's instruction authorizes adding a useful dependency during implementation; this plan adds no approval checkpoint for that routine step.

The model research and adoption recommendation are in `cleanup-model-options.md`. Do not assume a decoder-only ONNX export provides the full image encoder.

## Phase 5 — Acceptance and release

### Exact invariants

- No changes to original source files or saved masters during candidate evaluation.
- No output colors beyond the selected palette; no implicit merging.
- Zero changes outside selected original-color/area scope or to protected/manual pixels.
- No protected test line broken, genuine protected gap closed, or protected dot erased in the regression fixtures.
- Same accepted pixels after undo/redo, reload, retained-version restore, browser preview and server BMP export; exact grid, palette and density metadata.
- Stable behavior with palette index 255, duplicate RGB colors, recoloring/rebase, different component processing order, and panel/straight-repeat boundaries. Unsupported repeat modes remain explicit.

### Quality measures

Measure at design/region level: reviewed true defect repairs, false edits to good detail, line continuity, preserved gaps/holes, boundary displacement and color-area drift. Count correct/incorrect candidate operations with sample sizes, damaging operations and pixels per megapixel, worst-design damage, and separate precision/recall for gap versus speck decisions. Report singleton counts only as a supporting metric. Raw 8-neighbor degree-one pixels are not a skeleton endpoint count. Use a blind A/B review where possible and time real touch-up sessions in NedGraphics before claiming a reduction in labor.

Initial experiment targets, not results or guarantees: no newly introduced critical marked-detail damage, no observed damage among automatically accepted operations in the reviewed pilot, and a 30% median reduction in remaining touch-up actions/time. Report actual sample counts and uncertainty; do not translate 98% pixel accuracy into "safe cleanup" when a mode changes tens of thousands of pixels. Uncertain cases remain proposals to review. A modest verified improvement can ship as an optional mode without claiming the labor target is achieved.

Use this sample plus the prior pallu to develop the methods, then hold out independently labeled designs for acceptance. One manually cleaned sample is insufficient to declare broad quality or train and test on the same motifs. If additional paired references are unavailable, continue the algorithm/invariant work and label the quality evidence as a single-reference pilot.

### Performance measures

Benchmark on this PC with source decode included and also measured separately: cold run, warm run, peak memory, cancellation and stale-result rejection. Provisional targets: under 2 seconds for approximately 1 million output pixels, and under 500 ms for a small selected-region preview. For 40-million-pixel outputs, use bounded memory, progress and cancellation rather than an assumed fixed latency. Optional model latency and memory are measured independently.

### Release checks

Run focused meaningful tests plus existing typecheck/build and browser export verification. Audit seam behavior and tiled-processing boundaries with halos if tiling is used. Keep previous saved configurations unchanged. Promote a new default only after the quality review; otherwise expose the better-supported option with its actual limitations.

## Research used as direction, not a ready-made solution

- [Pixelated Image Abstraction](https://cragl.cs.gmu.edu/pixelate/): jointly optimizes low-resolution feature placement and palette. Its abstraction/palette-reduction objective differs from preserving an existing textile palette; any adaptation needs locked colors and detail constraints.
- [Depixelizing Pixel Art](https://johanneskopf.de/publications/pixelart/): addresses connectivity and contour reconstruction while magnifying pixel art. It motivates checking line/gap structure, but does not establish that vectorizing and shrinking textile motifs will improve this app.

## Final decision record

The first design considered a broader multi-color boundary optimizer alongside improving the existing rules. Controlled ablation and a separate second review exposed color-expansion bias and pass amplification, so the first implementation has been narrowed:

1. Freeze the benchmark and source-size interpretation; the existing-rule controls now show that conservative speck removal works and preservation needs correction.
2. Reuse that speck rule with a clear reviewable preview. Add source-detail checks and bounded, baseline-derived gap proposals with competing-color and joint-effect checks.
3. Compare actual detail retention against nearest/current repair/current removal on identical grids; inspect the worst changed regions.
4. Add clear before/after acceptance and exact replay of accepted pixels in export.
5. Escalate to a multi-color optimizer only for documented remaining defects. Trial a small candidate classifier only if ambiguous decisions dominate and reviewed examples exist. Trial MobileSAM only if complex selection is the measured bottleneck; compare component selection and a brush first.

The first deliverable now provides unchanged-grid comparisons, a conservative optional correction method, gentle cleanup review, explicit source proportions and low-use color guidance. Its second review rejected an initial fragment-restoration strategy and tightened the retained method. Earlier 284-test coverage was a regression baseline; current test/build/browser status is recorded in [STATUS](../STATUS.md). Passing those checks and lowering singleton counts do not prove manual cleanup quality. Matched reference review, independent designs and timed NedGraphics work remain outstanding, and model adoption remains conditional on a measured benefit.
