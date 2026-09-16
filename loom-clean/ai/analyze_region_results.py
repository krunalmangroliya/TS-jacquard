"""Measure whole-field proposals using fixed, registered COMPLETE interiors.

Comparison baseline is V2 on the original PNG, never V2 on SIZED. COMPLETE
supplies geometry and a flatness target; its recolored RGB is not pixel truth.
Run from any directory with .venv-ai/Scripts/python.exe ai/analyze_region_results.py.
"""
from collections import deque
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from analyze_reference_regions import packed, oriented_reference, patch_stats

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/reference-regions"
CASES = [
    ("42482-pallu", "dancer-background-grain", "#e80088"),
    ("42482-pallu", "lower-instrument-diamond", "#90c890"),
    ("45842-pallu", "left-background-grain", "#080060"),
]


def hexcolor(color):
    return f"#{int(color):06x}"


def components(mask):
    seen = np.zeros(mask.shape, dtype=bool)
    height, width = mask.shape
    result = []
    for sy, sx in zip(*np.where(mask)):
        if seen[sy, sx]:
            continue
        seen[sy, sx] = True
        queue, points = deque([(int(sy), int(sx))]), []
        while queue:
            y, x = queue.popleft()
            points.append((y, x))
            for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                py, px = y + dy, x + dx
                if 0 <= py < height and 0 <= px < width and mask[py, px] and not seen[py, px]:
                    seen[py, px] = True
                    queue.append((py, px))
        result.append(np.array(points, dtype=np.int32))
    return sorted(result, key=len, reverse=True)


def interior(mask, radius=2):
    safe = mask.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            safe &= np.roll(mask, (dy, dx), (0, 1))
    safe[:radius] = safe[-radius:] = False
    safe[:, :radius] = safe[:, -radius:] = False
    return safe


def stats(labels, mask):
    colors, counts = np.unique(labels[mask], return_counts=True)
    order = np.argsort(-counts)
    horizontal = mask[:, 1:] & mask[:, :-1]
    vertical = mask[1:] & mask[:-1]
    edges = int(horizontal.sum() + vertical.sum())
    transitions = int((((labels[:, 1:] != labels[:, :-1]) & horizontal).sum()) +
                      (((labels[1:] != labels[:-1]) & vertical).sum()))
    return {"pixels": int(mask.sum()), "modalColor": hexcolor(colors[order[0]]),
            "minorityPixels": int(counts.sum() - counts.max()),
            "minorityFraction": float(1 - counts.max() / counts.sum()),
            "colors": [{"color": hexcolor(colors[i]), "pixels": int(counts[i])} for i in order],
            "adjacentPairs": edges, "transitions": transitions,
            "transitionDensity": transitions / max(1, edges)}


def provenance(path):
    return {"path": str(path.relative_to(ROOT)).replace("\\", "/"),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "modifiedUtc": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()}


