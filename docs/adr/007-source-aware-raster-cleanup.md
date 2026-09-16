# Source-aware raster cleanup with explicit selection

The user compared a resized colored pallu with manual cleanup and observed that checkerboard removal damaged valid lines. They asked whether SAM 2 or similar processing could add the missing outline preservation and selective cleanup.

## Local implementation

New direct-image masters start with small-region removal, thin-detail removal, checkerboard removal and stroke connection disabled. Existing saved rules remain unchanged. Outline preservation and gap repair are explicit options for each size, with a user-selected outline color.

Original sampling remains the compatible resize mode. Preserve outline uses evidence from the source pixels when reducing resolution; it uses only existing palette indices. Gap repair considers small output gaps supported by the original outline. Neither operation invents missing artwork, and neither guarantees preservation of every feature at an arbitrarily small resolution. Parallel strokes, genuine gaps and protected pixels need regression coverage.

The source proof runs only when neither axis is enlarged and at least one is reduced. It examines at most 4,096 source pixels per local proof; unsupported scale combinations and larger patches retain ordinary sampling with a warning. Preservation protects the chosen outline from subsequent destructive cleanup. Added pixels can make lines thicker, so the final-size preview remains necessary.

Cleanup can be limited to selected colors and a rectangular area. The rectangle is stored as normalized coordinates so it follows the same design area when the output dimensions change. Color eligibility is based on the initial sampled grid, preventing later rule passes from expanding the selection. The selected area and colors restrict added outline-preservation changes and gap repairs as well as ordinary cleanup; the output dimensions still apply to the whole image. Protected colors and explicit pixel overrides keep their protections.

Palette merges remap the outline and cleanup color selections together with raster indices, protected colors and overrides. Save, undo/redo, retained versions and server export share the same rule configuration. The cleanup overlay reports pixel changes, which are review aids rather than a count of corrected defects.

Updating a size from its master remaps referenced colors by exact name and display/export RGB after replaying local edits. Missing, recolored or ambiguous references block adoption with guidance; the reserved ground color stays at index 0. The adopted master, rules and pixel overrides change together and undo together.

## Role of SAM

[SAM 2](https://ai.meta.com/research/sam2/) predicts object selection masks from clicks, boxes or masks. Its [image predictor](https://github.com/facebookresearch/sam2/blob/main/sam2/sam2_image_predictor.py) does not generate corrected indexed artwork. A useful future integration would return a selection mask, let the designer review it, and then apply the same pixel operations inside the accepted mask. The mask and source identity would need to be retained for deterministic exports.

The [official SAM 2 installation](https://github.com/facebookresearch/sam2/blob/main/INSTALL.md) needs a separate Python/PyTorch environment and recommends WSL Ubuntu on Windows. This PC's read-only runtime check found a GeForce GT 710 with 2 GB memory, driver 472.12 reporting CUDA 11.4, and no installed torch, torchvision or SAM packages. No model or AI service is installed by this change. CPU inference performance has not been measured.

For this release, exact color/rectangle selection and source-supported pixel processing work locally in the existing worker. Automatic semantic classification of decoration versus noise and click-to-select SAM masks remain future capabilities; the interface must not claim they are active.
