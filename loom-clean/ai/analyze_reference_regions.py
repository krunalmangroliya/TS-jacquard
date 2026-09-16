"""Palette-independent regional labels from supplied completed artwork.

This analysis writes review artifacts only; it does not alter the cleanup app or
train a model. Pixel coordinates refer to the authoritative SIZED grid.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/reference-regions"
IDS = ["42482-pallu", "45842-daman", "45842-pallu", "42850-pallu"]
REGIONS = {
    "42482-pallu": [
        ("dancer-background-grain", (144, 336, 144, 112), (0, 3)),
        ("upper-diamond-grain", (120, 40, 144, 88), (0, 2)),
        ("lower-instrument-diamond", (252, 668, 160, 112), (0, 4)),
    ],
    "45842-daman": [
        ("musician-grain-phase-aligned", (704, 152, 144, 112), (0, -96)),
        ("canopy-detail-simplification", (80, 120, 152, 144), (0, 0)),
    ],
    "45842-pallu": [
        ("left-background-grain", (96, 288, 144, 144), (0, 0)),
        ("right-background-and-elephant", (528, 336, 144, 112), (0, 0)),
        ("dancer-background", (272, 552, 144, 144), (0, 0)),
    ],
    "42850-pallu": [
        ("flower-hatching-preserved", (1488, 1632, 144, 112), (0, 2)),
        ("leaf-veins-preserved", (2112, 528, 144, 112), (0, 2)),
    ],
}


def rgbhex(rgb):
    return "#" + "".join(f"{int(c):02x}" for c in rgb)


def packed(image):
    a = np.asarray(image, dtype=np.uint32)
    return (a[:, :, 0] << 16) | (a[:, :, 1] << 8) | a[:, :, 2]


def unpack(value):
    return [int(value >> 16), int((value >> 8) & 255), int(value & 255)]


def source_repeat_phase(source_image, target):
    """Recover a circular horizontal repeat offset, without editing any pixels."""
    source = packed(source_image.resize(target.size, Image.Resampling.NEAREST))
    dest = packed(target)
    width = source.shape[1]
    bands = [("whole", 0, source.shape[0])]
    results = []
    for label, y0, y1 in bands:
        a, b = source[y0:y1:4, ::4], dest[y0:y1:4, ::4]
        colors, counts = np.unique(b, return_counts=True)
        spectrum = np.zeros(a.shape[1] // 2 + 1, dtype=np.complex128)
        for color in colors[np.argsort(counts)[-12:]]:
            fa = np.fft.rfft(a == color, axis=1)
            fb = np.fft.rfft(b == color, axis=1)
            spectrum += (fa.conj() * fb).sum(axis=0)
        coarse = int(np.fft.irfft(spectrum, n=a.shape[1]).argmax()) * 4
        best = (-1, None)
        for phase in range(coarse - 7, coarse + 8):
            agreement = float((np.roll(source[y0:y1], phase, axis=1) == dest[y0:y1]).mean())
            if agreement > best[0]:
                best = (agreement, phase % width)
        results.append({"band": label, "y0": y0, "y1": y1, "rollSourceRightBy": best[1], "rgbAgreement": best[0]})
    return results


def patch_stats(labels):
    colors, count = np.unique(labels, return_counts=True)
    p = count / labels.size
    order = np.argsort(count)[::-1]
    tx = int((labels[:, 1:] != labels[:, :-1]).sum())
    ty = int((labels[1:] != labels[:-1]).sum())
    denominator = labels.shape[0] * max(0, labels.shape[1] - 1) + labels.shape[1] * max(0, labels.shape[0] - 1)
    return {"colors": len(colors), "dominantFraction": float(p.max()),
            "dominantColor": rgbhex(unpack(int(colors[order[0]]))),
            "topTwoFraction": float(p[order[:2]].sum()),
            "entropyBits": float(-(p * np.log2(p)).sum()),
            "transitions": tx + ty, "transitionDensity": (tx + ty) / max(1, denominator)}


def oriented_reference(metadata, image):
    orientation = metadata["pairComparison"]["referenceOrientation"]
    image = image.rotate(-orientation["clockwiseDegrees"], expand=True)
    if orientation["mirroredHorizontally"]:
        image = ImageOps.mirror(image)
    return image


def local_offset(source, reference, box, initial, source_ink, reference_ink, palette_map=None):
    """Match structure using explicit palette correspondence, not raw RGB."""
    x, y, w, h = box
    x0, y0 = max(0, x - 12), max(0, y - 12)
    x1, y1 = min(source.shape[1], x + w + 12), min(source.shape[0], y + h + 12)
    mask = source[y0:y1, x0:x1] == source_ink
    mapped = None
    if palette_map:
        mapped = np.full(mask.shape, 0x1000000, dtype=np.uint32)
        for old, new in palette_map.items():
            mapped[source[y0:y1, x0:x1] == old] = new
    scores = []
    for dy in range(initial[1] - 8, initial[1] + 9):
        for dx in range(initial[0] - 8, initial[0] + 9):
            if x0 + dx < 0 or y0 + dy < 0 or x1 + dx > reference.shape[1] or y1 + dy > reference.shape[0]:
                continue
            ref_crop = reference[y0 + dy:y1 + dy, x0 + dx:x1 + dx]
            if mapped is not None:
                score = float((mapped == ref_crop).sum() / max(1, (mapped != 0x1000000).sum()))
            else:
                ref = ref_crop == reference_ink
                positive = 2 * (mask & ref).sum() / max(1, mask.sum() + ref.sum())
                negative = 2 * (~mask & ~ref).sum() / max(1, (~mask).sum() + (~ref).sum())
                score = float((positive + negative) / 2)
            scores.append((score, dx, dy))
    scores.sort(key=lambda item: (-item[0], abs(item[1]-initial[0])+abs(item[2]-initial[1])))
    score, dx, dy = scores[0]
    return {"dx": dx, "dy": dy, "structuralScore": score,
            "scoreMethod": "palette correspondence agreement" if mapped is not None else "balanced outline-mask Dice",
            "searchAround": list(initial), "radius": 8, "sourceAnchorColor": rgbhex(unpack(source_ink)),
            "referenceAnchorColor": rgbhex(unpack(reference_ink)),
            "note": "Local structure correspondence after orientation. Single translation is recorded, not claimed as an exact warp."}


def global_registered(name, metadata, image, size):
    ref = np.asarray(oriented_reference(metadata, image))
    width, height = size
    dx, dy = [metadata["pairComparison"]["offset"][key] for key in ("dx", "dy")]
    yy, xx = np.meshgrid(np.arange(height), np.arange(width), indexing="ij")
    ry = yy + dy
    rx = xx + dx
    if name == "45842-daman":
        # The completed strip is an exact 208-row repeat. Match the supplied
        # SIZED phase without applying that shift to the central canopy panel.
        ry = np.where(xx >= 650, (yy - 96) % height, ry)
    valid = (ry >= 0) & (ry < ref.shape[0]) & (rx >= 0) & (rx < ref.shape[1])
    registered = ref[np.clip(ry, 0, ref.shape[0]-1), np.clip(rx, 0, ref.shape[1]-1)]
    return Image.fromarray(registered), valid


def palette_correspondence(source, reference, valid):
    """Stable 3x3 interiors give useful many-to-one recolor correspondence."""
    stable = valid.copy()
    for dy, dx in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
        stable &= source == np.roll(source, (dy, dx), (0, 1))
        stable &= reference == np.roll(reference, (dy, dx), (0, 1))
    stable[[0, -1], :] = False
    stable[:, [0, -1]] = False
    result = []
    for color in np.unique(source):
        target, counts = np.unique(reference[stable & (source == color)], return_counts=True)
        if counts.sum() < 20:
            continue
        order = np.argsort(counts)[::-1]
        result.append({"sourceColor": rgbhex(unpack(int(color))), "stablePixels": int(counts.sum()),
                       "correspondences": [{"referenceColor": rgbhex(unpack(int(target[i]))),
                                            "pixels": int(counts[i]), "fraction": float(counts[i]/counts.sum())}
                                           for i in order[:4]]})
    return result


def scan_flattened(source, v2, reference, valid):
    positives, retained_texture, recolor_only = [], [], []
    mask = np.zeros(source.shape, dtype=np.uint8)
    for window in [16, 32]:
        for y in range(0, source.shape[0] - window+1, window//2):
            for x in range(0, source.shape[1] - window+1, window//2):
                if not valid[y:y+window, x:x+window].all():
                    continue
                a, b, c = [patch_stats(image[y:y+window, x:x+window]) for image in (source, v2, reference)]
                row = {"x": x, "y": y, "width": window, "height": window, "sized": a, "v2": b, "complete": c}
                if a["transitionDensity"] >= 0.18 and a["entropyBits"] >= 0.6 and c["dominantFraction"] >= 0.98:
                    positives.append(row)
                    mask[y:y+window, x:x+window] = 255
                elif a["transitionDensity"] >= 0.18 and c["transitionDensity"] >= 0.12:
                    retained_texture.append(row)
                elif a["dominantFraction"] >= 0.98 and c["dominantFraction"] >= 0.98 and a["dominantColor"] != c["dominantColor"]:
                    recolor_only.append(row)
    return {"windows": [16,32], "strides": [8,16], "criteria": "sized transition density >=0.18 and entropy>=0.6; COMPLETE dominant fraction>=0.98",
            "positivePatchCount": len(positives), "positiveUnionPixels": int((mask > 0).sum()),
            "retainedTexturePatchCount": len(retained_texture), "flatRecolorOnlyPatchCount": len(recolor_only),
            "positivePatches": positives, "retainedTexturePatches": retained_texture[:120],
            "flatRecolorOnlyPatches": recolor_only[:120]}, mask


def component_region_labels(source, v2, reference):
    """A flat COMPLETE region supplies the mask, independent of its RGB name.

    Erode the evaluation interior to avoid counting a shifted boundary as grain.
    Keep the full component separately as a region segmentation target.
    """
    height, width = reference.shape
    seen = np.zeros(reference.shape, dtype=bool)
    region_label = np.zeros(reference.shape, dtype=np.uint8)
    valid_label = np.zeros(reference.shape, dtype=np.uint8)
    regions = []
    for sy in range(height):
        for sx in range(width):
            if seen[sy, sx]:
                continue
            color = reference[sy, sx]
            stack, points = [(sy, sx)], []
            seen[sy, sx] = True
            while stack:
                y, x = stack.pop()
                points.append((y, x))
                for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
                    py, px = y+dy, x+dx
                    if 0 <= py < height and 0 <= px < width and not seen[py,px] and reference[py,px] == color:
                        seen[py,px] = True
                        stack.append((py,px))
            if len(points) < 64:
                continue
            region = np.zeros(reference.shape, dtype=bool)
            for y, x in points:
                region[y,x] = True
            safe = region.copy()
            for dy in range(-2,3):
                for dx in range(-2,3):
                    safe &= np.roll(region, (dy,dx), (0,1))
            safe[:2] = safe[-2:] = False
            safe[:,:2] = safe[:,-2:] = False
            if safe.sum() < 40:
                continue
            neighbors_x = safe[:,1:] & safe[:,:-1]
            neighbors_y = safe[1:] & safe[:-1]
            comparisons = int(neighbors_x.sum() + neighbors_y.sum())
            values, counts = np.unique(source[safe], return_counts=True)
            p = counts/counts.sum()
            entropy = float(-(p*np.log2(p)).sum())
            density = []
            for image in [source,v2,reference]:
                transitions = int(((image[:,1:] != image[:,:-1]) & neighbors_x).sum() + ((image[1:] != image[:-1]) & neighbors_y).sum())
                density.append(transitions/max(1,comparisons))
            if density[0] < 0.10 or entropy < 0.25:
                continue
            region_label[region] = 255
            valid_label[safe] = 255
            regions.append({"referenceColor":rgbhex(unpack(int(color))), "componentPixels":len(points),
                            "safeInteriorPixels":int(safe.sum()), "sourceInteriorColors":len(values),
                            "sourceInteriorEntropyBits":entropy, "sourceTransitionDensity":density[0],
                            "v2TransitionDensity":density[1], "completeTransitionDensity":density[2],
                            "boundaryExclusionPixels":2})
    return {"regions":regions, "regionPixels":int((region_label>0).sum()),
            "validInteriorPixels":int((valid_label>0).sum()),
            "labelMeaning":"Whole flat COMPLETE components whose aligned source interiors remain textured, independent of target RGB. Boundary band is excluded from quantitative texture comparison."}, region_label, valid_label


def crop_sheet(name, title, box, images, metadata, initial, palette_map=None):
    x, y, w, h = box
    source = packed(images["sized"])
    complete = oriented_reference(metadata, images["reference"])
    reference = packed(complete)
    source_ink = int(metadata["settings"]["outlineColor"][1:], 16)
    reference_ink = int(metadata["outlineSelection"]["completedCorrespondence"]["color"][1:], 16)
    registration = local_offset(source, reference, box, initial, source_ink, reference_ink, palette_map)
    dx, dy = registration["dx"], registration["dy"]
    source_image = images["source"]
    lineage = metadata["sourceResizeLineage"]["best"]
    source_image = source_image.rotate(-lineage["clockwiseDegrees"], expand=True)
    if lineage["mirroredHorizontally"]:
        source_image = ImageOps.mirror(source_image)
    source_image = source_image.resize(images["sized"].size, Image.Resampling.NEAREST)
    phase = metadata.get("sourceRepeatPhase", 0)
    if phase:
        source_image = Image.fromarray(np.roll(np.asarray(source_image), phase, axis=1))
    crops = [source_image.crop((x, y, x+w, y+h)), images["sized"].crop((x, y, x+w, y+h)),
             images["v2"].crop((x, y, x+w, y+h)), complete.crop((x+dx, y+dy, x+dx+w, y+dy+h))]
    labels = [f"PNG target grid + x roll {phase}" if phase else "PNG on target grid", "SIZED input", "V2 on SIZED", f"COMPLETE dx={dx}, dy={dy}"]
    scale = 3
    sheet = Image.new("RGB", ((w * scale + 16) * 4, h * scale + 62), "#f4f2e8")
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 5), f"{name} | {title} | native box x{x}, y{y}, {w}x{h}; nearest 3x display", fill="black")
    for i, (crop, label) in enumerate(zip(crops, labels)):
        left = i * (w*scale + 16) + 8
        draw.text((left, 28), label, fill="black")
        sheet.paste(crop.resize((w*scale, h*scale), Image.Resampling.NEAREST), (left, 52))
        crop.save(OUT / f"{name}-{title}-{i}.png")
    filename = f"{name}-{title}.png"
    sheet.save(OUT / filename)
    labels_info, region_label, valid_label = component_region_labels(*[packed(crop) for crop in crops[1:]])
    Image.fromarray(region_label).save(OUT / f"{name}-{title}-region-label.png")
    Image.fromarray(valid_label).save(OUT / f"{name}-{title}-valid-interior.png")
    return {"id": title, "box": {"x": x, "y": y, "width": w, "height": h},
            "registration": registration, "file": filename,
            "referenceRegionLabels":labels_info,
            "statistics": {key: patch_stats(packed(crop)) for key, crop in zip(["pngTargetGrid", "sized", "v2", "complete"], crops)}}


def load_case(name):
    metadata = json.loads((ROOT / "output/sample-analysis" / (name + ".json")).read_text())
    images = {key: Image.open(ROOT / path).convert("RGB") for key, path in metadata["files"].items()}
    images["v2"] = Image.open(ROOT / "output/sample-analysis" / (name + "-v2-full-sized.bmp")).convert("RGB")
    return metadata, images


def overview(name, images):
    panels = []
    for key in ["sized", "v2", "reference"]:
        image = images[key].copy()
        image.thumbnail((560, 660), Image.Resampling.NEAREST)
        panel = Image.new("RGB", (584, 706), "#f4f2e8")
        ImageDraw.Draw(panel).text((12, 8), f"{name} | {key} {images[key].size}", fill="black")
        panel.paste(image, (12, 32))
        panels.append(panel)
    sheet = Image.new("RGB", (584 * 3, 706), "white")
    for i, panel in enumerate(panels):
        sheet.paste(panel, (584 * i, 0))
    sheet.save(OUT / f"{name}-overview.png")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    reports = []
    for name in IDS:
        metadata, images = load_case(name)
        phase = source_repeat_phase(images["source"], images["sized"])[0] if name == "42850-pallu" else None
        if phase:
            metadata["sourceRepeatPhase"] = phase["rollSourceRightBy"]
        overview(name, images)
        registered, valid = global_registered(name, metadata, images["reference"], images["sized"].size)
        src, v2, ref = [packed(im) for im in (images["sized"], images["v2"], registered)]
        scan, mask = scan_flattened(src, v2, ref, valid)
        Image.fromarray(mask).save(OUT / f"{name}-flatten-region-label.png")
        overlay = np.asarray(images["sized"]).copy()
        overlay[mask > 0] = (overlay[mask > 0].astype(np.float32)*0.45 + np.array([255, 45, 120])*0.55).astype(np.uint8)
        Image.fromarray(overlay).save(OUT / f"{name}-flatten-region-overlay.png")
        palette = palette_correspondence(src, ref, valid)
        palette_map = {int(p["sourceColor"][1:],16):int(p["correspondences"][0]["referenceColor"][1:],16) for p in palette} if name == "42850-pallu" else None
        regions = [crop_sheet(name, title, box, images, metadata, initial, palette_map) for title, box, initial in REGIONS[name]]
        # Include the strongest candidate interior, so the measurements show
        # texture disappearance independently of any chosen replacement RGB.
        strongest = sorted(scan["positivePatches"], key=lambda p: p["sized"]["transitionDensity"], reverse=True)
        if strongest:
            p = strongest[0]
            x, y = max(8, p["x"]-32), max(8, p["y"]-32)
            x = min(x, images["sized"].width-112)
            y = min(y, images["sized"].height-112)
            initial = (0, -96) if name == "45842-daman" and x >= 650 and y >= 96 else tuple(metadata["pairComparison"]["offset"][k] for k in ("dx", "dy"))
            regions.append(crop_sheet(name, "strong-flat-reference-interior", (x, y, 104, 104), images, metadata, initial))
        report = {"id": name, "files": metadata["files"], "orientation": metadata["pairComparison"]["referenceOrientation"],
                  "globalOffset": metadata["pairComparison"]["offset"], "additionalRegistration": "right strip x>=650 shifted -96 rows modulo416; exact208-row repeat" if name == "45842-daman" else None,
                  "sourceResizeLineage": metadata["sourceResizeLineage"]["best"], "paletteCorrespondence": palette,
                  "sourceRepeatPhaseCorrection": phase,
                  "scan": scan, "regions": regions,
                  "interpretation": "Reference-derived region supervision, independent of replacement color. Whole-image scan is weak supervision; inspected local crops anchor specific positive/negative regions. No per-pixel cleanup-accuracy claim."}
        (OUT / f"{name}.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
        reports.append(report)
        print(json.dumps({"id": name, **{k: v for k, v in scan.items() if not isinstance(v, list)}}), flush=True)
    (OUT / "manifest.json").write_text(json.dumps(reports, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
