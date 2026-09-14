# Preserve substantial diagonal regions during small-detail cleanup

The owner accepts omission of minor detail at small sizes while retaining the main motif. A purely 4-connected minimum-region filter could remove a long diagonal motif as many isolated one-pixel islands, despite the motif occupying a substantial area overall.

The renderer still measures 4-connected components, but it deletes a component only when its entire 8-connected same-color aggregate is also smaller than `minRegionPx`. This check includes straight-repeat seams. Deferred components remain protected during the later checkerboard pass, which otherwise could undo the safeguard. The report includes a warning when cleanup preserves these diagonal components. Visible outlines, explicit pixel overrides, and `protectedColorIndices` retain their separate protections.

This conservatively changes specification §7.6's unconditional deletion of small 4-connected components. It can leave diagonal-only connectivity requiring designer review; it does not infer which motifs are semantically important or automatically thicken them. Morphological opening remains off by default. Raising the thresholds or enabling opening remains an explicit configuration choice.

Removed-detail markers are deduplicated by logical face/seam identity, because one face can produce multiple omitted raster fragments. A marker means that the face has omitted details, not necessarily that the whole face has disappeared.

Validation: regressions cover a four-pixel diagonal, a diagonal crossing the repeat seam, the later checkerboard pass, minor-dot removal, and unchanged original protected-color pixels through the complete rule sequence. Synthetic golden outputs must be regenerated with an explicit reason if this conservative change affects their bytes.
