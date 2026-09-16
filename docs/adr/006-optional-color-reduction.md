# Preserve original colors and make reduction optional

The user supplied seven-color artwork whose two pink shades were merged by the previous six-color import limit. They asked to retain all seven colors when desired and choose color merges themselves. This decision supersedes the palette restriction in ADR 003; its stroke behavior remains unchanged.

Direct color import defaults to **Keep original colors**. It preserves each decoded RGB color when there are at most 256 distinct colors, the capacity of the application's 8-bit indexed raster and BMP representation. Palette order can change, but pixel RGB values do not. Transparency is still composited on white. Inputs with more than 256 decoded colors stop with an actionable message instead of silently quantizing.

**Reduce colors** explicitly enables the existing deterministic, nondithered quantizer with a user-selected limit from 1 to 256. The import preview shows the original and resulting counts. The editor provides explicit source and target choices for merging a palette color into another; undo restores the palette, source raster indices and size pixel overrides. Ground remains slot zero and can receive a merge; its reserved slot cannot be removed.

Validation, editing, protected colors, persistence, PNG output and 8-bit BMP export accept indices 0–255. Cleanup's temporary empty marker must be outside that range. New sketch masters still start with the existing six-entry workspace palette unless the user edits it in Settings.

Existing saved designs and exports retain their current palettes. A previously reduced six-color master cannot recover the missing distinction by adding a swatch: reimport its retained original source with **Keep original colors** to create a new master, then create the desired size. Cleanup and resizing remain separate operations and can still remove details at the chosen output resolution.
