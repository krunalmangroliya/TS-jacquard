import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { CLEANUP_MEDIA_TYPE, MAX_CLEANUP_PACKET_BYTES } from './src/cleanup-wire.ts';

/** Large indexed designs run on this loopback device, outside the renderer's memory budget. */
export function localCleanup(): Plugin {
  let workerFile = '';
  let active = 0;
  const workers = new Set<Worker>();
  const jobs = new Map<string, () => void>();
  const cancelled = new Map<string, number>();
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const requestPath = (req.url || '').split('?')[0];
    if (requestPath !== '/__loom_cleanup' && !requestPath.startsWith('/__loom_cleanup/')) return next();
    const send = (status: number, error: string) => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify({ error }));
    };
    const host = req.headers.host || '';
    const address = req.socket.remoteAddress;
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    const origin = req.headers.origin;
    if (!loopback || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) || (origin !== `http://${host}` && origin !== `https://${host}`)) { send(403, 'Local cleanup accepts requests only from this studio on this device.'); return; }
    const validId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    for (const [id, expires] of cancelled) if (expires < Date.now()) cancelled.delete(id);
    if (req.method === 'DELETE' && requestPath.startsWith('/__loom_cleanup/')) {
      const id = requestPath.slice('/__loom_cleanup/'.length);
      if (!validId(id)) { send(400, 'Invalid local cleanup job identifier.'); return; }
      // Covers cancellation arriving before an upload reaches the request handler.
      cancelled.set(id, Date.now() + 30_000);
      if (cancelled.size > 256) cancelled.delete(cancelled.keys().next().value!);
      jobs.get(id)?.();
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify({ cancelled: true }));
      return;
    }
    if (requestPath !== '/__loom_cleanup') { send(404, 'Local cleanup job not found.'); return; }
    if (req.method !== 'POST') { send(405, 'Use a cleanup POST request.'); return; }
    if (!req.headers['content-type']?.startsWith(CLEANUP_MEDIA_TYPE)) { send(415, 'Use the indexed cleanup packet format.'); return; }
    const id = String(req.headers['x-loom-job'] || randomUUID());
    if (!validId(id)) { send(400, 'Invalid local cleanup job identifier.'); return; }
    if (cancelled.has(id)) { send(499, 'Cleanup cancelled.'); return; }
    if (active >= 1) { send(429, 'Another cleanup is running on this device. Wait for it to finish or cancel it, then retry.'); return; }
    const claimedLength = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
    if (claimedLength !== null && (!Number.isSafeInteger(claimedLength) || claimedLength < 8 || claimedLength > MAX_CLEANUP_PACKET_BYTES)) { send(413, 'The local cleanup request exceeds 48 MB.'); return; }
    active++;
    let finished = false;
    let worker: Worker | null = null;
    const release = () => {
      if (finished) return;
      finished = true; active--; jobs.delete(id);
      req.off('aborted', cancel); res.off('close', onClose);
      clearTimeout(timeout);
      if (worker) { workers.delete(worker); void worker.terminate(); }
    };
    const cancel = () => { send(499, 'Cleanup cancelled.'); release(); };
    const onClose = () => { if (!res.writableEnded) cancel(); };
    const timeout = setTimeout(() => { send(504, 'This cleanup exceeded the local time limit. Try a smaller output or gentler recipe.'); release(); }, 180_000);
    req.once('aborted', cancel); res.once('close', onClose);
    jobs.set(id, cancel);
    try {
      let packet: Uint8Array<ArrayBuffer>;
      let received = 0;
      if (claimedLength !== null) {
        packet = new Uint8Array(claimedLength);
        for await (const chunk of req) {
          if (finished) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (received + bytes.length > claimedLength) { send(413, 'The cleanup request body exceeds its declared size.'); release(); return; }
          packet.set(bytes, received); received += bytes.length;
        }
        if (received !== claimedLength) { send(400, 'The cleanup upload was incomplete. Retry the artwork.'); release(); return; }
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          if (finished) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += bytes.length;
          if (received > MAX_CLEANUP_PACKET_BYTES) { send(413, 'The local cleanup request exceeds 48 MB.'); release(); return; }
          chunks.push(bytes);
        }
        packet = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) { packet.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0;
      }
      if (finished || res.destroyed) { release(); return; }
      const started = performance.now();
      console.info(`[loom-cleanup] ${id.slice(0, 8)} started: ${received} request bytes`);
      worker = new Worker(pathToFileURL(workerFile), { execArgv: ['--import', loader], workerData: { packet: packet.buffer }, transferList: [packet.buffer] });
      workers.add(worker);
      worker.once('message', (message: { packet?: ArrayBuffer; error?: string }) => {
        if (finished) return;
        if (message.packet) {
          console.info(`[loom-cleanup] ${id.slice(0, 8)} complete: ${message.packet.byteLength} result bytes, ${Math.round(performance.now() - started)} ms`);
          res.statusCode = 200; res.setHeader('Content-Type', CLEANUP_MEDIA_TYPE); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end(Buffer.from(message.packet));
        } else { console.info(`[loom-cleanup] ${id.slice(0, 8)} rejected: ${(message.error || 'invalid request').slice(0, 180)}`); send(422, message.error || 'Local cleanup could not process this artwork.'); }
        release();
      });
      worker.once('error', error => { if (!finished) { send(500, `Local cleanup could not start: ${error.message}`); release(); } });
      worker.once('exit', code => { if (!finished) { send(500, `Local cleanup ended before returning a result (code ${code}).`); release(); } });
    } catch (error) {
      if (!finished) { send(500, error instanceof Error ? error.message : 'Local cleanup failed.'); release(); }
    }
  };
  const stopWorkers = () => { for (const cancel of jobs.values()) cancel(); for (const worker of workers) void worker.terminate(); workers.clear(); };
  return {
    name: 'loom-local-cleanup',
    configResolved(config) { workerFile = path.resolve(config.root, 'server-cleanup.worker.ts'); },
    configureServer(server) { server.middlewares.use(middleware); server.httpServer?.once('close', stopWorkers); },
    configurePreviewServer(server) { server.middlewares.use(middleware); server.httpServer.once('close', stopWorkers); },
    closeBundle() { stopWorkers(); },
  };
}
