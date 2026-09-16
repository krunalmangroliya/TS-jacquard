# Small-model decision for indexed jacquard cleanup

Research date: 2026-09-15. Planning only; no model, package or service was installed.

## Recommendation after comparing alternatives

First improve and measure the existing pixel pipeline. If the remaining problem is deciding whether a tiny component is decoration or noise, trial a small **candidate classifier** trained on reviewed examples. If the remaining problem is selecting a complex multicolor motif, trial **MobileSAM for selection only**. EdgeTAM is a second selection candidate if MobileSAM fails that measured task; its phone benchmark does not establish performance on this Windows PC.

This is a conditional engineering recommendation, not evidence that either model improves these BMPs. No model has been run on them. The previous file comparison used different repeat layouts and output heights, so it cannot supply aligned training labels directly. See `output/bmp-comparison-20260915/analysis.md`.

## What is known locally

The previous hardware check recorded a GeForce GT 710 with 2 GB memory, driver 472.12 reporting CUDA 11.4, and no installed PyTorch/SAM packages. See `docs/adr/007-source-aware-raster-cleanup.md`. Plan for CPU operation; GPU acceleration must be demonstrated rather than assumed. This does not establish that CPU inference is too slow or that no GPU configuration could work.

The app already offers exact color and rectangular selection, source-supported outline preservation and gap repair. A segmentation model adds value only if it reduces the work needed to select a useful region that those controls cannot express easily. It does not replace output-grid geometry, palette decisions or pixel repair.

## Three candidates

