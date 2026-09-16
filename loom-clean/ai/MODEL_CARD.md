# Loom Tiny v1 — measured experiment

**Current use: optional noise-removal review only.** The line-add head is disabled because it did not meet the validation precision target. This experiment does not establish production cleanup accuracy.

The shared CNN was trained locally from random initialization on binary masks of existing colors from the user-provided COMPLETE BMPs. There are **118,002 parameters**. The exported ONNX file is **477,714 bytes**, excluding the ONNX Runtime Web assets. No pretrained model or remote inference service is involved.

## Data and labels

Training: design IDs **42482, 42850** (5 files). Validation and threshold selection: **42973** (3 files). Untouched test, evaluated after checkpoint/threshold selection: **45842** (2 files).

Labels are known synthetic 1–3 pixel gaps and specks added to native-grid binary masks. Source-versus-completed image differences are not labels. Eight epochs used 8,000 generated patches per epoch, seed 240916, batch size 32, and four CPU threads. Training took 609.6 seconds on this machine. Epoch 8 had the lowest validation loss.

Thirty percent of crops are unchanged negatives. An audit of the first 2,000 training crops found 592 unchanged crops: 6 contained small interior ink components (up to 4 pixels), 48 contained enclosed small holes, and 490 contained thin-stroke pixels. These geometric groups overlap and are not semantic annotations of dots or rings.

## Synthetic measurements

Thresholds were selected on validation with a target of at least 98% precision and 20 true-positive pixels. Results below retain the selected candidate thresholds so the disabled head's weakness remains visible.

| Head | Candidate threshold | Validation precision / recall | Test precision / recall | Test true / false positives |
| --- | --- | --- | --- | --- |
| Add ink | 0.988 | 95.24% / 1.43% | 89.36% / 1.57% | 42 / 5 |
| Remove ink | 0.995 | 98.15% / 29.52% | 91.76% / 32.62% | 1,036 / 93 |

Each split used 2,000 patches. On completely unchanged test crops, add proposed zero false edits and remove proposed 21. False positives elsewhere in corrupted patches are also included in the table. These scores measure artificially introduced defects, not real resizing artifacts. The lower test removal precision shows limited transfer to the unseen design.

**Deployment policy:** `thresholds.add = 1.0`, `thresholds.remove = 0.995`, and `disabledHeads = ["add"]`. The add head failed validation, so the application must skip it. The original measured thresholds remain in `calibratedThresholds`. Neither enabled heads nor thresholds were retuned after inspecting test results. Removal proposals require explicit review and the engine's palette/protection constraints.

## Contract and verification

Input `ink`: float32 `[1,1,64,64]`, binary candidate-color mask. Output `logits`: float32 `[1,2,64,64]`, add then remove. Apply sigmoid, eligibility by current ink value, per-head threshold, and disabled-head policy. Only central coordinates `[16,48)` on both axes are writable. Sigmoid values are model scores, not calibrated probabilities of correctness.

ONNX checker, file hash, static shapes, and uniform-mask behavior passed. ONNX/PyTorch maximum absolute logit difference was **0.00000334**. Median ONNX Runtime CPU inference was **1.145 ms per patch** across 20 measured runs after warm-up, using four threads. This is not a browser timing or whole-image processing benchmark.

Model SHA-256: `bbfb717035362989098cf3207fea94a1556ea2accac7237b1d15bf9809d83b2b`.

Reproduction commands and limitations are in `README.md`; complete per-file hashes, counts, software versions and metrics are in `public/models/loom-tiny-v1.json`. Four data-integrity and deployment-policy checks passed. Real-artwork comparison with the V2 engine is a separate evaluation and must not be inferred from these synthetic results.
