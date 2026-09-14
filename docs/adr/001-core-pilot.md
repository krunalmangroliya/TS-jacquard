# ADR 001 — conservative core pilot

Status: implemented for the initial trial; designer acceptance pending.

The user authorized starting work with a generated reference and clarified that **minor secondary details may be removed when reducing size**. The master retains details; the trial must keep primary motif identity recognizable.

## Decisions

- Pure synchronous TypeScript performs trace, topology, render, cleanup, BMP/PNG encoding and the initial edit subset. IO, PNG decoding, timestamps, CLI, review reports and browser harness remain outside core.
- The first customer sample is 3392×5056. The CLI accepts up to 8192 pixels per side and 40 million total instead of rejecting everything over 4096. It checks dimensions before decoding and retains source resolution, avoiding an implicit downscale of fine detail. Large-input performance is measured separately.
- Default source despeckling is capped at 16 pixels; spur pruning is off. This is deliberately less aggressive than the initial spec's area-scaled threshold and automatic pruning, which can discard fine artwork. Diagnostics flag possible tip artifacts without deleting them.
- Source-verified terminal rays are extended to actual image boundaries to compensate for pixel-center/thinning offsets. Every crossed original source cell must contain line pixels; white gaps are not bridged by this correction.
- Virtual cell-boundary segments close clipped faces for DCEL construction. They are topology scaffolding, not editable/exported art. Actual design edges on a seam remain barriers. Only straight seam editing is supported.
- The supplied dense sample is a panel with mismatched opposite cuts. `repeat: none` and CLI `--repeat none` retain bounded panel geometry and clipped cleanup; they do not connect unrelated border regions. Straight repeat remains the repeat-unit default.
- Persisted face IDs can change after edits. Exact shape matching, reference fallback, and color materialization on reload/render preserve assignments. Tracked IDs and colors travel together. Direct IDs take priority; conflicts are reported.
- Cleanup runs on each size, never back on master geometry. Thickness opening is off because it removes thin shapes. Protected palette indices and visible edges survive cleanup. See ADR 002 for diagonal aggregate protection.
- Portable PNG output uses stored DEFLATE blocks: larger files in exchange for identical browser/Node bytes without platform compressor differences. pngjs decodes source input in the CLI adapter.
- Exact undo uses before/after snapshots in the pilot. Inverse affine transforms lose bits after fixed-point rounding. Full compact operation inversion and rebasing remain editor work.
- The review is a generated static report, not M1's editor/library. Timestamp metadata is excluded from pixel determinism assertions.

## Acceptance boundary

Generated art and synthetic tests cannot establish designer time savings. Real machine profiles, sketch/art comparisons, intended palette assignments, NedGraphics imports and end-to-end measurements are still needed. M0's full acceptance gate is not marked complete.
