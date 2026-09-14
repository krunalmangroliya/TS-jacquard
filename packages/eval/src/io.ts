import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { RasterInput } from '../../core/src/types';

export async function readJson(file: string): Promise<unknown> { return JSON.parse(await readFile(file, 'utf8')); }
export async function writeJson(file: string, value: unknown): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
export function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export function slug(name: string): string { return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'design'; }
export async function readPng(file: string): Promise<{ raster: RasterInput; bytes: Buffer; digest: string }> {
  const bytes = await readFile(file);
  if (bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Not a PNG: ${file}`);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 8 || height < 8 || Math.max(width,height) > 8192 || width*height>40_000_000) throw new Error('Source PNG must be 8–8192 pixels per side and no more than 40 million pixels');
  const image = PNG.sync.read(bytes);
  return { raster: { width: image.width, height: image.height, channels: 4, data: new Uint8Array(image.data) }, bytes, digest: hash(bytes) };
}
export function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]!); }
