import { parentPort, workerData } from 'node:worker_threads';
import { cleanRaster } from './src/engine.ts';
import { decodeCleanupRequest, encodeCleanupResult } from './src/cleanup-wire.ts';

try {
  const { source, options } = decodeCleanupRequest(workerData.packet as ArrayBuffer);
  const result = cleanRaster(source, options);
  const bytes = encodeCleanupResult(result);
  parentPort!.postMessage({ packet: bytes.buffer }, [bytes.buffer]);
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : 'Local cleanup failed.' });
}
