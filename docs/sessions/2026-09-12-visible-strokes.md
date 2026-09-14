# Six-color design with manually hidden strokes

User decision: supply the design with source-like strokes. Designers manually hide unwanted strokes through an option. Keep at most six total colors. Source images and earlier trial artifacts remain unchanged.

## Implementation and sample

The same reviewed input settings (threshold 157, no automatic gap joins, panel mode) produce 35,849 nodes, 27,689 edges and 7,397 bounded faces. All source edge IDs, anchors and curves are unchanged. Every edge initially has `strokeHidden: false`, `widthMode: "design"`, its measured width, and outline index 5.

Each path uses robust median normal cross-sections through the original thresholded ink. Junction/tip safeguards reject measurements that follow neighboring lines. Thirty short or repaired paths inherit neighboring widths or a corrected global fallback. Median edge width is 4.171875 source pixels; the maximum is 18.75. The width remains constant within an edge, so original taper is approximated.

The six placeholder entries are Ground, Zari, Red, Leaf, Indigo and Outline. Automatic demonstration fills use indices 1–4. These colors are not approved yarn/weave assignments.

| Output | Colors used | Cleanup changes | Omitted-region markers |
|---|---:|---:|---:|
| 300 × 358 | 6 | 10,765 | 4,358 |
| 1200 × 1431 | 6 | 24,581 | 2,465 |
| 2400 × 2862 | 6 | 6,914 | 1,206 |

Counts do not measure time saved or confirmed errors. Dense source-width strokes can occupy space previously assigned to small fill regions; low-resolution exports still need designer review. The high-resolution aligned crop now retains the arch hatching, leaf veins, stems and petal detail that the former fill-only treatment omitted.

## Manual editing verification

The inspector runs from a local HTML page. A worker caches face topology, renders the same indexed core and updates selected stroke visibility without deleting boundaries. Hidden strokes can be selected again from a list or a dashed overlay. Downloaded edited masters preserve widths, nodes, curves and face colors, and receive updated version metadata. BMP downloads reflect the current rendered size.

Fourteen synthetic browser checks pass. On the actual sample, a real canvas click selected `e8376`; hiding, restoring, undoing and redoing worked. Initial and hidden-state BMP downloads match Node rendering byte-for-byte. Restoring produces the exact initial BMP. The original saved master remains byte-identical, and there are no browser page errors. Topology was materialized once.

Measured on this machine: initial inspector readiness 16,260 ms; hide/render update 8,552 ms. The worker keeps the UI responsive, but dense-panel rendering still needs performance work before an immediate editing experience. Full-resolution comparison rendered the hidden diagnostic in 2.83 seconds and the visible-stroke version in 11.30 seconds in that run.

## Review and regression artifacts

- `output/stroke-trial/sample-1-bb1795/stroke-editor.html`
- `output/stroke-trial/sample-1-bb1795/detail-comparison.html`
- `output/stroke-trial/sample-1-bb1795/review.html`
- `.cache/customer-stroke-ui/result.json`

122 core tests, 70 golden comparisons and 30 browser-worker fixture outputs pass. The baseline update records the approved six-color / source-width change. Ten fixture comparisons confirmed unchanged nodes, curves, edge IDs, object membership and face IDs before accepting new styles and colors.

Production machine settings, actual coloring, full editor features and NedGraphics acceptance remain pending.
