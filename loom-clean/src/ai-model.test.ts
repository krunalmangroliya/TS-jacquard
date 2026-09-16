import { describe, expect, it } from 'vitest';
import { parseAiModelCard, verifyModelBytes } from './ai-model';

const bytes = new TextEncoder().encode('small-model-test');
async function card() {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  return { id: 'loom-tiny-v1', name: 'Test model', version: 1, modelFile: 'loom-tiny-v1.onnx', sha256: hash,
    bytes: bytes.length, parameters: 100_000, input: { name: 'ink', shape: [1, 1, 64, 64] },
    output: { name: 'logits', shape: [1, 2, 64, 64] }, thresholds: { add: .99, remove: .98 }, qualification: 'Synthetic evaluation only.' };
}
describe('AI model contract', () => {
  it('checks model bytes against the declared fingerprint', async () => {
    const description = parseAiModelCard(await card());
    await expect(verifyModelBytes(bytes.buffer, description)).resolves.toBeUndefined();
    const altered = bytes.slice(); altered[0] ^= 1;
    await expect(verifyModelBytes(altered.buffer, description)).rejects.toThrow('do not match');
    await expect(verifyModelBytes(bytes.slice(1).buffer, description)).rejects.toThrow('incomplete');
  });
  it('rejects incompatible heads, patch sizes and missing evaluation limits', async () => {
    const valid = await card();
    for (const change of [{ output: { name: 'logits', shape: [1, 1, 64, 64] } }, { input: { name: 'ink', shape: [1, 1, 128, 128] } }, { qualification: '' }, { thresholds: { add: NaN, remove: .9 } }, { modelFile: '../different.onnx' }]) expect(() => parseAiModelCard({ ...valid, ...change })).toThrow();
  });
});
