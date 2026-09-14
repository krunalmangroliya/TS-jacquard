# Your sample images

Put your clean black-and-white **PNG** files here, up to 8192 pixels per side and 40 million pixels total. The importer composites transparency over white. Originals are never edited or downscaled.

Run `pnpm sample` from the project root. It processes every PNG in this folder and creates reviews in `output/samples/`. If no PNG is present, it uses the AI-generated paisley in `eval/references/`.

These first trials use automatic placeholder colors and a placeholder loom profile. They test tracing and resizing, not final yarn choices or accepted NedGraphics output.

For a different folder: `pnpm sample --input-dir "your-folder"`.
For your machine: `pnpm sample --profile configs/your-machine.json`.

Reviewed per-image settings can be saved in a sibling `image-name.jdm.json`. `sample-1.jdm.json` keeps threshold157, disabled gap closure, panel mode, and300/1200/2400-hook trial sizes. `pnpm sample` uses these automatically; explicit CLI flags override them.
