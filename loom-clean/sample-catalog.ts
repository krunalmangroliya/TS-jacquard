import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { parseReadPick, sampleKey, type SampleCatalog, type SamplePreset } from './src/sample-presets.ts';

async function bmpDimensions(filename: string): Promise<{ width: number; height: number }> {
  const file = await open(filename, 'r');
  try {
    const header = Buffer.alloc(54);
    const { bytesRead } = await file.read(header, 0, 54, 0);
    if (bytesRead < 54 || header.toString('ascii', 0, 2) !== 'BM' || header.readUInt32LE(14) < 40) throw new Error('Invalid BMP header');
    const width = header.readInt32LE(18), height = Math.abs(header.readInt32LE(22));
    if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Unsupported BMP dimensions');
    return { width, height };
  } finally { await file.close(); }
}

/** Discovers paired source/sized files without reading completed design pixels. */
export async function readSampleCatalog(directory: string): Promise<SampleCatalog> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { samples: [], warnings: [] }; throw error; }
  const groups = new Map<string, { source: string[]; sized: string[]; complete: string[] }>();
  for (const entry of entries) {
    if (!entry.isFile()) continue; // Do not follow symlinks or traverse subfolders.
    const id = sampleKey(entry.name);
    if (!id) continue;
    const group = groups.get(id) || { source: [], sized: [], complete: [] };
    if (/\.png$/i.test(entry.name)) group.source.push(entry.name);
    else if (/\.bmp$/i.test(entry.name) && /sized/i.test(entry.name)) group.sized.push(entry.name);
    else if (/\.bmp$/i.test(entry.name) && /complete/i.test(entry.name)) group.complete.push(entry.name);
    groups.set(id, group);
  }
  const samples: SamplePreset[] = [], warnings: string[] = [];
  for (const [id, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (!group.source.length || !group.sized.length) { warnings.push(`${id}: a source PNG and a sized BMP are both needed.`); continue; }
    // Ambiguity must be reviewed instead of silently choosing an unrelated version.
    if (group.source.length !== 1 || group.sized.length !== 1) { warnings.push(`${id}: multiple source or sized files found; keep one pair to enable this sample.`); continue; }
    const sourceName = group.source[0], sizedName = group.sized[0];
    const sizedSettings = parseReadPick(sizedName);
    const fallbackSettings = [sourceName, ...group.complete].map(parseReadPick).filter(value => value !== null);
    const settings = sizedSettings || fallbackSettings[0];
    if (!settings) { warnings.push(`${id}: read/pick notation was not found; upload the PNG and enter it manually.`); continue; }
    if (!sizedSettings && fallbackSettings.some(value => value.read !== settings.read || value.pick !== settings.pick)) { warnings.push(`${id}: conflicting read/pick notation; upload and choose settings manually.`); continue; }
    try {
      const dimensions = await bmpDimensions(path.join(directory, sizedName));
      const [design, part] = id.split('-');
      samples.push({ id, label: `${design} · ${part[0].toUpperCase()}${part.slice(1)}`, sourceName, sourceUrl: `/__loom_samples/source/${id}`, ...settings, ...dimensions, settingsSource: 'sized-bmp' });
    } catch { warnings.push(`${id}: the sized BMP header could not be read.`); }
  }
  return { samples, warnings };
}

export function localSamples(): Plugin {
  let directory = '';
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/__loom_samples' && !pathname.startsWith('/__loom_samples/')) return next();
    const json = (status: number, value: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value)); };
    if (req.method !== 'GET') { json(405, { error: 'Only reading local samples is supported.' }); return; }
    try {
      const catalog = await readSampleCatalog(directory);
      if (pathname === '/__loom_samples') { json(200, catalog); return; }
      const match = pathname.match(/^\/__loom_samples\/source\/(\d{4,8}-(?:pallu|patto|bodi|daman))$/);
      const sample = match ? catalog.samples.find(value => value.id === match[1]) : undefined;
      if (!sample) { json(404, { error: 'Local source sample not found.' }); return; }
      const bytes = await readFile(path.join(directory, sample.sourceName));
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(bytes);
    } catch { json(500, { error: 'The local sample folder could not be read. Retry after copying files finishes.' }); }
  };
  return { name: 'loom-local-samples', configResolved(config) { directory = path.resolve(config.root, 'sample'); }, configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