| Candidate | Verified facts | Expected role and unresolved work |
| --- | --- | --- |
| **MobileSAM** | The official repository reports 9.66 million total parameters, Python >=3.8, PyTorch >=1.7, torchvision >=0.8, and a CPU demonstration. Its reported approximately 3-second Mac i5 run is an author benchmark, not this PC's result. [Repository](https://github.com/ChaoningZhang/MobileSAM). Official `mobile_sam.pt` is listed as 38.8 MB. [Weights](https://github.com/ChaoningZhang/MobileSAM/blob/master/weights/mobile_sam.pt). Repository license: Apache-2.0. [License](https://github.com/ChaoningZhang/MobileSAM/blob/master/LICENSE). | Optional click/box selection of a flower, figure or other multicolor motif. Pretrained weights avoid initial domain training, but textile mask quality is unverified. First candidate for a selection experiment because CPU use is documented. |
| **EdgeTAM** | Official code supports prompted static-image masks and video tracking; requires Python >=3.10, torch >=2.3.1 and torchvision >=0.18.1. Published fast on-device results concern iPhone hardware. CoreML export targets Apple devices; code and checkpoints are Apache-2.0. [Repository](https://github.com/facebookresearch/EdgeTAM). Official checkpoint is listed as 53.5 MB. [Weights](https://github.com/facebookresearch/EdgeTAM/blob/main/checkpoints/edgetam.pt). CUDA extension building can be disabled via `SAM2_BUILD_CUDA=0`. [Setup source](https://github.com/facebookresearch/EdgeTAM/blob/main/setup.py). | A challenger for selection quality, not a reason to introduce video infrastructure. The reviewed official setup does not establish an end-to-end Windows ONNX or measured CPU deployment. A CPU-compatible path needs a real smoke test; disabling the extension alone does not prove every prediction path works. |
| **Small supervised candidate classifier** | A bounded-depth random forest is available in scikit-learn and can score feature vectors; depth and tree count control its size. [Classifier documentation](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.RandomForestClassifier.html). `sklearn-onnx` lists RandomForestClassifier conversion support. [Converter support](https://onnx.ai/sklearn-onnx/supported.html). ONNX Runtime Node has prebuilt Windows x64 CPU support. [Runtime](https://onnxruntime.ai/docs/get-started/with-javascript/node.html). | Proposed task-specific model, with **no pretrained jacquard weights identified in this review**. It would rank or reject proposed pixel edits, not paint RGB imagery. CPU training/inference is plausible, but accuracy, artifact size and total runtime must be measured. This targets the decoration-versus-defect decision more directly than object segmentation. |

The classifier tooling licenses are [scikit-learn BSD-3-Clause](https://github.com/scikit-learn/scikit-learn/blob/main/COPYING), [sklearn-onnx Apache-2.0](https://github.com/onnx/sklearn-onnx/blob/main/LICENSE) and [ONNX Runtime MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE). A training dataset and resulting model still need explicit provenance; a library license is not a license for unrelated textile datasets. Preserve the chosen release's notices and pin its version and model checksum when packaging.

## MobileSAM integration detail that changes the decision

The official ONNX export script exports the **prompt encoder and mask decoder**, consuming `image_embeddings`. It does not export the image encoder. Its CPU ONNX smoke test therefore does not prove a complete Python-free image-to-mask pipeline. A separate image-encoder export and numerical-parity test are necessary before promising ONNX-only deployment. [Export source](https://github.com/ChaoningZhang/MobileSAM/blob/master/scripts/export_onnx_model.py).

MobileSAM constructs a 1024-pixel image encoder; its mask postprocessing interpolates predictions back to source size. [Model construction](https://github.com/ChaoningZhang/MobileSAM/blob/master/mobile_sam/build_sam.py), [mask postprocessing](https://github.com/ChaoningZhang/MobileSAM/blob/master/mobile_sam/utils/onnx.py). **Inference:** segmentation may help identify a motif's region, but a mask upsampled onto a 2400 × 5700 source cannot establish which individual target-grid dots or one-pixel strokes are intentional. Tiled inference could expose more detail but adds overlap, mask-stitching and runtime problems that also need evaluation.

## Does a SAM mask beat color/rectangle selection?

The likely useful case is selecting a curved motif containing several colors, disconnected ornaments and holes while excluding nearby motifs using the same colors. A rectangle includes unrelated surroundings; a single-color selection misses the motif's other colors. A reviewed object mask may reduce selection effort here.

The likely weak case is a flat indexed border or one unwanted shade. Existing color selection and a region can already express this accurately. Before adding a model, compare a simple connected-component selection plus add/subtract brush against SAM on the same selections. That deterministic option requires no model download and provides exact pixels.

Even a perfect object mask does not distinguish decorative dots from noise **inside** that object. It only limits where another algorithm works. That is why selection speed and corrected-defect quality must be measured separately.

## Candidate-classifier experiment

This is a proposal, not a trained or validated implementation:

1. Let deterministic rules propose bounded edits: remove an isolated component, repair a supported gap, or merge a near-duplicate color. Keep palette merging a separate decision class so a rare intentional shade is not silently removed.
2. Derive local features: source support, component area and elongation, neighbor agreement, stroke direction, distance to a stable contour, repeated-motif agreement, and whether the edit changes connections or closes a real hole. Do not use raw palette indices as semantic labels; index 1 can represent different colors in different designs.
3. Train a small forest to score whether a concrete proposal is appropriate. Route uncertain scores to review; review is an abstention policy, not necessarily a separate training class. Start with candidate ranking; preserve manual acceptance and undo. The deterministic renderer applies only accepted edits using existing palette indices.
4. Collect aligned before/after patches with reviewed defect labels and intentional-detail labels. Start a feasibility set across several independent designs, including dots, alternating diagonals, small holes, parallel strokes and repeated borders. Synthetic corruption can supplement it but cannot substitute for real manual decisions.
5. Split by source design and motif family before generating patches; keep rotations, repeats and derived sizes in the same split. Otherwise near-duplicate patterns leak into the test set. Hold out a final set entirely until the candidate is fixed.

The two currently supplied BMPs are useful visual examples, but their differing sizes, repetitions and color semantics make direct pixel subtraction an unreliable teacher. First register matching motifs and obtain a reviewed target grid, or label candidate edits on the actual app output.

## Conditional adoption gates

These are proposed acceptance targets, not achieved results or promised savings:

- **Common baseline:** compare against the best measured deterministic settings at identical source crop, palette, target dimensions and accepted selection. Evaluate several design families, not only the supplied flower.
- **Selection gate:** MobileSAM must reduce median total selection-and-correction time by at least 25% versus color/rectangle/component/brush selection, without worse accepted masks on critical holes and adjacent motifs. Include model waiting time. Start with a CPU target of <=5 seconds per initial region and <=500 ms per additional prompt after embedding; measure peak RAM, cold start and full-source behavior. These provisional budgets can be revised transparently before the final test.
- **Cleanup gate:** the classifier must reduce reviewed remaining defects and operator correction time versus deterministic proposals, while not increasing damage to intentional details. Report false repairs, erased details, unresolved gaps and per-design results, not only the number of removed isolated pixels. Fix decision thresholds on validation data; report candidate acceptance precision and recall on held-out data with sample counts. No automatic mode based solely on a high confidence score.
- **Hard invariants:** no changes outside accepted scope or to protected pixels; no new palette entries; stable dimensions; byte-identical indexed output after save/reload and server export; exact undo. Reject an approach that improves average metrics while failing these invariants.
- **Deployment gate:** local offline inference succeeds on this actual Windows PC; package size and memory are recorded; cancellation works; the app remains usable without the optional model. Compare unquantized and quantized models on the same fixtures before accepting quantization.

## Review the decision twice

**Before implementation:** challenge whether the problem is selection, sampling, line geometry or semantic defect judgement. Run the simplest relevant baseline first. A model must address the measured bottleneck.

**After a promising result:** inspect new failures on untouched designs and measure the full workflow, including review and undo. If a model's advantage disappears after counting corrections, keep the deterministic route. If difficult multicolor selection remains the bottleneck, proceed with the MobileSAM experiment; if ambiguous edits remain the bottleneck and reviewed data exists, proceed with the candidate classifier.

Accepted model selections or edits should be stored with source identity, dimensions, transformation, model/version checksum and the reviewed binary mask or edit list. Export must replay the accepted result rather than rerunning a model that could change between releases.
