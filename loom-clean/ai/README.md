# Tiny ink detector experiment

This is a trained patch model experiment, not a claim of production cleanup accuracy. The model predicts **add ink** and **remove ink** logits from a binary mask of one existing palette color. The cleanup engine owns replacement colors and geometric constraints.

See `MODEL_CARD.md` for the measured result. The first model's add head failed its validation target and is disabled. The remove head remains an optional review experiment; its precision fell on the unseen synthetic test design. Respect `disabledHeads` as well as thresholds.

## Reproduce

Run from `loom-clean`, using the isolated AI environment prepared for this experiment:

```powershell
.\.venv-ai\Scripts\python.exe ai\train.py --epochs 8 --train-patches 8000 --threads 4
.\.venv-ai\Scripts\python.exe ai\audit_negatives.py --patches 2000 --update-model
.\.venv-ai\Scripts\python.exe ai\verify.py
```

The script writes the real ONNX weights and a complete model card to `public/models/loom-tiny-v1.onnx` and `public/models/loom-tiny-v1.json`. Checkpoints and intermediate manifests remain in ignored `ai/artifacts`. Python requirements are PyTorch CPU, NumPy, Pillow, ONNX and ONNX Runtime; final exact versions are recorded in the model card.

Input: float32 `ink`, shape `[1,1,64,64]`, binary values. Output: float32 `logits`, shape `[1,2,64,64]`; channel 0 is add, channel 1 is remove. Apply sigmoid and the per-head thresholds from `loom-tiny-v1.json`. Only the central 32×32 area, starting at (16,16), is valid. Add predictions apply only to existing 0 pixels; remove predictions only to existing 1 pixels. Preserve the full 16-pixel context halo. No RGB normalization or whole-image resize is used.

The model is trained from a seeded random initialization; it contains no downloaded pretrained weights. The supplied artwork stays local. Pinned Python package versions are recorded in `requirements.txt` and in the resulting model card. Browser inference needs ONNX Runtime Web separately; its runtime assets are larger than the model weights.

Training uses native-resolution color masks from COMPLETE BMPs with known synthetic 1–3 pixel erasures and additions. Thirty percent of patches are completely unchanged negatives, retaining real dots, rings, thin strokes and crossings. Final-versus-input differences are never treated as clean labels: final files include recoloring and layout changes.

Fixed design split: train `42482` and `42850`; validation `42973`; test `45842`. The seed is 240916. Checkpoint selection and per-head precision threshold selection use validation only. The held-out test runs after those choices. File SHA-256 hashes, sizes, splits, parameters, metrics and export parity are in `loom-tiny-v1.json`.

Precision and recall refer only to artificially introduced, known defects. Unchanged-detail damage counts false edits on patches that received no corruption. An untouched pixel in an artificially damaged patch can also incur a false edit and contributes to false-positive counts. These metrics do not establish accuracy on real resizing defects or cleanup time saved.

Use the model for an optional review layer and compare accepted edits against the V2 baseline. A small model cannot infer human intent from every binary patch. Browser runtime and integration need independent verification; the recorded ONNX Runtime CPU timing is not a browser benchmark.
