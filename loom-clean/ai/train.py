"""Train a tiny local defect detector on reproducible synthetic BMP-mask defects.

No source/final difference is treated as a supervised label. The separate design
split is fixed below. The test split is evaluated once, after model/threshold selection.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import time

import numpy as np
from PIL import Image
import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import Dataset, DataLoader

SEED = 240916
SPLITS = {"train": ["42482", "42850"], "validation": ["42973"], "test": ["45842"]}
PATCH = 64
HALO = 16


class Block(nn.Module):
    def __init__(self, a, b):
        super().__init__()
        self.layers = nn.Sequential(nn.Conv2d(a, b, 3, padding=1), nn.ReLU(),
                                    nn.Conv2d(b, b, 3, padding=1), nn.ReLU())

    def forward(self, x):
        return self.layers(x)


class TinyInkNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.down1 = Block(1, 16)
        self.down2 = Block(16, 32)
        self.bottom = Block(32, 64)
        self.up2 = Block(96, 32)
        self.up1 = Block(48, 16)
        self.head = nn.Conv2d(16, 2, 1)

    def forward(self, ink):
        a = self.down1(ink)
        b = self.down2(F.max_pool2d(a, 2))
        c = self.bottom(F.max_pool2d(b, 2))
        d = self.up2(torch.cat((F.interpolate(c, scale_factor=2, mode="nearest"), b), 1))
        e = self.up1(torch.cat((F.interpolate(d, scale_factor=2, mode="nearest"), a), 1))
        return self.head(e)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def neighbor_count(mask, radius=1):
    k = 2 * radius + 1
    padded = np.pad(mask.astype(np.int32), ((radius, radius), (radius, radius)))
    integral = np.pad(padded, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    return integral[k:, k:] - integral[:-k, k:] - integral[k:, :-k] + integral[:-k, :-k]


def load_artwork(folder, split):
    records = []
    for path in sorted(folder.glob("*.bmp")):
        if "complete" not in path.name.lower():
            continue
        design = next((n for n in SPLITS[split] if path.name.startswith(n)), None)
        if design is None:
            continue
        with Image.open(path) as im:
            rgb = np.asarray(im.convert("RGB"), dtype=np.uint32)
        packed = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
        colors, labels, counts = np.unique(packed, return_inverse=True, return_counts=True)
        labels = labels.reshape(packed.shape).astype(np.uint8)
        active = np.where(counts >= max(20, labels.size * 0.00005))[0]
        edge = np.zeros(labels.shape, dtype=bool)
        edge[1:, :] |= labels[1:, :] != labels[:-1, :]
        edge[:, 1:] |= labels[:, 1:] != labels[:, :-1]
        coords = np.argwhere(edge)
        if len(coords) > 100000:
            coords = coords[::math.ceil(len(coords) / 100000)]
        records.append({"labels": np.pad(labels, HALO * 2, mode="edge"),
                        "shape": list(labels.shape), "colors": active,
                        "coords": coords, "name": path.name, "design": design,
                        "sha256": sha256(path), "paletteSize": int(len(colors))})
    if not records:
        raise RuntimeError(f"No COMPLETE BMPs found for split {split}")
    return records


class DefectPatches(Dataset):
    """Native-grid masks; unchanged crops provide true tiny-detail negatives."""
    def __init__(self, records, length, seed, epoch=0):
        self.records, self.length, self.seed, self.epoch = records, length, seed, epoch

    def __len__(self):
        return self.length

    def __getitem__(self, index):
        rng = np.random.default_rng(self.seed + self.epoch * 1000003 + index * 997)
        for attempt in range(12):
            record = self.records[int(rng.integers(len(self.records)))]
            if rng.random() < 0.86:
                cy, cx = record["coords"][int(rng.integers(len(record["coords"])))]
                cy += int(rng.integers(-8, 9))
                cx += int(rng.integers(-8, 9))
            else:
                cy = int(rng.integers(record["shape"][0]))
                cx = int(rng.integers(record["shape"][1]))
            cy = int(np.clip(cy, 0, record["shape"][0] - 1))
            cx = int(np.clip(cx, 0, record["shape"][1] - 1))
            crop = record["labels"][cy:cy + PATCH, cx:cx + PATCH]
            present = np.intersect1d(np.unique(crop[HALO:-HALO, HALO:-HALO]), record["colors"])
            color = present[int(rng.integers(len(present)))]
            clean = (crop == color).astype(np.float32)
            if 0.015 < clean.mean() < 0.95 or attempt == 11:
                break
        clean = np.rot90(clean, int(rng.integers(4)))
        if rng.random() < 0.5:
            clean = np.fliplr(clean)
        clean = np.ascontiguousarray(clean)
        noisy = clean.copy()
        unchanged = rng.random() < 0.30
        if not unchanged:
            near = neighbor_count(clean, 1)
            context = neighbor_count(clean, 3)
            interior = np.zeros_like(clean, dtype=bool)
            interior[HALO + 2:-HALO - 2, HALO + 2:-HALO - 2] = True
            # Missing ink is removed only from supported thin strokes / boundaries;
            # a pre-existing standalone dot is not relabelled as a line defect.
            gap_candidates = np.argwhere(interior & (clean == 1) & (near >= 3) & (near <= 7) & (context >= 10))
            # Extra ink includes isolated specks and small protrusions near ink.
            speck_candidates = np.argwhere(interior & (clean == 0) & (near <= 4) & (context >= 1) & (context <= 35))
            for _ in range(int(rng.integers(1, 6))):
                gap = rng.random() < 0.5
                candidates = gap_candidates if gap else speck_candidates
                if not len(candidates):
                    continue
                y, x = candidates[int(rng.integers(len(candidates)))]
                width = int(rng.choice([1, 1, 1, 2, 2, 3]))
                dy, dx = [(0, 1), (1, 0), (1, 1), (1, -1)][int(rng.integers(4))]
                for step in range(width):
                    py, px = y + step * dy, x + step * dx
                    if HALO <= py < PATCH-HALO and HALO <= px < PATCH-HALO:
                        noisy[py, px] = 0.0 if gap else 1.0
        target = np.stack(((clean == 1) & (noisy == 0), (clean == 0) & (noisy == 1))).astype(np.float32)
        return torch.from_numpy(noisy[None]), torch.from_numpy(target), bool(unchanged)


def loss_fn(logits, ink, target):
    logits, ink, target = [x[:, :, HALO:-HALO, HALO:-HALO] for x in (logits, ink, target)]
    valid = torch.cat((1 - ink, ink), dim=1)
    weights = 1 + 23 * target
    loss = F.binary_cross_entropy_with_logits(logits, target, reduction="none")
    return (loss * weights * valid).sum() / valid.sum().clamp(min=1)


@torch.inference_mode()
def evaluate_hist(model, records, count, seed, batch_size, threads):
    dataset = DefectPatches(records, count, seed)
    loader = DataLoader(dataset, batch_size=batch_size, num_workers=0)
    hist = {"positive": np.zeros((2, 1001), dtype=np.int64),
            "negative": np.zeros((2, 1001), dtype=np.int64),
            "unchanged": np.zeros((2, 1001), dtype=np.int64)}
    model.eval()
    elapsed = time.perf_counter()
    for ink, target, unchanged in loader:
        scores = model(ink).sigmoid()[:, :, HALO:-HALO, HALO:-HALO].numpy()
        truth = target[:, :, HALO:-HALO, HALO:-HALO].numpy() > 0.5
        observed = ink[:, 0, HALO:-HALO, HALO:-HALO].numpy() > 0.5
        for head in range(2):
            valid = ~observed if head == 0 else observed
            bins = np.clip((scores[:, head] * 1000).astype(np.int32), 0, 1000)
            positive = valid & truth[:, head]
            negative = valid & ~truth[:, head]
            hist["positive"][head] += np.bincount(bins[positive], minlength=1001)
            hist["negative"][head] += np.bincount(bins[negative], minlength=1001)
            clean_only = negative & unchanged.numpy()[:, None, None]
            hist["unchanged"][head] += np.bincount(bins[clean_only], minlength=1001)
    hist["seconds"] = time.perf_counter() - elapsed
    hist["patches"] = count
    return hist


def metric_at(hist, head, threshold):
    cutoff = min(1001, math.ceil(threshold * 1000))
    tp = int(hist["positive"][head, cutoff:].sum())
    fp = int(hist["negative"][head, cutoff:].sum())
    total = int(hist["positive"][head].sum())
    unchanged_total = int(hist["unchanged"][head].sum())
    unchanged_fp = int(hist["unchanged"][head, cutoff:].sum())
    return {"threshold": threshold, "truePositive": tp, "falsePositive": fp,
            "falseNegative": total - tp, "positivePixels": total,
            "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / total if total else None,
            "unchangedDetailDamagePixels": unchanged_fp,
            "unchangedEligiblePixels": unchanged_total,
            "unchangedDetailDamagePer100k": unchanged_fp / max(1, unchanged_total) * 100000}


def select_threshold(hist, head, precision_target):
    candidates = [metric_at(hist, head, t / 1000) for t in range(500, 1000)]
    valid = [m for m in candidates if m["truePositive"] >= 20 and m["precision"] >= precision_target]
    if valid:
        best = max(valid, key=lambda m: (m["recall"], m["precision"]))
        return best["threshold"], True
    # Keep the head conservative and explicitly mark unmet acceptance criterion.
    nonempty = [m for m in candidates if m["truePositive"] >= 20]
    best = max(nonempty, key=lambda m: (m["precision"], m["recall"])) if nonempty else None
    return (best["threshold"] if best else 1.0), False


def save_json(path, obj):
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def deployment_policy(validation_metrics, qualified, precision_target):
    """Select enabled heads using validation only, never the held-out test."""
    names = ["add", "remove"]
    disabled = [name for name in names if not qualified[name]]
    calibrated = {name: validation_metrics[name]["threshold"] for name in names}
    reasons = {name: (f"Validation precision target {precision_target:.2%} was not met; "
                     f"best measurable candidate precision={validation_metrics[name]['precision']}, "
                     f"recall={validation_metrics[name]['recall']}. Head disabled before deployment.")
               for name in disabled}
    if disabled == ["add"]:
        qualification = "Noise-only review trial; line-add disabled by validation. Synthetic measurements do not establish real-artwork accuracy."
    elif len(disabled) == 2:
        qualification = "Both heads disabled because validation criteria were not met. Synthetic measurements do not establish real-artwork accuracy."
    else:
        qualification = "Trained and measured on synthetic defects; real artwork needs review."
    return {"thresholds": {name: (1.0 if name in disabled else calibrated[name]) for name in names},
            "calibratedThresholds": calibrated, "disabledHeads": disabled,
            "disabledHeadReasons": reasons, "qualification": qualification,
            "headEnablementPolicy": "Validation precision >= target and at least 20 true positives; test scores do not change enabled heads or thresholds."}


def main():
    parser = argparse.ArgumentParser()
    base = Path(__file__).resolve().parents[1]
    parser.add_argument("--samples", type=Path, default=base / "sample")
    parser.add_argument("--output", type=Path, default=base / "public" / "models")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--train-patches", type=int, default=8000)
    parser.add_argument("--validation-patches", type=int, default=2000)
    parser.add_argument("--test-patches", type=int, default=2000)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--precision-target", type=float, default=0.98)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    artifacts = Path(__file__).resolve().parent / "artifacts"
    artifacts.mkdir(exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    records = {s: load_artwork(args.samples, s) for s in SPLITS}
    manifest = {s: [{k: v for k, v in r.items() if k not in ("labels", "colors", "coords")} for r in rs] for s, rs in records.items()}
    save_json(artifacts / "dataset-manifest.json", manifest)
    model = TinyInkNet()
    parameter_count = sum(p.numel() for p in model.parameters())
    print(json.dumps({"parameters": parameter_count, "splits": {s: len(rs) for s, rs in records.items()}, "threads": args.threads}), flush=True)
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    history, best_loss = [], float("inf")
    checkpoint = artifacts / "best.pt"
    if args.resume:
        model.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True))
        print("Loaded existing checkpoint; skipping training", flush=True)
    else:
        started = time.perf_counter()
        for epoch in range(args.epochs):
            model.train()
            dataset = DefectPatches(records["train"], args.train_patches, SEED, epoch)
            loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=False, num_workers=0)
            loss_sum, step_count = 0.0, 0
            tick = time.perf_counter()
            for step, (ink, target, _) in enumerate(loader):
                optimizer.zero_grad(set_to_none=True)
                loss = loss_fn(model(ink), ink, target)
                loss.backward()
                optimizer.step()
                loss_sum += loss.item()
                step_count += 1
                if (step + 1) % 50 == 0:
                    print(json.dumps({"epoch": epoch + 1, "step": step + 1, "steps": len(loader), "loss": loss_sum / step_count, "elapsedSeconds": round(time.perf_counter() - tick, 1)}), flush=True)
            model.eval()
            val_sum, val_steps = 0.0, 0
            with torch.inference_mode():
                for ink, target, _ in DataLoader(DefectPatches(records["validation"], 512, SEED + 10000000), batch_size=args.batch_size):
                    val_sum += loss_fn(model(ink), ink, target).item()
                    val_steps += 1
            val_loss = val_sum / val_steps
            row = {"epoch": epoch + 1, "trainLoss": loss_sum / step_count, "validationLoss": val_loss, "seconds": time.perf_counter() - tick}
            history.append(row)
            if val_loss < best_loss:
                best_loss = val_loss
                torch.save(model.state_dict(), checkpoint)
            save_json(artifacts / "training-history.json", history)
            print(json.dumps(row), flush=True)
        print(json.dumps({"trainingSeconds": time.perf_counter() - started}), flush=True)
        model.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True))
    model.eval()
    validation = evaluate_hist(model, records["validation"], args.validation_patches, SEED + 10000000, args.batch_size, args.threads)
    selections = [select_threshold(validation, head, args.precision_target) for head in range(2)]
    thresholds = [s[0] for s in selections]
    validation_metrics = {name: metric_at(validation, head, thresholds[head]) for head, name in enumerate(["add", "remove"])}
    print(json.dumps({"validation": validation_metrics, "precisionTargetMet": [s[1] for s in selections]}), flush=True)
    # The test images have not influenced training, checkpoint selection or thresholds.
    test = evaluate_hist(model, records["test"], args.test_patches, SEED + 20000000, args.batch_size, args.threads)
    test_metrics = {name: metric_at(test, head, thresholds[head]) for head, name in enumerate(["add", "remove"])}
    print(json.dumps({"test": test_metrics}), flush=True)
    onnx_path = args.output / "loom-tiny-v1.onnx"
    sample = torch.from_numpy(DefectPatches(records["validation"], 1, SEED + 30000000)[0][0].numpy()[None])
    torch.onnx.export(model, sample, str(onnx_path), input_names=["ink"], output_names=["logits"],
                      opset_version=17, dynamo=False, do_constant_folding=True)
    import onnx
    import onnxruntime as ort
    onnx.checker.check_model(onnx.load(str(onnx_path)))
    ort_options = ort.SessionOptions()
    ort_options.intra_op_num_threads = args.threads
    session = ort.InferenceSession(str(onnx_path), sess_options=ort_options, providers=["CPUExecutionProvider"])
    with torch.inference_mode():
        expected = model(sample).numpy()
    actual = session.run(["logits"], {"ink": sample.numpy()})[0]
    max_error = float(np.abs(expected - actual).max())
    if max_error > 0.0001:
        raise RuntimeError(f"ONNX export differs from PyTorch: {max_error}")
    timings = []
    for i in range(22):
        tick = time.perf_counter()
        session.run(["logits"], {"ink": sample.numpy()})
        if i >= 2:
            timings.append((time.perf_counter() - tick) * 1000)
    model_info = {
        "id": "loom-tiny-v1", "name": "Loom Tiny v1", "version": 1, "experimental": True,
        "modelFile": "loom-tiny-v1.onnx",
        "qualification": "Trained and measured on synthetic defects; real artwork needs review",
        "architecture": "TinyInkNet shared encoder with add/remove logit heads",
        "parameters": parameter_count, "bytes": onnx_path.stat().st_size,
        "sha256": sha256(onnx_path), "opset": 17,
        "input": {"name": "ink", "dtype": "float32", "shape": [1, 1, 64, 64], "values": "0 background, 1 candidate palette ink; no RGB normalization"},
        "output": {"name": "logits", "dtype": "float32", "shape": [1, 2, 64, 64], "heads": ["add", "remove"], "activation": "sigmoid"},
        "validRegion": {"x": 16, "y": 16, "width": 32, "height": 32},
        **deployment_policy(validation_metrics, {"add": selections[0][1], "remove": selections[1][1]}, args.precision_target),
        "validationPrecisionTarget": args.precision_target,
        "validationPrecisionTargetMet": {"add": selections[0][1], "remove": selections[1][1]},
        "seed": SEED, "splits": SPLITS,
        "training": {"epochsRequested": args.epochs, "patchesPerEpoch": args.train_patches, "batchSize": args.batch_size, "learningRate": 0.001, "positiveLossWeight": 24, "unchangedPatchFraction": 0.30, "syntheticDefects": "1–3 pixel gaps and specks on native COMPLETE BMP binary color masks"},
        "evaluation": {"kind": "synthetic held-out corruptions only", "thresholdPolicy": "Metrics retain the validation-selected candidate thresholds, including disabled-head measurements; deployment thresholds and disabledHeads govern application use.", "validationPatches": args.validation_patches, "testPatches": args.test_patches, "validation": validation_metrics, "test": test_metrics},
        "exportVerification": {"maximumAbsoluteLogitError": max_error, "onnxCpuMedianPatchMs": float(np.median(timings)), "threads": args.threads, "notBrowserTiming": True},
        "provenance": manifest,
        "limitations": ["No real defect accuracy has been measured.", "Synthetic known edits are labels; source/final file differences are not labels.", "Ten artwork files represent only four design IDs.", "A one-channel mask cannot establish human intent for every dot, hole or crossing.", "Use only as an opt-in candidate reviewer alongside palette/source/topology constraints.", "Thresholds were selected on design 42973; design 45842 was evaluated only after selection."],
        "runtime": {"python": os.sys.version.split()[0], "torch": torch.__version__, "numpy": np.__version__, "onnx": onnx.__version__, "onnxruntime": ort.__version__}}
    save_json(args.output / "loom-tiny-v1.json", model_info)
    print(json.dumps({"model": str(onnx_path), "bytes": model_info["bytes"], "onnxMaxError": max_error, "medianPatchMs": model_info["exportVerification"]["onnxCpuMedianPatchMs"]}), flush=True)


if __name__ == "__main__":
    main()
