# Browser and artwork trial — 2026-09-16

The previous rule-based version is preserved at commit `0842267`. This trial uses the frozen `loom-tiny-v1.onnx` SHA-256 `bbfb717035362989098cf3207fea94a1556ea2accac7237b1d15bf9809d83b2b`, with add disabled and removal threshold 0.995.

## Actual artwork results

All ten frozen V2 source outputs were processed by ONNX Runtime Web WASM with one CPU thread and 32 patches per image. Input fingerprints, dimensions, palette, valid indices, output counts and RGB BMP round trips passed. Model loading took about 0.27 seconds in the shared Node session and is excluded below.

| Sample | Model removal proposals | Accepted removals | Processing seconds |
| --- | ---: | ---: | ---: |
| 42482-bodi | 83 | 1 | 0.72 |
| 42482-pallu | 17 | 3 | 0.79 |
| 42482-patto | 16 | 3 | 0.59 |
| 42850-pallu | 12 | 10 | 0.94 |
| 42850-patto | 4 | 2 | 0.80 |
| 42973-bodi | 10 | 3 | 0.69 |
| 42973-pallu | 166 | 81 | 0.95 |
| 42973-patta | 145 | 23 | 0.78 |
| 45842-daman | 22 | 8 | 0.61 |
| 45842-pallu | 48 | 24 | 0.82 |

Geometry guards accepted 158 of 523 above-threshold removal proposals. These counts are not accuracy. Selected cores cover only 0.59%–7.81% of each image, and each patch sees one ink. Most visible grain remains. Several design IDs also supplied training data, so this is an integration check rather than an independent quality benchmark.

Visual review found potentially intentional short hatch fragments among accepted removals in 42850-pallu at (1805,1707), (1806,1707), (2819,1707), and (2820,1707). The model cannot establish their intent. The fixed 42482-pallu ring crop was outside selected cores and must not be counted as evidence of learned preservation. Daman hatching and grille remained visually intact in the inspected crops, with one change at the grille crop's outer edge.

The model has not demonstrated a substantial whole-artwork quality improvement. Retain explicit review and Apply/Discard. The next quality step needs designer-approved examples of actual noise versus deliberate texture, and actual missing-line edits; simply lowering thresholds would hide this problem.

## Browser checks

Production preview at `http://127.0.0.1:4328` successfully loaded and executed the real ONNX model in a browser worker. The 768×988 pallu trial proposed three removals; the 3040×1824 large pallu proposed ten. Both displayed about one second on this PC. The large image's sampled candidate search and limited patch coverage were disclosed in the UI.

Before/proposed/change views, exact 100% zoom, preview edit/export locks, Discard, Apply, Undo and BMP export were exercised. Applying the small pallu proposal changed exactly three exported pixels. One Undo restored a byte-identical BMP: SHA-256 `4a18132782369c7f892c9ec2648c30c91330c2576e3ffb76f7965afb1c2d8962`. Dimensions and palette stayed intact. The large preview was left uncommitted for review.

The UI automation could not click Cancel before the approximately one-second jobs finished; this is not recorded as a successful manual cancellation test. Six client lifecycle tests cover cancellation/worker termination, stale messages, error cleanup, success, and source/undo buffer preservation.

Detailed local artifacts are ignored by Git: `output/ai-experiment/report.json`, `review.html`, `VISUAL-REVIEW.md`, per-sample BMPs/crops, and `browser-export-check.json`. Reproduce them with `scripts/evaluate-ai.ts` after the sample inventory and V2 evaluation.
