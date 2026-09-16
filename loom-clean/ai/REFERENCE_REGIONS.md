# What the supplied COMPLETE files teach

The COMPLETE files are usable cleanup supervision **despite recoloring**. Their important lesson is that entire textured fields become uniform while nearby structure remains. The earlier synthetic one-pixel model learned a substantially narrower task.

The analysis is reproducible with `ai/analyze_reference_regions.py`. It writes `output/reference-regions/manifest.json`, per-case JSON, native PNG crops, four-column comparisons, region masks and interior-validity masks. No model was retrained or runtime changed.

## Grounded alignment

- **42482-pallu:** the PNG center-nearest resize equals SIZED exactly. COMPLETE has 4 extra rows; useful local offsets vary: dancer field **(dx=0, dy=3)**, upper diamond **(0,1)**, lower instrument diamond **(0,2)**. Coordinates below are SIZED coordinates; COMPLETE is sampled at `(x+dx,y+dy)`.
- **45842-pallu:** PNG resize agrees with SIZED on 99.796% of pixels. Central grain crops align locally at **(0,1)**; the dancer crop uses **(0,0)**. Repeated outer bands have their own phase and should not be forced into the central transform.
- **45842-daman:** horizontally reflect COMPLETE first. The repeated musician strip has a different vertical origin. Its completed 208-row repeats are RGB-identical; the inspected musician crop at **(704,152), 144×112** uses local **(0,-89)**. The initial whole-strip phase approximation was -96, so use the recorded local crop transform for labels. The canopy has a separate local offset **(0,-3)**. The strip also has local redraws; the background field remains a useful positive and the instrument grille a useful negative.
- **42850-pallu:** an exact source alignment is now recovered: resize PNG center-nearest to **3040×1824**, then circularly roll **right by 1602 pixels**. This equals all **5,544,960 SIZED RGB pixels**. The prior large source mismatch was a repeat-origin change. Local COMPLETE flower crop uses **(0,1)**; leaf crop **(4,0)**, after palette-independent matching.

For 42850, stable-interior color correspondence includes cream→green **96.43%**, magenta→gray **95.05%**, and teal→magenta **96.62%**. These are correspondence fractions, not cleanup accuracy. The different output RGB values do not prevent matching geometric regions.

## Actual field-level evidence

Transition density means the fraction of adjacent pixel pairs with different palette colors **inside the same final flat region**, excluding a 2-pixel boundary band. It does not care which replacement color was chosen.

| Case / matched field | Flat region pixels | Valid interior pixels | SIZED transition density | V2 transition density | COMPLETE |
| --- | ---: | ---: | ---: | ---: | ---: |
| 42482 dancer oval background | 7,797 | 6,835 | 18.25% | 8.69% | 0% |
| 42482 lower instrument diamond | 4,056 | 2,959 | 47.43% | 37.37% | 0% |
| 45842 pallu left background | 15,396 | 12,100 | 44.75% | 30.00% | 0% |
| 45842 daman musician background | 3,040 | 1,882 | 38.63% | 38.63% | 0% |

The daman row specifically uses the final background shade `#d0a808`; do not replace this field label with every gold-colored component in that locally redrawn crop. The masks and per-component color keys allow selecting this background separately from the instrument.

These comparisons show why removing scattered components is insufficient: V2 leaves much of the **interior texture**. Cleanup must propose the complete noisy field bounded by the preserved design, with a separate user choice of fill color.

## Usable positive masks and negative examples

Every local crop has `*-region-label.png` (whole flat reference components whose source interiors are textured), `*-valid-interior.png` (the quantitative interior), and per-component data under `regions[].referenceRegionLabels` in the JSON. These are reference-derived candidate region labels. The table above selects visually checked background components; boundary bands and uncertain redraw components remain separate.

Native comparison filenames:

- `42482-pallu-dancer-background-grain.png`: source gold/pink grain becomes a solid pink field; a smaller mixed green field also becomes uniform.
- `42482-pallu-lower-instrument-diamond.png`: dense light-green/gold grain becomes a solid light-green field.
- `45842-pallu-left-background-grain.png`: extensive navy/gold grain becomes uniform navy; surrounding flower and pillar edges remain.
- `45842-daman-musician-grain-phase-aligned.png`: granular background becomes flat **while the harmonium grille is retained**. Stored V2-full-sized removes much of that grille but leaves background grain. This is a particularly important positive/negative pair within one scene.
- `42850-pallu-flower-hatching-preserved.png`: flower hatching is preserved through recoloring. Whole-crop transition density is **19.79% → 18.59%**, rather than collapsing to zero.
- `42850-pallu-leaf-veins-preserved.png`: intended veins remain; transition density is **13.225% → 13.303%**. This is a strong preserve-pattern example, not a noisy fill.

Each comparison has **PNG on target grid / SIZED / V2 on SIZED / aligned COMPLETE** columns. PNG repeat correction is explicitly shown for 42850. Individual native crop files end in `-0.png` through `-3.png`; the comparison display uses nearest-neighbor 3× magnification.

A broader palette-independent 16/32-pixel window scan found:

| Case | Textured source → ≥98% flat final windows | Union of labelled pixels |
| --- | ---: | ---: |
| 42482-pallu | 222 | 29,376 |
| 45842-daman | 34 | 5,376 |
| 45842-pallu | 634 | 59,968 |
| 42850-pallu | 0 | 0 |

The scan uses source transition density ≥0.18 and entropy ≥0.6 bits, then final dominance ≥0.98. Its outputs are **region seed labels**, not the total extent of noisy areas or a cleanup accuracy score. The zero for 42850 agrees with the useful preserved-hatching examples; it does not imply that its COMPLETE file made no smaller repairs. Whole-image labels use coarse registration; prefer the locally registered interiors for initial supervised training.

## Next classifier target

There is enough supplied evidence to begin **real reference-based regional learning** without asking the user to relabel all artwork. Build paired native-grid context crops with three outputs: **flatten this field / preserve structured detail / uncertain boundary**. Positives come from the registered flat COMPLETE components above; negatives come from preserved grille, veins, hatch, ornament and already-flat recolored fields. A color permutation during training prevents a model from learning that pink or gold itself means noise. Do not train it to copy final RGB.

Use 128–256-pixel context around 16–32-pixel texture evidence, so the model can see the enclosing field and protected motif. Predict a whole-region mask, grow proposals within structural boundaries, then show that field to the user for approval. Keep color replacement and exact pixel execution separate. Initial training can use high-confidence registered interiors while masking local redraw boundaries. Keep design IDs separated for evaluation and measure region coverage plus preserved-pattern damage, alongside remaining within-field texture. The provided COMPLETE files support this stronger task; recoloring is a mapping issue, not a reason to discard them.
