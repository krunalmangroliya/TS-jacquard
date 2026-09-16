import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { generateAiPatches, applyAiPredictions } from './ai-proposals';
import { parseAiModelCard, verifyModelBytes } from './ai-model';
import type { CleanupOptions, IndexedImage, Progress } from './types';
import type { AiResult } from './ai-types';

const progress = (stage: string, percent: number) => self.postMessage({ progress: { stage, percent } satisfies Progress });
self.onmessage = async (event: MessageEvent<{ image: IndexedImage; options: CleanupOptions }>) => {
  const started = performance.now();
  let session: ort.InferenceSession | undefined;
  try {
    const { image, options } = event.data;
    progress('Finding small areas to inspect', 3);
    const { patches, coverage } = generateAiPatches(image, options);
    const warnings = ['Experimental model trained on artificial defects in completed samples. Review every proposed change; real-artwork accuracy has not been established.'];
    if (coverage.limited) warnings.push('This bounded trial inspects a selection of candidate areas. Other areas have not been checked by AI.');
    let additions = 0, removals = 0;
    let output: IndexedImage = { ...image, pixels: image.pixels.slice(), palette: image.palette.map(c => [...c] as [number, number, number]) };
    let changes: Uint8Array = new Uint8Array(image.pixels.length);
    let modelName = 'Loom Tiny v1', provider = 'Not run (no candidate areas)';
    if (patches.length) {
      progress('Loading the small model on this device', 8);
      const cardResponse = await fetch(new URL('/models/loom-tiny-v1.json', self.location.origin));
      if (!cardResponse.ok || !cardResponse.headers.get('content-type')?.includes('json')) throw new Error('The AI model is not available. Rebuild the local studio after training the model.');
      const card = parseAiModelCard(await cardResponse.json());
      warnings.push(card.qualification);
      const modelResponse = await fetch(new URL(`/models/${card.modelFile}`, self.location.origin));
      if (!modelResponse.ok) throw new Error('The small AI model could not be loaded from this device.');
      const modelBytes = await modelResponse.arrayBuffer();
      await verifyModelBytes(modelBytes, card);
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };
      session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      modelName = card.name; provider = 'ONNX Runtime Web · WASM CPU';
      const predictions = [];
      for (let i = 0; i < patches.length; i++) {
        const patch = patches[i];
        const input = new ort.Tensor('float32', patch.mask, [1, 1, 64, 64]);
        const outputs = await session.run({ ink: input });
        const result = outputs.logits;
        if (!result || result.type !== 'float32' || JSON.stringify(result.dims) !== '[1,2,64,64]') throw new Error('The model returned an incompatible prediction.');
        const logits = new Float32Array(result.data as Float32Array);
        if (logits.some(value => !Number.isFinite(value))) throw new Error('The model returned invalid confidence values.');
        predictions.push({ patch, logits });
        input.dispose(); for (const tensor of Object.values(outputs)) tensor.dispose();
        progress(`Inspecting area ${i + 1} of ${patches.length}`, 15 + Math.round(75 * (i + 1) / patches.length));
      }
      progress('Checking proposed pixel changes', 94);
      const applied = applyAiPredictions(image, options, predictions, card.thresholds);
      output = applied.image; changes = applied.changes;
      additions = applied.stats.addedPixels; removals = applied.stats.removedPixels;
      if (applied.stats.geometryBudgetExhausted) warnings.push('The detail-check limit was reached. Some possible changes were left for manual review.');
    } else warnings.push('No eligible areas were found. The model did not run and the canvas is unchanged.');
    const result: AiResult = { image: output, changes, stats: { addedPixels: additions, removedPixels: removals,
      patchesScanned: patches.length, eligiblePatches: coverage.eligiblePatches, candidatePixels: coverage.candidatePixels,
      scannedPixels: coverage.scannedPixels, totalPixels: image.pixels.length, elapsedMs: performance.now() - started, provider, modelName }, warnings };
    await session?.release(); session = undefined;
    progress('AI preview ready', 100);
    self.postMessage({ result }, { transfer: [result.image.pixels.buffer, result.changes.buffer] });
  } catch (error) {
    await session?.release().catch(() => {});
    self.postMessage({ error: error instanceof Error ? error.message : 'AI analysis failed. Your canvas is unchanged.' });
  }
};
