import { importColorImage } from '../../../packages/core/src/raster';

export interface ColorImportJob { id: number; width: number; height: number; data: ArrayBuffer; colorLimit: number | 'preserve' }
export type ColorImportResult = ReturnType<typeof importColorImage>;
const scope = self as unknown as { onmessage: ((event: MessageEvent<ColorImportJob>) => void) | null; postMessage: (message: unknown) => void };
scope.onmessage = ({ data: job }) => {
  try {
    const result = importColorImage({ width: job.width, height: job.height, channels: 4, data: new Uint8Array(job.data) }, job.colorLimit);
    scope.postMessage({ id: job.id, result });
  } catch (error) { scope.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) }); }
};
