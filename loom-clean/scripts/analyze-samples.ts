import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { decodeBmp, encodeBmp } from '../src/image-codec';
import { cleanRaster as cleanRasterV1 } from './engine-v1';
import { suggestOutlineColor } from '../src/sample-presets';
import { MAX_SOURCE_PIXELS, MAX_OUTPUT_PIXELS, type IndexedImage, type RGB } from '../src/types';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(process.argv.slice(2).find(a => !a.startsWith('--')) ?? path.join(project, 'sample'));
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const output = path.join(project, 'output', 'sample-analysis');
type Triple = { id: string; source?: string; sized?: string; complete?: string };
const hex = (c: RGB) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const key = (c: RGB) => (c[0] << 16) | (c[1] << 8) | c[2];
const quantKey = (c: RGB) => key(c.map(v => v & 248) as RGB);
const darkest = (image: IndexedImage) => suggestOutlineColor(image) ?? 0;
function pngIndexed(buffer: Buffer) {
  const png = PNG.sync.read(buffer), pixels = new Uint8Array(png.width * png.height), palette: RGB[] = [], map = new Map<number, number>();
  let nonOpaquePixels = 0;
  for (let i = 0; i < pixels.length; i++) {
    const alpha = png.data[i * 4 + 3] / 255;
    if (alpha < 1) nonOpaquePixels++;
    const c: RGB = [0, 1, 2].map(k => Math.round(png.data[i * 4 + k] * alpha + 255 * (1 - alpha))) as RGB;
    const rgb = key(c); let index = map.get(rgb);
    if (index === undefined) { index = palette.length; if (index > 255) throw new Error('Sample has more than 256 exact opaque/composited colors; no implicit quantization is allowed.'); palette.push(c); map.set(rgb, index); }
    pixels[i] = index;
  }
  let dpiX: number | undefined, dpiY: number | undefined;
  for (let o = 8; o + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(o), kind = buffer.toString('ascii', o + 4, o + 8);
    if (kind === 'pHYs' && buffer[o + 16] === 1) { dpiX = buffer.readUInt32BE(o + 8) * .0254; dpiY = buffer.readUInt32BE(o + 12) * .0254; }
    o += length + 12;
  }
  return { image: { width: png.width, height: png.height, pixels, palette }, dpiX, dpiY, nonOpaquePixels };
}
function statistics(image: IndexedImage) {
  const { width: w, height: h, pixels } = image, outline = darkest(image), noise = new Uint8Array(pixels.length), seen = new Uint8Array(pixels.length), queue = new Int32Array(pixels.length);
  const perColor = image.palette.map(c => ({ rgb: hex(c), pixels: 0, components8: 0, singleton8: 0, components2to4: 0, components5to16: 0 }));
  for (const c of pixels) perColor[c].pixels++;
  for (let seed = 0; seed < pixels.length; seed++) {
    if (seen[seed]) continue;
    const c = pixels[seed]; queue[0] = seed; seen[seed] = 1; let head = 0, tail = 1;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
        const next = yy * w + xx;
        if (!seen[next] && pixels[next] === c) { seen[next] = 1; queue[tail++] = next; }
      }
    }
    perColor[c].components8++;
    if (tail === 1) perColor[c].singleton8++;
    if (tail >= 2 && tail <= 4) perColor[c].components2to4++;
    if (tail >= 5 && tail <= 16) perColor[c].components5to16++;
    if (tail <= 4) for (let p = 0; p < tail; p++) noise[queue[p]] = 1;
  }
  return { description: { width: w, height: h, totalPixels: pixels.length, paletteSize: image.palette.length, usedColors: perColor.filter(c => c.pixels).length, singleton8: perColor.reduce((n, c) => n + c.singleton8, 0), components8: perColor.reduce((n, c) => n + c.components8, 0), smallComponentPixels1to4: noise.reduce((n, v) => n + v, 0), outlineColor: hex(image.palette[outline]), outlinePixels: perColor[outline].pixels, perColor }, noise, outline };
}
function resizeLineage(source: IndexedImage, sized: IndexedImage) {
  const sourceKeys = source.palette.map(key), sizedKeys = sized.palette.map(key);
  const variants = [0, 90, 180, 270].flatMap(rotation => [false, true].map(mirroredHorizontally => {
    const rw = rotation % 180 ? source.height : source.width, rh = rotation % 180 ? source.width : source.height;
    let mismatch = 0;
    for (let y = 0; y < sized.height; y++) for (let x = 0; x < sized.width; x++) {
      const rx0 = Math.min(rw - 1, Math.floor((x + .5) * rw / sized.width)), rx = mirroredHorizontally ? rw - 1 - rx0 : rx0;
      const ry = Math.min(rh - 1, Math.floor((y + .5) * rh / sized.height));
      const sx = rotation === 90 ? ry : rotation === 180 ? source.width - 1 - rx : rotation === 270 ? source.width - 1 - ry : rx;
      const sy = rotation === 90 ? source.height - 1 - rx : rotation === 180 ? source.height - 1 - ry : rotation === 270 ? rx : ry;
      if (sourceKeys[source.pixels[sy * source.width + sx]] !== sizedKeys[sized.pixels[y * sized.width + x]]) mismatch++;
    }
    return { clockwiseDegrees: rotation, mirroredHorizontally, mismatchPixels: mismatch, exactRgbAgreementFraction: 1 - mismatch / sized.pixels.length };
  }));
  variants.sort((a, b) => a.mismatchPixels - b.mismatchPixels);
  return { method: 'Center-nearest sampling after each right-angle rotation and optional horizontal mirror; exact RGB equality, no registration or creative edits inferred.', best: variants[0], rotations: variants };
}
function referenceOutline(sized: IndexedImage, complete: IndexedImage, outline: number) {
  const counts = new Uint32Array(complete.palette.length), cooccurrence = new Uint32Array(complete.palette.length);
  let selectedCount = 0;
  const step = Math.max(2, Math.floor(Math.sqrt(sized.pixels.length / 80_000)));
  for (let y = 0; y < Math.min(sized.height, complete.height); y += step) for (let x = 0; x < Math.min(sized.width, complete.width); x += step) {
    const c = complete.pixels[y * complete.width + x]; counts[c]++;
    if (sized.pixels[y * sized.width + x] === outline) { cooccurrence[c]++; selectedCount++; }
  }
  let index = darkest(complete), dice = -1;
  for (let i = 0; i < complete.palette.length; i++) { const score = 2 * cooccurrence[i] / Math.max(1, counts[i] + selectedCount); if (score > dice) { index = i; dice = score; } }
  return { index, dice, color: hex(complete.palette[index]), method: 'Highest sampled binary-mask Dice co-occurrence at zero translation; provisional palette correspondence allows designer recoloring.' };
}
function alignment(sized: IndexedImage, complete: IndexedImage, aOutline: number, bOutline: number) {
  if (Math.abs(sized.width - complete.width) > 8 || Math.abs(sized.height - complete.height) > 8) return null;
  const step = Math.max(2, Math.floor(Math.sqrt(sized.pixels.length / 35_000)));
  let best = { dx: 0, dy: 0, maskMeanIoU: -1, sampleStride: step };
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (let y = Math.max(0, -dy); y < Math.min(sized.height, complete.height - dy); y += step) for (let x = Math.max(0, -dx); x < Math.min(sized.width, complete.width - dx); x += step) {
      const a = sized.pixels[y * sized.width + x] === aOutline, b = complete.pixels[(y + dy) * complete.width + x + dx] === bOutline;
      if (a && b) tp++; else if (a) fp++; else if (b) fn++; else tn++;
    }
    const score = (tp / Math.max(1, tp + fp + fn) + tn / Math.max(1, tn + fp + fn)) / 2;
    if (score > best.maskMeanIoU + 1e-9 || Math.abs(score - best.maskMeanIoU) < 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy)) best = { dx, dy, maskMeanIoU: score, sampleStride: step };
  }
  return best;
}
function orientReference(image: IndexedImage, halfTurn: boolean, mirror: boolean): IndexedImage {
  if (!halfTurn && !mirror) return image;
  const pixels = new Uint8Array(image.pixels.length);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const xx = mirror ? image.width - 1 - x : x, sx = halfTurn ? image.width - 1 - xx : xx, sy = halfTurn ? image.height - 1 - y : y;
    pixels[y * image.width + x] = image.pixels[sy * image.width + sx];
  }
  return { ...image, pixels };
}
function alignReference(sized: IndexedImage, original: IndexedImage, outline: number) {
  let image = original, referenceColor = referenceOutline(sized, image, outline), offset = alignment(sized, image, outline, referenceColor.index);
  let best = { image, referenceColor, offset, orientation: { clockwiseDegrees: 0, mirroredHorizontally: false } };
  if (!offset) return best;
  for (const [halfTurn, mirror] of [[false, true], [true, false], [true, true]]) {
    image = orientReference(original, halfTurn, mirror); referenceColor = referenceOutline(sized, image, outline); offset = alignment(sized, image, outline, referenceColor.index);
    if (offset && offset.maskMeanIoU > best.offset!.maskMeanIoU + 1e-6) best = { image, referenceColor, offset, orientation: { clockwiseDegrees: halfTurn ? 180 : 0, mirroredHorizontally: mirror } };
  }
  return best;
}
function gapCandidate(image: IndexedImage, p: number, outline: number) {
  if (image.pixels[p] === outline) return false;
  const x = p % image.width, y = Math.floor(p / image.width), w = image.width;
  if (x < 1 || x >= w - 1 || y < 1 || y >= image.height - 1) return false;
  return [[-1, 1], [-w, w], [-w - 1, w + 1], [-w + 1, w - 1]].some(([a, b]) => image.pixels[p + a] === outline && image.pixels[p + b] === outline);
}
function compare(sized: IndexedImage, complete: IndexedImage, sa: ReturnType<typeof statistics>, cb: ReturnType<typeof statistics>, offset: ReturnType<typeof alignment>) {
  const labels = new Uint8Array(sized.pixels.length), gapFilled = new Uint8Array(sized.pixels.length), mapped = new Int32Array(sized.pixels.length); mapped.fill(-1);
  let overlapPixels = 0, unchangedQuantizedRgb = 0, outlineAdded = 0, outlineRemoved = 0, otherColorChanges = 0, inputGapCandidates = 0, candidateGapFilled = 0, smallInputComponentPixelsChanged = 0;
  const aKeys = sized.palette.map(quantKey), bKeys = complete.palette.map(quantKey);
  for (let p = 0; p < sized.pixels.length; p++) {
    if (gapCandidate(sized, p, sa.outline)) inputGapCandidates++;
    if (!offset) continue;
    const x = p % sized.width + offset.dx, y = Math.floor(p / sized.width) + offset.dy;
    if (x < 0 || y < 0 || x >= complete.width || y >= complete.height) continue;
    const q = y * complete.width + x; mapped[p] = q; overlapPixels++;
    const same = aKeys[sized.pixels[p]] === bKeys[complete.pixels[q]];
    if (same) unchangedQuantizedRgb++; else if (sa.noise[p]) smallInputComponentPixelsChanged++;
    const a = sized.pixels[p] === sa.outline, b = complete.pixels[q] === cb.outline;
    if (!a && b) { labels[p] = 1; outlineAdded++; if (gapCandidate(sized, p, sa.outline)) { gapFilled[p] = 1; candidateGapFilled++; } }
    else if (a && !b) { labels[p] = 2; outlineRemoved++; }
    else if (!same) { labels[p] = 3; otherColorChanges++; }
  }
  return { description: { offset, overlapPixels, unchangedQuantizedRgb, quantizedRgbAgreementFraction: overlapPixels ? unchangedQuantizedRgb / overlapPixels : null, outlineAdded, outlineRemoved, otherColorChanges, inputGapCandidates, candidateGapFilled, smallInputComponentPixelsChanged, interpretation: 'Descriptive candidate counts after a single translation and RGB &248 normalization. Recoloring, local warps, new ornaments and boundary shifts are confounders. None is an accuracy score or automatically approved edit.' }, labels, gapFilled, mapped };
}
function chooseCrop(image: IndexedImage, mask: Uint8Array, occupied: { x: number; y: number }[] = []) {
  const w = Math.min(144, image.width), h = Math.min(112, image.height), step = Math.max(16, Math.floor(w / 3));
  let best = { x: Math.max(0, Math.floor((image.width - w) / 2)), y: Math.max(0, Math.floor((image.height - h) / 2)), count: -1, w, h };
  for (let y = 0; y <= image.height - h; y += step) for (let x = 0; x <= image.width - w; x += step) {
    if (occupied.some(c => Math.abs(c.x - x) < w * .8 && Math.abs(c.y - y) < h * .8)) continue;
    let count = 0; for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) count += mask[yy * image.width + xx];
    if (count > best.count) best = { x, y, w, h, count };
  }
  return best;
}
function writeSheet(sized: IndexedImage, complete: IndexedImage, detail: ReturnType<typeof compare>, crops: { label: string; x: number; y: number; w: number; h: number; count: number }[]) {
  const scale = 3, gutter = 12, cw = crops[0].w, ch = crops[0].h;
  const png = new PNG({ width: cw * scale * 3 + gutter * 4, height: ch * scale * crops.length + gutter * (crops.length + 1) }); png.data.fill(20); for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  for (let row = 0; row < crops.length; row++) for (let col = 0; col < 3; col++) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const p = (crops[row].y + y) * sized.width + crops[row].x + x; let rgb: RGB;
    if (col === 0) rgb = sized.palette[sized.pixels[p]];
    else if (col === 1) {
      const q = detail.mapped[p];
      if (q >= 0) rgb = complete.palette[complete.pixels[q]];
      else if (!detail.description.offset) { const xx = Math.min(complete.width - 1, Math.floor((crops[row].x + x) * complete.width / sized.width)), yy = Math.min(complete.height - 1, Math.floor((crops[row].y + y) * complete.height / sized.height)); rgb = complete.palette[complete.pixels[yy * complete.width + xx]]; }
      else rgb = [38, 38, 38];
    } else {
      const type = detail.labels[p];
      if (type === 1) rgb = [255, 81, 126]; else if (type === 2) rgb = [71, 211, 202]; else if (type === 3) rgb = [182, 146, 241];
      else { const c = sized.palette[sized.pixels[p]], v = Math.round((c[0] + c[1] + c[2]) / 3 * .24 + 16); rgb = [v, v, v]; }
    }
    for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) { const dest = ((gutter + row * (ch * scale + gutter) + y * scale + yy) * png.width + gutter + col * (cw * scale + gutter) + x * scale + xx) * 4; png.data[dest] = rgb[0]; png.data[dest + 1] = rgb[1]; png.data[dest + 2] = rgb[2]; png.data[dest + 3] = 255; }
  }
  return PNG.sync.write(png);
}
function preview(image: IndexedImage) {
  const scale = Math.min(1, 900 / image.width, 1300 / image.height), w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale)), png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = image.palette[image.pixels[Math.min(image.height - 1, Math.floor((y + .5) * image.height / h)) * image.width + Math.min(image.width - 1, Math.floor((x + .5) * image.width / w))]], p = (y * w + x) * 4; png.data[p] = c[0]; png.data[p + 1] = c[1]; png.data[p + 2] = c[2]; png.data[p + 3] = 255; }
  return PNG.sync.write(png);
}

