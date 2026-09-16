# Region proposal measurements

The region engine makes the selected 42482 oval and instrument-diamond fields
flat while retaining their pictured outlines. The selected 45842 background is
substantially cleaner but still contains grain. These are measured development
examples, not a production accuracy score or a claim that every sample is clean.

Run `.venv-ai/Scripts/python.exe ai/analyze_region_results.py` from `loom-clean`.
The reproducible result is
`output/reference-regions/comparison-summary.json`; it records candidate and
baseline SHA-256 hashes, timestamps, registration, color counts and safety cases.
The all-sample proposal report is `output/region-experiment/report.json`.

Final all-ten evaluation: 2026-09-16, engine SHA-256
`aae4c4d1d81c7981d5eedad954561f52708e13178f292817ce1c790b33544d16`.
The comparison script was rerun after that evaluation; all figures below refer
to those candidate BMPs, including the corrected leaf guard.

## Correct baseline and reference geometry

Current proposals start from **V2 on the original PNG**, stored as
`output/sample-analysis/{id}-v2-full-source.bmp`. The earlier reference study used
**V2 on SIZED**, `*-v2-full-sized.bmp`. They are different results; improvement
must be measured against the actual SOURCE baseline.

COMPLETE supplies the shape of the flat field, irrespective of its new color.
For example, the 42482 oval is pink in COMPLETE while this proposal remains gold.
We select the corresponding COMPLETE connected component, exclude its outer
two-pixel band, and measure all versions inside the same fixed mask. A minority
pixel differs from the field's most frequent color. Transition density counts
unequal adjacent pixels among pairs entirely inside that mask. Flat COMPLETE
interiors have zero minority pixels and zero transitions.

| Field | Native source box: x,y,width,height | COMPLETE offset dx,dy | Safe interior pixels |
| --- | --- | --- | ---: |
| 42482 oval | 144,336,144,112 | 0,+3 | 6,835 |
| 42482 instrument diamond | 252,668,160,112 | 0,+2 | 2,959 |
| 45842 left background | 96,288,144,144 | 0,+1 | 12,100 |

## Measured flatness

Each cell below shows **minority pixels / transition density**.

| Field | Old V2 on SIZED | Actual V2 on SOURCE | Region proposal | COMPLETE |
| --- | ---: | ---: | ---: | ---: |
| 42482 oval | 344 / 8.687% | 169 / 3.580% | 0 / 0% | 0 / 0% |
| 42482 instrument diamond | 1,268 / 37.372% | 1,275 / 36.738% | 0 / 0% | 0 / 0% |
| 45842 left background | 3,148 / 30.002% | 1,429 / 16.562% | 534 / 6.074% | 0 / 0% |

The 45842 field has **62.63% fewer remaining grain pixels than V2 SOURCE** in
this safe interior. Its remaining 534 pixels are real unfinished cleanup, not
reference recoloring. The whole displayed crop still contains 568 pixels of the
grain color. Do not describe it as fully flat.

The complete 42482 reference components, including their outer bands, also become
flat: oval 222→0 minority pixels across 7,797 pixels; diamond 1,744→0 across 4,056
pixels. Outside those components, the pictured oval crop retains 38 pink pixels
near its differently drawn contour; the diamond crop retains one light-green
pixel. Zero interior grain does not certify the whole picture.

Native pixels are enlarged with nearest-neighbor display in these four-column
artifacts: SIZED context / V2 SOURCE / proposal / registered COMPLETE.

- `output/reference-regions/comparison-42482-pallu-dancer-background-grain.png`
- `output/reference-regions/comparison-42482-pallu-lower-instrument-diamond.png`
- `output/reference-regions/comparison-45842-pallu-left-background-grain.png`

## Preserved detail and a regression caught during review

All 2,701 navy pixels in the pictured oval crop and 3,894 navy pixels in the
diamond crop remain unchanged. The diamond's 1,154 green, 10,275 gold, 39 cream
and 480 pink pixels also remain unchanged; only its light-green grain changes.
This is preservation relative to V2, not certification of V2's original drawing.

In the 45842 field crop, the final guard preserves all 3,892 original solid-gold,
562 teal, 874 orange, 123 pink and 13,780 navy pixels. Only the separate grain
color changes. An earlier candidate damaged adjacent coherent gold leaves. The
expanded safety crop caught this despite a perfect navy-outline check: a
63-pixel leaf lost 48 pixels and a 61-pixel leaf lost 22. Both leaves are retained
in COMPLETE. After the guard correction, **both lose zero pixels**, and all solid
gold pixels in the expanded 88×80 crop remain unchanged.

- `output/reference-regions/comparison-45842-pallu-gold-tip-safety.png`
- Matching JSON records component sizes, bounds and reference-gold overlap.

Two additional 42850 negative examples preserve every V2 pixel: a 144×112 flower
hatching crop and a 144×112 leaf-vein crop, **zero additional changes in each**.
Both detail types remain in COMPLETE despite recoloring. The PNG repeat is rolled
right by 1,602 pixels for comparison with SIZED/COMPLETE; that phase was separately
verified over all 5,544,960 SIZED pixels. Local reference offsets are (0,+1) for
the flower and (+4,0) for the leaf.

- `output/reference-regions/comparison-42850-pallu-flower-hatching-preserved.png`
- `output/reference-regions/comparison-42850-pallu-leaf-veins-preserved.png`

## Limits

These references were inspected during development, including the leaf-guard
fix, so they are not an untouched test set. Three selected positive fields and
three safety crops cannot establish whole-image accuracy. COMPLETE sometimes
changes contours or motif placement; the eroded interiors are more trustworthy
than raw image differences. Preserved palette and protected navy alone are
insufficient safety evidence, as the leaf regression demonstrated. Remaining
grain and unreviewed regions still need user inspection.

This analysis trains no new model and makes no claim that the earlier synthetic
speck CNN learned whole-field cleanup. The supplied COMPLETE files are useful
real region labels despite recoloring; `REFERENCE_REGIONS.md` records how to
derive positive flat fields and negative preserved patterns for future training.
