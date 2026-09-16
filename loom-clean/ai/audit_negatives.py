"""Audit real detail retained in the unchanged synthetic-training negatives."""
from pathlib import Path
import argparse
import json
import numpy as np
from train import DefectPatches, load_artwork, neighbor_count, SEED, HALO


def components(mask, limit=16):
    seen = np.zeros_like(mask, dtype=bool)
    small = enclosed = 0
    height, width = mask.shape
    for y, x in np.argwhere(mask):
        if seen[y, x]:
            continue
        stack = [(int(y), int(x))]
        seen[y, x] = True
        size, touches_edge = 0, False
        while stack:
            cy, cx = stack.pop()
            size += 1
            touches_edge |= cy in (0, height-1) or cx in (0, width-1)
            for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        if size <= limit:
            small += 1
            enclosed += int(not touches_edge)
    return small, enclosed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--patches", type=int, default=2000)
    parser.add_argument("--update-model", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    patches = DefectPatches(load_artwork(root / "sample", "train"), args.patches, SEED)
    audit = {"sampledEpoch": 0, "sampledPatches": args.patches,
             "unchangedPatches": 0, "unchangedPatchesWithSmallInkComponents": 0,
             "unchangedPatchesWithEnclosedHoles": 0,
             "unchangedPatchesWithThinStrokePixels": 0,
             "method": "Geometry audit of unchanged COMPLETE-mask patches; small four-connected ink components <=4 pixels excluding core-edge components, enclosed background components <=16 pixels, thin pixels with 2-3 ink neighbors. Features can overlap; no semantic annotation is claimed."}
    for i in range(args.patches):
        ink, _, unchanged = patches[i]
        if not unchanged:
            continue
        audit["unchangedPatches"] += 1
        mask = ink.numpy()[0] > 0.5
        core = mask[HALO:-HALO, HALO:-HALO]
        _, small = components(core, 4)
        _, holes = components(~core, 16)
        neighbors = neighbor_count(mask, 1)[HALO:-HALO, HALO:-HALO]
        thin = core & (neighbors >= 3) & (neighbors <= 4)
        audit["unchangedPatchesWithSmallInkComponents"] += int(small > 0)
        audit["unchangedPatchesWithEnclosedHoles"] += int(holes > 0)
        audit["unchangedPatchesWithThinStrokePixels"] += int(thin.any())
    out = root / "ai" / "artifacts" / "negative-patch-audit.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    if args.update_model:
        card = root / "public" / "models" / "loom-tiny-v1.json"
        metadata = json.loads(card.read_text(encoding="utf-8"))
        metadata["negativePatchAudit"] = audit
        card.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(audit, indent=2), flush=True)


if __name__ == "__main__":
    main()
