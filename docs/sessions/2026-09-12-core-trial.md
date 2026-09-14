# Development trial — 2026-09-12

This is an engineering session, not designer acceptance or a fabric trial.

## Inputs

- Built-in ImageGen paisley reference, preserved in `eval/references/generated-paisley.png`; prompt saved beside it.
- Customer `sample-input/sample-1.png`: 3392×5056, 17,149,952 source pixels. Original PNG preserved without downscaling.
- Placeholder machine: 2400 hooks, 60 EPI, 48 PPI. Test colors, not chosen weaves.

## Findings and fixes prompted by the customer sample

- The panel contains dense ornament, open decorative hatching and mismatched opposing cuts. Final reviewed settings are `--repeat none --gap-close 0 --threshold 157`, saved in `sample-input/sample-1.jdm.json`; it is not asserted to be a seamless repeat tile.
- Final tracing produces 35,849 editable nodes, 27,689 edges and 2,273 connected objects. Of 6,528 open ends, 1,446 are flagged as possible sharp-tip thinning artifacts. Open ends are not counted as confirmed design errors.
- The original global gap-candidate scans stalled on this density. Spatial candidate indexing reduced a full default trace to about 8.7 seconds. Deliverables keep automatic gap joining off to avoid connecting intentional hatching.
- The initial topology pair Set overflowed. Canonical shared buckets, X pruning and indexed containment eliminated that allocation. At the initial threshold 154, full customer topology took about 8.7 seconds in one standalone run, produced 7,285 total faces, and passed exact partition area/Euler checks. The final threshold 157 produces 7,397 bounded faces.
- Final trace plus topology in the CLI measured about 15.5 seconds (excluding input decoding). The old 2,000-edge live-editor performance budget has not been established for this 27,689-edge panel.

## Export diagnostics

| Width × height | Physical size at placeholder profile | Rule changes | Regions with omitted details |
|---|---|---|---|
| 300 × 358 | 5.00 × 7.46 in | 4,085 | 4,229 |
| 1200 × 1431 | 20.00 × 29.81 in | 913 | 1,519 |
| 2400 × 2862 | 40.00 × 59.63 in | 940 | 969 |

The omitted-detail count includes vector faces/fragments lost during sampling and cleanup. It does not count only completely deleted motifs; it is not a remaining-manual-work estimate. Changed pixels likewise do not measure time savings.

## Visual review

The review report shows input, tracing overlay, colored master, three indexed output sizes and masks. A tall-image CSS constraint initially distorted physical proportions; this was corrected and the refreshed screenshot checked.

**Material remaining issue:** default zero-width boundaries hide open decorative strokes even at large output sizes. The sample loses meaningful arch hatching, petal texture, leaf veins and some stems/outlines. This is more than authorized tiny-detail simplification.

A separately labeled comparison makes 5,473 terminal edges visible at one output pixel in palette index 7, restoring much of that detail. It changes 154,727 pixels relative to the corrected filled export; that is a styling comparison, not a correction count. The original master is unchanged.

The initially unfilled prominent leaf was traced to faint source ink at (1542,2789), RGBA [157,157,159,255]. Otsu threshold154 discarded this connection, letting the leaf's white region reach the exterior. Threshold157 closes the17,554-pixel source region; local topology and final full-panel visual review confirm the leaf now fills. This was a threshold-sensitive gray connection, not a true white gap or a topology defect. The reviewed threshold is saved for this input only. Intentional decorative strokes still need an explicit visible-style choice, as shown by the separate diagnostic.

Outputs: `output/samples/sample-1-bb1795/review.html` and `detail-comparison.html`. The diagnostic is not a final yarn, weave or production decision.

## Validation and remaining acceptance

104 unit/integration tests and 70 synthetic golden file comparisons pass. All 30 synthetic BMPs match a real Edge Web Worker. Node/browser equivalence also passes on the customer's full 2400×2862 BMP. Real NedGraphics import, real profile/palette values, fabric appearance and end-to-end designer time remain unverified. This trial does not meet full M0 acceptance yet.