def analyze(name, region_id, target_color):
    source_meta = json.loads((ROOT / f"output/sample-analysis/{name}.json").read_text())
    registered = json.loads((OUT / f"{name}.json").read_text())
    region = next(r for r in registered["regions"] if r["id"] == region_id)
    box = region["box"]
    x, y, w, h = [box[k] for k in ["x", "y", "width", "height"]]
    dx, dy = [region["registration"][k] for k in ["dx", "dy"]]
    paths = {"sized": ROOT / source_meta["files"]["sized"],
             "baseline": ROOT / f"output/sample-analysis/{name}-v2-full-source.bmp",
             "proposed": ROOT / f"output/region-experiment/{name}-regions.bmp",
             "complete": ROOT / source_meta["files"]["reference"]}
    images = {key: Image.open(path).convert("RGB") for key, path in paths.items()}
    assert images["baseline"].size == images["proposed"].size == images["sized"].size
    images["complete"] = oriented_reference(source_meta, images["complete"])
    crops = {key: image.crop((x, y, x + w, y + h)) for key, image in images.items() if key != "complete"}
    crops["complete"] = images["complete"].crop((x + dx, y + dy, x + dx + w, y + dy + h))
    labels = {key: packed(image) for key, image in crops.items()}
    ref_component = components(labels["complete"] == int(target_color[1:], 16))[0]
    full_mask = np.zeros((h, w), dtype=bool)
    full_mask[ref_component[:, 0], ref_component[:, 1]] = True
    safe = interior(full_mask)
    values = {key: stats(array, safe) for key, array in labels.items()}
    historical_v2_path = ROOT / f"output/sample-analysis/{name}-v2-full-sized.bmp"
    historical_v2_crop = Image.open(historical_v2_path).convert("RGB").crop((x, y, x+w, y+h))
    baseline_mode = int(values["baseline"]["modalColor"][1:], 16)
    proposed_mode = int(values["proposed"]["modalColor"][1:], 16)
    before_minority = safe & (labels["baseline"] != baseline_mode)
    after_minority = safe & (labels["proposed"] != proposed_mode)
    changed = labels["baseline"] != labels["proposed"]
    clusters = []
    for points in components(after_minority)[:30]:
        yy, xx = points[:, 0], points[:, 1]
        cluster_mask = np.zeros((h, w), dtype=bool)
        cluster_mask[yy, xx] = True
        clusters.append({"pixels": len(points), "box": {"x": int(x + xx.min()), "y": int(y + yy.min()),
                         "width": int(xx.max() - xx.min() + 1), "height": int(yy.max() - yy.min() + 1)},
                         "colors": stats(labels["proposed"], cluster_mask)["colors"]})
    outline_color = int(source_meta["settings"]["outlineColor"][1:], 16)
    outline = labels["baseline"] == outline_color
    result = {"id": name, "region": region_id, "box": box,
              "registration": region["registration"], "referenceColor": target_color,
              "referenceComponentPixels": int(full_mask.sum()), "safeInteriorPixels": int(safe.sum()),
              "boundaryExclusionPixels": 2, "stats": values,
              "historicalV2OnSized": {"stats": stats(packed(historical_v2_crop), safe),
                  "provenance": provenance(historical_v2_path),
                  "note": "Earlier reference-region analysis used this different baseline. Current proposals start from V2 original PNG (baseline), so do not mix the two improvement estimates."},
              "fullReferenceComponentStats": {key: stats(array, full_mask) for key, array in labels.items()},
              "referenceBoundaryBandStats": {key: stats(array, full_mask & ~safe) for key, array in labels.items()},
              "changesInsideSafeInterior": int((changed & safe).sum()),
              "baselineMinorityChanged": int((changed & before_minority).sum()),
              "minorityReductionFraction": 1 - after_minority.sum() / max(1, before_minority.sum()),
              "remainingMinorityComponents": len(components(after_minority)),
              "remainingLargestComponents": clusters,
              "outlinePreservation": {"baselineColor": hexcolor(outline_color),
                  "baselinePixelsInCrop": int(outline.sum()), "changedPixels": int((outline & changed).sum()),
                  "note": "Preservation of baseline designated outline pixels only; not a claim of line correctness."},
              "cropChangesByBaselineColor": [{"color": hexcolor(color),
                  "baselinePixels": int((labels["baseline"] == color).sum()),
                  "changedPixels": int(((labels["baseline"] == color) & changed).sum())}
                  for color in np.unique(labels["baseline"])],
              "provenance": {key: provenance(path) for key, path in paths.items()},
              "meaning": "A fixed COMPLETE flat component, eroded two pixels, tests region flatness without matching recolored RGB. Local registration has residual drawing differences; measurements are diagnostics, not production accuracy."}
    # Count the two source field colors throughout this crop as a supplementary
    # diagnostic. Unlike the reference-interior metric this includes contours,
    # intentional colored objects and local drawing mismatches.
    minority_colors = [int(item["color"][1:], 16) for item in values["baseline"]["colors"][1:]]
    result["cropMinorityColorCounts"] = {key: [{"color": hexcolor(color),
        "pixels": int((array == color).sum()),
        "outsideReferenceComponent": int(((array == color) & ~full_mask).sum()),
        "inReferenceBoundaryBand": int(((array == color) & full_mask & ~safe).sum())}
        for color in minority_colors] for key, array in labels.items() if key != "complete"}
    output_base = f"comparison-{name}-{region_id}"
    scale = 3
    sheet = Image.new("RGB", (4 * (w * scale + 16), h * scale + 88), "#f4f2e8")
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 5), f"{name} / {region_id} | x{x},y{y},{w}x{h} | fixed COMPLETE safe mask: {safe.sum()} pixels", fill="black")
    titles = {"sized": "SIZED (context only)", "baseline": "V2 on original PNG", "proposed": "Whole-area proposals", "complete": f"COMPLETE ({dx:+},{dy:+})"}
    for col, key in enumerate(["sized", "baseline", "proposed", "complete"]):
        left = col * (w * scale + 16) + 8
        draw.text((left, 26), titles[key], fill="black")
        draw.text((left, 43), f"minority {values[key]['minorityPixels']}; transitions {values[key]['transitionDensity']:.3%}", fill="black")
        sheet.paste(crops[key].resize((w * scale, h * scale), Image.Resampling.NEAREST), (left, 68))
    sheet.save(OUT / f"{output_base}.png")
    # Safe area + remaining minority distinguishes excluded contour bands from
    # genuinely granular pixels still present in a trusted flat interior.
    overlay = np.asarray(crops["proposed"]).copy()
    overlay[~safe] = (overlay[~safe].astype(np.float32) * 0.28).astype(np.uint8)
    overlay[after_minority] = [255, 255, 255]
    Image.fromarray(overlay).resize((w*4, h*4), Image.Resampling.NEAREST).save(OUT / f"{output_base}-remaining.png")
    (OUT / f"{output_base}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def preserved_pattern(region_id):
    """Reference-confirmed detail; original PNG repeat starts 1602px earlier."""
    name = "42850-pallu"
    metadata = json.loads((ROOT / f"output/sample-analysis/{name}.json").read_text())
    registered = json.loads((OUT / f"{name}.json").read_text())
    region = next(row for row in registered["regions"] if row["id"] == region_id)
    x, y, w, h = [region["box"][key] for key in ["x", "y", "width", "height"]]
    dx, dy = [region["registration"][key] for key in ["dx", "dy"]]
    paths = {"baseline": ROOT / f"output/sample-analysis/{name}-v2-full-source.bmp",
             "proposed": ROOT / f"output/region-experiment/{name}-regions.bmp",
             "complete": ROOT / metadata["files"]["reference"]}
    images = {key: Image.open(path).convert("RGB") for key, path in paths.items()}
    # Exact PNG-to-SIZED phase was separately proven over all 5,544,960 pixels.
    for key in ["baseline", "proposed"]:
        images[key] = Image.fromarray(np.roll(np.asarray(images[key]), 1602, axis=1))
    images["complete"] = oriented_reference(metadata, images["complete"])
    crops = {key: image.crop((x, y, x+w, y+h)) for key, image in images.items() if key != "complete"}
    crops["complete"] = images["complete"].crop((x+dx, y+dy, x+dx+w, y+dy+h))
    labels = {key: packed(image) for key, image in crops.items()}
    changes = labels["baseline"] != labels["proposed"]
    result = {"id": name, "region": region_id, "box": region["box"],
              "baselineAndProposedRollRight": 1602, "registration": region["registration"],
              "pixels": w*h, "changedPixels": int(changes.sum()),
              "stats": {key: patch_stats(array) for key, array in labels.items()},
              "provenance": {key: provenance(path) for key, path in paths.items()},
              "meaning": "Negative pattern example: hatching/veins visibly remain in COMPLETE despite recoloring. Tests additional proposal damage relative to V2; it does not certify preexisting V2 line accuracy."}
    scale = 3
    sheet = Image.new("RGB", ((w*scale+16)*3, h*scale+72), "#f4f2e8")
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 5), f"{name} / {region_id} | phase-corrected preserved pattern; changed pixels {changes.sum()}", fill="black")
    for i, key in enumerate(["baseline", "proposed", "complete"]):
        left = i*(w*scale+16)+8
        draw.text((left, 28), {"baseline": "V2 original PNG + roll 1602", "proposed": "Region proposals + roll 1602", "complete": f"COMPLETE ({dx:+},{dy:+})"}[key], fill="black")
        sheet.paste(crops[key].resize((w*scale, h*scale), Image.Resampling.NEAREST), (left, 52))
    base = f"comparison-{name}-{region_id}"
    sheet.save(OUT / f"{base}.png")
    (OUT / f"{base}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def gold_leaf_safety():
    """A detail guard case discovered beyond the flat-field crop boundary."""
    name = "45842-pallu"
    metadata = json.loads((ROOT / f"output/sample-analysis/{name}.json").read_text())
    paths = {"baseline": ROOT / f"output/sample-analysis/{name}-v2-full-source.bmp",
             "proposed": ROOT / f"output/region-experiment/{name}-regions.bmp",
             "complete": ROOT / metadata["files"]["reference"]}
    x, y, w, h, dy = 180, 408, 88, 80, 1
    images = {key: Image.open(path).convert("RGB") for key, path in paths.items()}
    images["complete"] = oriented_reference(metadata, images["complete"])
    crops = {key: image.crop((x, y+(dy if key == "complete" else 0), x+w, y+h+(dy if key == "complete" else 0)))
             for key, image in images.items()}
    labels = {key: packed(image) for key, image in crops.items()}
    changed = labels["baseline"] != labels["proposed"]
    gold = labels["baseline"] == 0xcda800
    component_rows = []
    for points in components(gold):
        yy, xx = points[:, 0], points[:, 1]
        damaged = changed[yy, xx]
        if len(points) < 20 and not damaged.any():
            continue
        reference_gold = labels["complete"][yy, xx] == 0xc8a800
        component_rows.append({"pixels": len(points),
            "box": {"x": int(x+xx.min()), "y": int(y+yy.min()),
                    "width": int(xx.max()-xx.min()+1), "height": int(yy.max()-yy.min()+1)},
            "changedPixels": int(damaged.sum()), "referenceGoldOverlap": int(reference_gold.sum()),
            "changedReferenceGoldOverlap": int((damaged & reference_gold).sum())})
    result = {"id": name, "region": "gold-leaf-safety", "box": {"x": x, "y": y, "width": w, "height": h},
        "registration": {"dx": 0, "dy": dy}, "baselineGoldColor": "#cda800", "referenceGoldColor": "#c8a800",
        "grainColor": "#cda902", "goldPixels": int(gold.sum()), "changedGoldPixels": int((changed & gold).sum()),
        "goldComponents": component_rows,
        "provenance": {key: provenance(path) for key, path in paths.items()},
        "meaning": "The coherent 63-pixel leaf at x211,y428 and 61-pixel leaf at x225,y433 are present in COMPLETE. Removed source pixels overlapping reference gold provide direct damage evidence. Other small gold components can be legitimate specks; local redraw prevents treating every mismatch as damage."}
    scale = 4
    sheet = Image.new("RGB", ((w*scale+16)*3, h*scale+60), "#f4f2e8")
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 5), f"45842-pallu / leaf guard | source solid-gold changed {result['changedGoldPixels']} pixels", fill="black")
    for i, key in enumerate(["baseline", "proposed", "complete"]):
        left = i*(w*scale+16)+8
        draw.text((left, 25), {"baseline": "V2 original PNG", "proposed": "Region proposals", "complete": "COMPLETE (0,+1)"}[key], fill="black")
        sheet.paste(crops[key].resize((w*scale, h*scale), Image.Resampling.NEAREST), (left, 48))
    base = "comparison-45842-pallu-gold-tip-safety"
    sheet.save(OUT / f"{base}.png")
    (OUT / f"{base}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = [analyze(*case) for case in CASES]
    negative_results = [preserved_pattern(name) for name in ["flower-hatching-preserved", "leaf-veins-preserved"]]
    leaf_guard = gold_leaf_safety()
    report_path = ROOT / "output/region-experiment/report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    summary = {"generatedAt": datetime.now(timezone.utc).isoformat(),
               "engineReport": {key: report.get(key) for key in ["generatedAt", "engineHash"]},
               "caution": "Candidate files may be newer than engineReport during iterative development; per-file hashes are authoritative.",
               "comparisons": results, "preservedPatterns": negative_results, "goldLeafSafety": leaf_guard}
    (OUT / "comparison-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    for row in results:
        a, b = row["stats"]["baseline"], row["stats"]["proposed"]
        print(f"{row['id']} {row['region']}: minority {a['minorityPixels']} -> {b['minorityPixels']}; transitions {a['transitionDensity']:.4%} -> {b['transitionDensity']:.4%}; outline changes {row['outlinePreservation']['changedPixels']}")
        print(" largest remaining:", row["remainingLargestComponents"][:5])


if __name__ == "__main__":
    main()
