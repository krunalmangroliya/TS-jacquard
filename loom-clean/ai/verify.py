"""Verify deployed weights, static tensor contract, and uniform-mask behavior."""
from pathlib import Path
import hashlib
import json
import numpy as np
import onnx
import onnxruntime as ort


root = Path(__file__).resolve().parents[1]
card = json.loads((root / "public/models/loom-tiny-v1.json").read_text(encoding="utf-8"))
path = root / "public/models" / card["modelFile"]
assert path.stat().st_size == card["bytes"]
assert path.stat().st_size <= 1000000
assert hashlib.sha256(path.read_bytes()).hexdigest() == card["sha256"]
graph = onnx.load(str(path))
onnx.checker.check_model(graph)
session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
assert session.get_inputs()[0].name == "ink"
assert session.get_inputs()[0].shape == [1, 1, 64, 64]
assert session.get_outputs()[0].name == "logits"
assert session.get_outputs()[0].shape == [1, 2, 64, 64]
summary = {"sha256": card["sha256"], "bytes": card["bytes"],
           "onnxOperators": sorted(set(n.op_type for n in graph.graph.node)), "uniformMasks": []}
for value in (0.0, 1.0):
    ink = np.full((1, 1, 64, 64), value, dtype=np.float32)
    logits = session.run(["logits"], {"ink": ink})[0]
    assert np.isfinite(logits).all()
    scores = 1.0 / (1.0 + np.exp(-np.clip(logits, -60, 60)))
    core = scores[0, :, 16:48, 16:48]
    head = int(value)
    name = ["add", "remove"][head]
    edits = int((core[head] >= card["thresholds"][name]).sum())
    summary["uniformMasks"].append({"ink": value, "eligibleHead": name,
                                      "maximumProbability": float(core[head].max()), "edits": edits})
    assert edits == 0, f"Unexpected {name} proposals on a uniform mask"
(root / "ai/artifacts/verification.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
print(json.dumps(summary, indent=2))
