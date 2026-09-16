export interface AiModelCard {
  id: string;
  name: string;
  version: number;
  modelFile: string;
  sha256: string;
  bytes: number;
  parameters: number;
  input: { name: string; shape: number[] };
  output: { name: string; shape: number[] };
  thresholds: { add: number; remove: number };
  qualification: string;
}

/** Refuse stale or incompatible model metadata instead of applying misinterpreted masks. */
export function parseAiModelCard(value: unknown): AiModelCard {
  const card = value as AiModelCard | null;
  if (!card || card.version !== 1 || card.id !== 'loom-tiny-v1' || card.modelFile !== 'loom-tiny-v1.onnx' || typeof card.name !== 'string') throw new Error('The AI model description is incompatible with this app.');
  if (!/^[a-f0-9]{64}$/.test(card.sha256) || !Number.isSafeInteger(card.bytes) || card.bytes < 1 || card.bytes > 4 * 1024 * 1024 || !Number.isSafeInteger(card.parameters) || card.parameters < 1) throw new Error('The AI model size or fingerprint is invalid.');
  if (card.input?.name !== 'ink' || JSON.stringify(card.input.shape) !== '[1,1,64,64]' || card.output?.name !== 'logits' || JSON.stringify(card.output.shape) !== '[1,2,64,64]') throw new Error('The AI model patch format is not supported.');
  if (![card.thresholds?.add, card.thresholds?.remove].every(t => typeof t === 'number' && Number.isFinite(t) && t >= .5 && t <= 1)) throw new Error('The AI model confidence settings are invalid.');
  if (typeof card.qualification !== 'string' || !card.qualification.length) throw new Error('The AI model is missing its evaluation limits.');
  return card;
}

export async function verifyModelBytes(bytes: ArrayBuffer, card: AiModelCard): Promise<void> {
  if (bytes.byteLength !== card.bytes) throw new Error('The AI model download is incomplete. Reload the app and retry.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== card.sha256) throw new Error('The AI model and its description do not match. Reload the app and retry.');
}
