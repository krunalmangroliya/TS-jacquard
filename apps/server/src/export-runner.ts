import { Worker } from 'node:worker_threads';
import type { ExportArtifacts, ExportTask } from './export-worker';
import { HttpError } from './validation';
export function runExportWorker(file: string, task: ExportTask): Promise<ExportArtifacts> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(file, { workerData: task }); }
    catch { reject(new HttpError(503, 'The local export worker could not start')); return; }
    let finished = false;
    const finish = (error?: Error, result?: ExportArtifacts): void => { if (finished) return; finished = true; clearTimeout(timer); void worker.terminate(); if (error) reject(error); else resolve(result!); };
    const timer = setTimeout(() => finish(new HttpError(503, 'Export exceeded the three-minute limit')), 180_000);
    worker.once('message', message => { if (!message?.ok) finish(new HttpError(422, message?.message ?? 'This design could not be exported')); else finish(undefined, { bmp: new Uint8Array(message.bmp), png: new Uint8Array(message.png), json: message.json, widthPx: message.widthPx, heightPx: message.heightPx }); });
    worker.once('error', () => finish(new HttpError(503, 'The local export worker failed')));
    worker.once('exit', () => { if (!finished) finish(new HttpError(503, 'The export worker stopped before producing output')); });
  });
}
