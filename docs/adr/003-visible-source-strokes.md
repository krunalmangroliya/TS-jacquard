# Visible source strokes and six colors

The user's 2026-09-12 clarification replaces the original specification's eight-color default / sixteen-color allowance and invisible initial strokes. Deliver the design with its strokes visible. The designer decides which strokes to hide manually.

## Document and rendering behavior

- A master and every indexed export use at most six palette entries in total, including ground, fills and strokes. The default has ground, four demonstration fill colors, and outline. Placeholder coloring avoids outline-colored faces so line details remain easy to inspect; designers can deliberately reuse any entry for either fill or stroke.
- Tracing estimates each path's ink thickness separately from the source. Each edge stores its width in design units with `widthMode: "design"`. These are per-edge estimates; original taper and width changes within an edge are approximated.
- The renderer scales design widths with both output axes. Different EPI/PPI values must preserve physical proportions instead of averaging horizontal and vertical scale factors. Existing missing / `"output"` width modes retain their former output-pixel behavior.
- `strokeHidden` hides ink only. It keeps nodes, curves, width, color, region boundaries and fill assignments intact. Showing a stroke uses its retained width. Deleting an edge remains a separate geometry operation that can merge regions.
- Fine strokes may fall between output pixel centers at small sizes. Their counts are reported; no automatic blanket deletion of source strokes is introduced. Existing conservative raster cleanup still runs separately for each size.

## Manual inspection

The local stroke inspector is a limited editing surface: select an edge, hide/show it, find hidden edges, undo/redo, download the edited master or indexed BMP. Rendering runs in a worker using the same core, with topology cached across visibility edits. Downloading a master is explicit; the source image and saved input master are not automatically overwritten.

The full design editor, coloring UI and production acceptance remain separate work. The machine profile and fill colors in sample output are still placeholders.

## Older palettes

Old masters with more than six colors must be explicitly mapped to six or fewer entries. `remapMasterPalette(oldMaster, targetPalette, mapping)` remaps all face and edge colors, including hidden strokes, without mutating the old master. Mapping index `i` is the new palette index for old color `i`. Separate pixel-override or protected-color files must receive the same mapping before use; they are not embedded in a master. Normal loading and export reject oversized palettes rather than silently discarding colors.