async function main() {
  await mkdir(output, { recursive: true });
  const groups = new Map<string, Triple>();
  for (const file of await readdir(input)) {
    const match = file.match(/(\d{5})\s*(pallu|bodi|patto|patta|daman)/i); if (!match) continue;
    const id = `${match[1]}-${match[2].toLowerCase()}`, group = groups.get(id) ?? { id };
    const type = /\.png$/i.test(file) ? 'source' : /complete/i.test(file) ? 'complete' : /sized/i.test(file) ? 'sized' : null;
    if (type) { if (group[type]) throw new Error(`Duplicate ${type} file for ${id}`); group[type] = file; groups.set(id, group); }
  }
  const samples = [];
  for (const triple of [...groups.values()].filter(g => !only || g.id === only).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!triple.source || !triple.sized || !triple.complete) throw new Error(`Incomplete triple: ${triple.id}`);
    console.log(`Analyzing ${triple.id}...`);
    const [sourceBuffer, sizedBuffer, completeBuffer] = await Promise.all([readFile(path.join(input, triple.source)), readFile(path.join(input, triple.sized)), readFile(path.join(input, triple.complete))]);
    const source = pngIndexed(sourceBuffer), sized = decodeBmp(sizedBuffer), complete = decodeBmp(completeBuffer);
    const sa = statistics(sized), cb = statistics(complete), paired = alignReference(sized, complete, sa.outline), referenceColor = paired.referenceColor;
    cb.outline = referenceColor.index; cb.description.outlineColor = referenceColor.color; cb.description.outlinePixels = cb.description.perColor[referenceColor.index].pixels;
    const offset = paired.offset, detail = compare(sized, paired.image, sa, cb, offset);
    Object.assign(detail.description, { referenceOrientation: paired.orientation });
    const rp = `${triple.sized} ${triple.complete}`.match(/r\s*(\d+)\s*p\s*(\d+)/i); if (!rp) throw new Error(`No read/pick label for ${triple.id}`);
    const read = Number(rp[1]), pick = Number(rp[2]), lineage = resizeLineage(source.image, sized);
    const noiseCrop = chooseCrop(sized, sa.noise), bridgeCrop = chooseCrop(sized, detail.gapFilled, [noiseCrop]), outlineAddMask = Uint8Array.from(detail.labels, x => x === 1 ? 1 : 0), additionCrop = chooseCrop(sized, outlineAddMask, [noiseCrop, bridgeCrop]);
    const crops = [{ label: 'Highest density of 1–4-pixel input components (noise candidates; may include ornament)', ...noiseCrop }, { label: 'Input opposite-outline contacts filled by completed reference (bridge candidates)', ...bridgeCrop }, { label: 'Completed outline additions (may include redraw or local misalignment)', ...additionCrop }];
    const sourceColors5 = new Set(source.image.palette.map(quantKey));
    const completeColors = cb.description.perColor.filter(c => c.pixels).map(c => c.rgb);
    const completePaletteCovered = complete.palette.every((c, i) => cb.description.perColor[i].pixels === 0 || sourceColors5.has(quantKey(c)));
    const warnings: string[] = [];
    if (source.image.pixels.length > MAX_SOURCE_PIXELS) warnings.push(`Source exceeds current ${MAX_SOURCE_PIXELS}-pixel app limit.`);
    if (sized.pixels.length > MAX_OUTPUT_PIXELS) warnings.push(`Sized output exceeds current ${MAX_OUTPUT_PIXELS}-pixel app limit.`);
    if (sized.width !== complete.width || sized.height !== complete.height) warnings.push('Sized and completed dimensions differ; translation does not resolve changed layout or local stretch.');
    if (!offset) warnings.push('Geometry differs substantially: no spatial paired comparison or addition/deletion count is made. Reference column uses relative positions only.');
    else if (offset.maskMeanIoU < .90) warnings.push('Outline masks differ substantially even after coarse translation; addition/deletion candidates require visual inspection.');
    if (paired.orientation.clockwiseDegrees || paired.orientation.mirroredHorizontally) warnings.push(`Completed reference aligned with ${paired.orientation.clockwiseDegrees}° rotation${paired.orientation.mirroredHorizontally ? ' and horizontal reflection' : ''}; raw file coordinates are not corresponding positions.`);
    if (lineage.best.mismatchPixels > 0) warnings.push('Sized image is not an exact center-nearest resize of the supplied PNG under any tested right-angle rotation.');
    if (lineage.best.clockwiseDegrees || lineage.best.mirroredHorizontally) warnings.push(`Best source resize lineage uses ${lineage.best.clockwiseDegrees}° rotation${lineage.best.mirroredHorizontally ? ' plus horizontal reflection' : ''}.`);
    if (!completePaletteCovered) warnings.push('Completed image contains used colors beyond the source palette after 5-bit normalization.');
    const metadataTarget = source.dpiX && source.dpiY ? { width: Math.round(source.image.width / source.dpiX * read), height: Math.round(source.image.height / source.dpiY * pick) } : null;
    if (metadataTarget && (metadataTarget.width !== sized.width || metadataTarget.height !== sized.height)) warnings.push('PNG DPI × filename read/pick does not reproduce authoritative sized dimensions; do not infer output size solely from metadata.');
    const v1Baselines = [];
    for (const [kind, raster] of [['source', source.image], ['sized', sized]] as const) {
      const v1 = cleanRasterV1(raster, { width: sized.width, height: sized.height, read, pick, strength: 'balanced', flattenTexture: true, outlineColor: darkest(raster), protectedColors: [], repeatX: false, repeatY: false });
      const measured = statistics(v1.image).description;
      const file = `${triple.id}-v1-${kind}-balanced-texture.bmp`;
      await writeFile(path.join(output, file), encodeBmp(v1.image, read, pick));
      v1Baselines.push({ input: kind, file, settings: { strength: 'balanced', flattenTexture: true, outlineColor: hex(raster.palette[darkest(raster)]) }, stats: v1.stats, measured, warning: kind === 'source' && (lineage.best.mismatchPixels > 0 || lineage.best.clockwiseDegrees !== 0 || lineage.best.mirroredHorizontally) ? 'Original PNG baseline differs from supplied sized file; preserve this distinction when comparing quality.' : null });
    }
    const sample = { id: triple.id, files: { source: path.relative(project, path.join(input, triple.source)).replaceAll('\\', '/'), sized: path.relative(project, path.join(input, triple.sized)).replaceAll('\\', '/'), reference: path.relative(project, path.join(input, triple.complete)).replaceAll('\\', '/') }, hashes: { source: createHash('sha256').update(sourceBuffer).digest('hex'), sized: createHash('sha256').update(sizedBuffer).digest('hex'), reference: createHash('sha256').update(completeBuffer).digest('hex') }, settings: { read, pick, width: sized.width, height: sized.height, outlineColor: hex(sized.palette[sa.outline]), repeatX: false, repeatY: false, settingBasis: 'Target dimensions from supplied sized BMP; read/pick parsed from filename; darkest palette color is a reviewable outline assumption.' }, source: { width: source.image.width, height: source.image.height, pixels: source.image.pixels.length, palette: source.image.palette.map(hex), dpiX: source.dpiX, dpiY: source.dpiY, nonOpaquePixels: source.nonOpaquePixels, metadataTarget }, sized: { ...sa.description, bitsPerPixel: sizedBuffer.readUInt16LE(28) }, completed: { ...cb.description, bitsPerPixel: completeBuffer.readUInt16LE(28), usedPalette: completeColors, paletteCoveredBySourceAfter5BitNormalization: completePaletteCovered }, sourceResizeLineage: lineage, pairComparison: detail.description, crops, v1Baselines, warnings, evaluationEligibility: { supportedByCurrentLimits: source.image.pixels.length <= MAX_SOURCE_PIXELS && sized.pixels.length <= MAX_OUTPUT_PIXELS, dimensionsMatch: sized.width === complete.width && sized.height === complete.height, possibleTranslation: offset !== null, rawAgreementIsAccuracy: false } };
    sample.settings.settingBasis = 'Target dimensions from sized BMP; R/P from filename. Outline uses the shared UI suggestOutlineColor function (lowest luminance among colors occupying >=0.1% of raster), a reviewable heuristic; several designs have multicolor outlines.';
    Object.assign(sample, { outlineSelection: { sourceHeuristic: 'Shared UI suggestOutlineColor: lowest weighted luminance (0.2126R+0.7152G+0.0722B), excluding colors below0.1% of image area unless none qualify.', completedCorrespondence: referenceColor, note: 'This is not a semantic outline label. Source and sized may differ and each uses its own controlled outline choice for frozen v1 baselines.' } });
    samples.push(sample);
    await Promise.all([writeFile(path.join(output, `${triple.id}-contact.png`), writeSheet(sized, paired.image, detail, crops)), writeFile(path.join(output, `${triple.id}-sized.png`), preview(sized)), writeFile(path.join(output, `${triple.id}-complete.png`), preview(paired.image)), writeFile(path.join(output, `${triple.id}.json`), JSON.stringify(sample, null, 2) + '\n')]);
    console.log(`${triple.id}: ${sized.width}×${sized.height} → ${complete.width}×${complete.height}; source baseline ${lineage.best.mismatchPixels} mismatches at ${lineage.best.clockwiseDegrees}°; singleton8 ${sa.description.singleton8}→${cb.description.singleton8}; outline additions ${detail.description.outlineAdded}; gap-fill candidates ${detail.description.candidateGapFilled}`);
  }
  if (only) { const previous = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')) as { samples: typeof samples }; samples.push(...previous.samples.filter(s => s.id !== only)); samples.sort((a, b) => a.id.localeCompare(b.id)); }
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), inputDirectory: path.relative(project, input).replaceAll('\\', '/'), samples, methodology: { role: 'Reusable dataset inventory and candidate review manifest; not pixel accuracy ground truth.', spatialMapping: 'At most ±8px global translation chosen using coarse two-class outline-mask mean IoU. Completed(x+dx,y+dy) corresponds provisionally to Sized(x,y).', colors: 'RGB channels truncated with &248 for descriptive paired comparison; source-resize lineage checks exact RGB.', gapCandidates: 'Non-outline pixel with opposite immediate outline neighbors in one of four directions; a completed outline at that location is a candidate repair, not proof of correct bridging.', limitations: ['Darkest color may be background or several differently colored outlines may exist.', 'Reference recoloring, repeat alignment, redraws, changed dimensions and local distortions can generate false additions/removals.', 'Singleton counts and raw agreements cannot measure accuracy or saved manual time.', 'Crops are intentionally selected for high candidate density and are diagnostic, not representative population error rates.'], recommendedEvaluation: ['Use authoritative sized raster as the unchanged baseline, preserving exact palette and file dimensions; separately verify raw-PNG-to-sized lineage.', 'Hand-label 20–50 representative missing-line spans, intentional holes, small ornaments, noise patches and clean controls per design; store accept/reject masks and source evidence.', 'Measure bridge recall only on accepted missing spans, false closures on protected holes/negative gaps, ornament retention, isolated-noise precision/recall and per-color area changes.', 'Report source/runtime/export validity on all ten cases, including large-image coverage; exclude 42850-patto from pixel-paired scoring until its crop/rotation/re-layout is clarified.', 'Tune on design IDs42482 and42850; evaluate locked parameters on42973 and45842 to reduce repeated-motif leakage across pallu/bodi/patto of the same design.', 'Measure actual remaining NedGraphics correction minutes with the operator on untouched test designs; report quality separately from runtime.'] } };
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const table = samples.map(s => `| ${s.id} | ${s.source.width}×${s.source.height} | ${s.sized.width}×${s.sized.height} | ${s.completed.width}×${s.completed.height} | ${s.settings.read}/${s.settings.pick} | ${s.sourceResizeLineage.best.clockwiseDegrees}° / ${s.sourceResizeLineage.best.mismatchPixels} | ${s.sized.singleton8}→${s.completed.singleton8} | ${s.pairComparison.candidateGapFilled} |`).join('\n');
  const md = `# Jacquard sample inventory and cleanup diagnostics\n\nGenerated ${manifest.generatedAt}. ${samples.length} PNG/sized/completed triples. **These are descriptive diagnostics, not an accuracy score.**\n\n| Sample | PNG | Sized | Completed | R/P | Best rotation / source resize mismatches | 8-connected singletons | Candidate gap fills |\n|---|---|---|---|---|---|---|---|\n${table}\n\n## How to inspect\n\nOpen [review.html](review.html). Contact-sheet columns are sized, provisionally aligned completed, and changes: pink=added outline, teal=removed outline, purple=other normalized color change. Rows target small-component noise, candidate gap fills, and added outline. Original coordinates and counts are in the manifest. High-density crops intentionally expose problems; they do not estimate overall error rate.\n\n## Dataset issues\n\n${samples.map(s => `### ${s.id}\n\n${s.warnings.length ? s.warnings.map(w => `- ${w}`).join('\n') : '- Dimensions, tested source resize, palette and current size limits pass basic eligibility checks. Designer recoloring and local edits still require review.'}\n`).join('\n')}\n## Proposed honest evaluation\n\n${manifest.methodology.recommendedEvaluation.map(x => `- ${x}`).join('\n')}\n\n## Method limits\n\n${manifest.methodology.limitations.map(x => `- ${x}`).join('\n')}\n`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loom Clean sample analysis</title><style>body{background:#0d1518;color:#ecf4f1;font:16px/1.55 system-ui;margin:0}main{max-width:1440px;margin:auto;padding:30px}h1{font-size:34px}a{color:#77dfd2}section{border:1px solid #304344;border-radius:12px;padding:20px;margin:28px 0}p,li{max-width:105ch;color:#b8ccca}img{max-width:100%;image-rendering:pixelated}.columns{display:grid;grid-template-columns:repeat(3,1fr);text-align:center;margin:12px 0;color:#a6c3bd}.previews{display:flex;gap:20px;align-items:flex-start;overflow:auto}.previews img{max-height:400px;width:auto}.warning{border-left:3px solid #ddb775;padding:12px;background:#202828}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:10px;border-bottom:1px solid #334444}</style><main><h1>10-design sample diagnostics</h1><p><a href="manifest.json">Reusable evaluation manifest</a> · <a href="report.md">Analysis report</a></p><div class="warning">Raw completed-vs-sized agreement is not accuracy. Completed artwork can include recoloring, redrawing, repeat alignment and geometry changes. Pink marks an outline addition; teal marks outline removal; purple marks another normalized color change. These are review candidates.</div><table><tr><th>Sample</th><th>Sized → completed</th><th>R/P</th><th>Singletons</th><th>Candidate fills</th></tr>${samples.map(s => `<tr><td><a href="#${s.id}">${s.id}</a></td><td>${s.sized.width}×${s.sized.height} → ${s.completed.width}×${s.completed.height}</td><td>${s.settings.read}/${s.settings.pick}</td><td>${s.sized.singleton8} → ${s.completed.singleton8}</td><td>${s.pairComparison.candidateGapFilled}</td></tr>`).join('')}</table>${samples.map(s => `<section id="${s.id}"><h2>${s.id}</h2><p>Source nearest-resize: ${s.sourceResizeLineage.best.mismatchPixels.toLocaleString()} mismatches at ${s.sourceResizeLineage.best.clockwiseDegrees}°. Global offset: ${s.pairComparison.offset ? `${s.pairComparison.offset.dx},${s.pairComparison.offset.dy}; coarse mask mean IoU ${s.pairComparison.offset.maskMeanIoU.toFixed(3)}` : 'not compared; reference shown at relative positions'}. <a href="${s.id}.json">Case data</a></p>${s.warnings.length ? `<ul>${s.warnings.map(w => `<li>${w}</li>`).join('')}</ul>` : ''}<div class="columns"><span>Sized</span><span>Completed${s.pairComparison.offset ? ' · provisional translation' : ' · different geometry'}</span><span>Descriptive changes</span></div><img src="${s.id}-contact.png" alt="${s.id} diagnostic crops"><ol>${s.crops.map(c => `<li>${c.label}. Sized x${c.x}, y${c.y}, ${c.w}×${c.h}; ${c.count} selected candidates.</li>`).join('')}</ol><details><summary>Full design previews</summary><div class="previews"><img src="${s.id}-sized.png" alt="Sized design"><img src="${s.id}-complete.png" alt="Completed design"></div></details></section>`).join('')}</main></html>`;
  await Promise.all([writeFile(path.join(output, 'report.md'), md), writeFile(path.join(output, 'review.html'), html.replace('10-design sample diagnostics', `${samples.length} sample triples · ${new Set(samples.map(s => s.id.split('-')[0])).size} design IDs`).replaceAll('<img ', '<img loading="lazy" decoding="async" '))]);
  console.log(`Saved ${path.join(output, 'manifest.json')}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
