import { MAX_OUTPUT_PIXELS, MAX_SIDE, type CleanupOptions, type IndexedImage } from './types';

export interface TextureRegionProposal {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  pixelIndices: Uint32Array;
  replacementColors: Uint8Array;
  removedPixels: number;
  label: string;
}
export interface TextureRegionResult {
  proposals: TextureRegionProposal[];
  scannedPixels: number;
  totalPixels: number;
  /** Full-grid evidence was scanned, but bounded proposal growth/count stopped early. */
  limited: boolean;
}
const STEP = 8, MAX_REGIONS = 256;
const directions = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;

function validate(image: IndexedImage) {
  const { width, height, pixels, palette } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_OUTPUT_PIXELS || pixels.length !== width * height) throw new Error('Region cleanup needs a valid supported output grid.');
  if (!palette.length || palette.length > 256 || palette.some(c => c.length !== 3 || c.some(v => !Number.isInteger(v) || v < 0 || v > 255))) throw new Error('Region cleanup needs an indexed RGB palette.');
}

/** Whole-field, deterministic texture proposals. No neural model or automatic acceptance is implied. */
export function proposeTextureRegions(image: IndexedImage, options: CleanupOptions): TextureRegionResult {
  validate(image);
  const { width: w, height: h, pixels, palette } = image, n = pixels.length;
  const locked = new Uint8Array(palette.length);
  if (options.outlineColor !== null && (!Number.isInteger(options.outlineColor) || options.outlineColor < 0 || options.outlineColor >= palette.length)) throw new Error('Invalid primary outline ink.');
  for (const color of options.protectedColors) { if (!Number.isInteger(color) || color < 0 || color >= palette.length) throw new Error('Invalid protected region ink.'); locked[color] = 1; }
  for (const color of pixels) if (color >= palette.length) throw new Error('Invalid indexed region pixel.');
  const at = (x: number, y: number): number => {
    if (x < 0 || x >= w) { if (!options.repeatX) return -1; x = (x % w + w) % w; }
    if (y < 0 || y >= h) { if (!options.repeatY) return -1; y = (y % h + h) % h; }
    return y * w + x;
  };
  const seen = new Uint8Array(n), queue = new Uint32Array(n), grain = new Uint8Array(n), solid = new Uint8Array(n), structure = new Uint8Array(n);
  const floodInk = (seed: number, diagonal: boolean) => {
    queue[0] = seed; seen[seed] = 1; let tail = 1;
    for (let head = 0; head < tail; head++) {
      const i = queue[head], x = i % w, y = Math.floor(i / w);
      for (let d = 0; d < 8; d += diagonal ? 1 : 2) {
        const [dx, dy] = directions[d], j = at(x + dx, y + dy);
        if (j >= 0 && !seen[j] && pixels[j] === pixels[seed]) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    return tail;
  };
  const boundsOf = (count: number) => {
    let left = w, top = h, right = -1, bottom = -1;
    for (let k = 0; k < count; k++) { const i = queue[k], x = i % w, y = Math.floor(i / w); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
  };
  // Fine components seed a field; they do not limit the size of the eventual edit.
  for (let seed = 0; seed < n; seed++) {
    if (seen[seed]) continue;
    const count = floodInk(seed, false);
    const box = boundsOf(count);
    const compact = count >= 6 && count / (box.width * box.height) >= .72 && Math.max(box.width / box.height, box.height / box.width) < 3;
    const substantial = compact && count >= 32 && Math.min(box.width, box.height) >= 3;
    const fine = count <= 8 && Math.max(box.width, box.height) <= 7;
    for (let k = 0; k < count; k++) { if (compact || count >= 64) solid[queue[k]] = substantial ? 3 : 1; if (fine && !compact) grain[queue[k]] = count <= 2 ? 4 : count <= 4 ? 2 : 1; }
  }
  // Preserve long fine curves and meaningful closed contours. Compact dots are
  // deliberately not a universal veto: designers may flatten stippled fills.
  seen.fill(0);
  for (let seed = 0; seed < n; seed++) {
    if (seen[seed]) continue;
    const count = floodInk(seed, true);
    if (count < 4) continue;
    const box = boundsOf(count);
    // Repeated curved hatches often join into a large branching network after
    // resampling. Their long, sparse connected band remains structural evidence.
    if (count > 2048 && Math.max(box.width, box.height) >= 28 && Math.max(box.width / box.height, box.height / box.width) >= 3 && count / (box.width * box.height) <= .45) {
      for (let k = 0; k < count; k++) structure[queue[k]] = 8;
      continue;
    }
    if (count > 2048) continue;
    if (box.width > 256 || box.height > 256 || box.width * box.height > 16384) continue;
    let branches = 0, junctions = 0;
    if (count >= 24 || (Math.max(box.width, box.height) >= 7 && count <= Math.max(box.width, box.height) * 3)) {
      for (let k = 0; k < count; k++) {
        const i = queue[k], x = i % w, y = Math.floor(i / w); let neighbors = 0;
        for (const [dx, dy] of directions) { const j = at(x + dx, y + dy); if (j >= 0 && pixels[j] === pixels[seed]) neighbors++; }
        if (neighbors >= 4) branches++;
        if (neighbors >= 3) junctions++;
      }
      // Filled diagonal leaves can split into tiny 4-components. Strong local
      // occupancy protects their tapered tips against outline-background fill.
      // Keep this out of non-outline shading, whose grain can form dense blobs.
      if (count >= 24 && branches / count >= .82 && junctions / count >= .88) for (let k = 0; k < count; k++) solid[queue[k]] |= 1;
      if (Math.max(box.width, box.height) >= 7 && count <= Math.max(box.width, box.height) * 3 && branches / count <= .10 && junctions / count <= .4) { for (let k = 0; k < count; k++) structure[queue[k]] = count >= 24 ? 1 : 4; continue; }
    }
    if (box.width < 3 || box.height < 3 || box.width > 32 || box.height > 32 || count > 256 || count / (box.width * box.height) > .72) continue;
    const stride = box.width + 2, cells = new Uint8Array(stride * (box.height + 2)), exterior = new Uint16Array(cells.length);
    for (let k = 0; k < count; k++) { const i = queue[k]; cells[(Math.floor(i / w) - box.top + 1) * stride + i % w - box.left + 1] = 1; }
    cells[0] = 2; exterior[0] = 0; let tail = 1;
    for (let head = 0; head < tail; head++) {
      const i = exterior[head], x = i % stride, y = Math.floor(i / stride);
      for (const j of [x ? i - 1 : -1, x + 1 < stride ? i + 1 : -1, y ? i - stride : -1, y + 1 < box.height + 2 ? i + stride : -1]) if (j >= 0 && !cells[j]) { cells[j] = 2; exterior[tail++] = j; }
    }
    let hole = 0; for (const value of cells) if (!value) hole++;
    if (hole >= 4 && hole >= box.width * box.height * .25) for (let k = 0; k < count; k++) structure[queue[k]] = 2;
  }
  // Straight lattice bars can belong to one large connected component; preserve
  // their runs independently of component size and branching at intersections.
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    if (structure[i]) continue;
    const color = pixels[i];
    for (const [dx, dy] of directions.slice(0, 4)) {
      const step = dy * w + dx;
      if (pixels[i - 2 * step] !== color || pixels[i - step] !== color || pixels[i + step] !== color || pixels[i + 2 * step] !== color) continue;
      const normal = -dx * w + dy;
      if (pixels[i - normal] !== color && pixels[i + normal] !== color) for (let k = -2; k <= 2; k++) structure[i + k * step] |= 4;
    }
  }

  const columns = Math.ceil(w / STEP), rows = Math.ceil(h / STEP), cells = columns * rows;
  const pair = new Uint16Array(cells), strength = new Float32Array(cells), pattern = new Uint8Array(cells), votes = new Uint16Array(palette.length);
  const seeds: number[] = [], radius = 10;
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < columns; cx++) {
    votes.fill(0); let count = 0, fragments = 0, edges = 0, strokes = 0;
    const x = Math.min(w - 1, cx * STEP + 4), y = Math.min(h - 1, cy * STEP + 4);
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const i = at(x + dx, y + dy); if (i < 0) continue;
      votes[pixels[i]]++; count++; fragments += grain[i]; strokes += Number(structure[i] !== 0);
      const right = at(x + dx + 1, y + dy), below = at(x + dx, y + dy + 1);
      if (right >= 0 && pixels[right] !== pixels[i]) edges++;
      if (below >= 0 && pixels[below] !== pixels[i]) edges++;
    }
    let a = 0, b = 0;
    for (let c = 0; c < votes.length; c++) if (votes[c] > votes[a]) a = c;
    b = a === 0 ? 1 : 0;
    if (b >= votes.length) continue;
    for (let c = 0; c < votes.length; c++) if (c !== a && votes[c] > votes[b]) b = c;
    const cell = cy * columns + cx;
    if (votes[b] < count * .055 || votes[a] + votes[b] < count * .90) continue;
    let xx = 0, yy = 0, xy = 0;
    const same = (px: number, py: number) => { const i = at(px, py); return i >= 0 && pixels[i] === b ? 1 : 0; };
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      const gx = same(x + dx + 1, y + dy) - same(x + dx - 1, y + dy);
      const gy = same(x + dx, y + dy + 1) - same(x + dx, y + dy - 1);
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
    const coherence = xx + yy ? Math.hypot(xx - yy, 2 * xy) / (xx + yy) : 0;
    let regular = false;
    // Periodic crosshatching has two directions and can have low orientation
    // coherence. Its spatial recurrence distinguishes it from stochastic grain.
    const chance = (votes[a] ** 2 + votes[b] ** 2) / count ** 2;
    if (fragments >= count * .18 && votes[b] >= count * .15 && coherence < .52) for (let lag = 3; lag <= 8 && !regular; lag++) {
      for (const [dx, dy] of [[lag, 0], [0, lag]]) {
        let equal = 0, tested = 0;
        for (let oy = -8; oy <= 8; oy += 2) for (let ox = -8; ox <= 8; ox += 2) {
          const i = at(x + ox, y + oy), j = at(x + ox + dx, y + oy + dy);
          if (i < 0 || j < 0 || (pixels[i] !== a && pixels[i] !== b) || (pixels[j] !== a && pixels[j] !== b)) continue;
          tested++; if (pixels[i] === pixels[j]) equal++;
        }
        if (tested >= 50 && (equal / tested - chance) / Math.max(.01, 1 - chance) >= .70) { regular = true; break; }
      }
    }
    if ((coherence >= .52 && votes[b] >= count * .12) || regular || strokes > count * .38) { pattern[cell] = 1; continue; }
    if (locked[a] || locked[b] || fragments < count * .18 || edges < count * .27) continue;
    // The selected outline may also be a broad background, but its thin design
    // contours must never be proposed for replacement by a brighter field ink.
    if ((a === options.outlineColor || b === options.outlineColor) && votes[options.outlineColor!] < count * .58) continue;
    pair[cell] = Math.min(a, b) * 256 + Math.max(a, b) + 1;
    strength[cell] = fragments / count * votes[b] / count;
    seeds.push(cell);
  }
  seeds.sort((a, b) => strength[b] - strength[a] || a - b);
  const envelope = new Uint16Array(cells);
  // A limited texture envelope is essential where an outline ink also forms the
  // connected background of the whole design.
  for (const cell of seeds) {
    const x = cell % columns, y = Math.floor(cell / columns);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      let xx = x + dx, yy = y + dy;
      if (options.repeatX) xx = (xx % columns + columns) % columns;
      if (options.repeatY) yy = (yy % rows + rows) % rows;
      if (xx < 0 || yy < 0 || xx >= columns || yy >= rows) continue;
      const j = yy * columns + xx; if (!envelope[j]) envelope[j] = pair[cell];
    }
  }
  seen.fill(0); // accepted edit ownership, independent of pair visitation
  const visitedPairs = new Uint16Array(n);
  const pairOrder = new Map<number, number>();
  for (const cell of seeds) if (!pairOrder.has(pair[cell])) pairOrder.set(pair[cell], pairOrder.size);
  seeds.sort((a, b) => pairOrder.get(pair[a])! - pairOrder.get(pair[b])! || strength[b] - strength[a] || a - b);
  const proposals: TextureRegionProposal[] = [];
  let growth = 0, limited = false;
  regionLoop: for (const cell of seeds) {
    if (proposals.length >= MAX_REGIONS) { limited = true; break; }
    const code = pair[cell] - 1, a = code >>> 8, b = code & 255;
    const outlinePair = a === options.outlineColor || b === options.outlineColor;
    const cx = cell % columns * STEP, cy = Math.floor(cell / columns) * STEP;
    let seed = -1;
    for (let y = cy; y < Math.min(h, cy + STEP) && seed < 0; y++) for (let x = cx; x < Math.min(w, cx + STEP); x++) { const i = y * w + x; if (visitedPairs[i] !== code + 1 && (pixels[i] === a || pixels[i] === b)) { seed = i; break; } }
    if (seed < 0) continue;
    queue[0] = seed; visitedPairs[seed] = code + 1; let tail = 1, countA = 0, countB = 0, textured = 0;
    for (let head = 0; head < tail; head++) {
      if (growth++ >= n * 8) { limited = true; break regionLoop; }
      const i = queue[head], x = i % w, y = Math.floor(i / w), grid = Math.floor(y / STEP) * columns + Math.floor(x / STEP);
      if (pixels[i] === a) countA++; else countB++;
      if (pair[grid] === code + 1) textured++;
      for (const d of [0, 2, 4, 6]) {
        const [dx, dy] = directions[d], j = at(x + dx, y + dy);
        if (j < 0 || visitedPairs[j] === code + 1 || (pixels[j] !== a && pixels[j] !== b)) continue;
        if (outlinePair && envelope[Math.floor(Math.floor(j / w) / STEP) * columns + Math.floor((j % w) / STEP)] !== code + 1) continue;
        visitedPairs[j] = code + 1; queue[tail++] = j;
      }
    }
    if (textured < 80 || Math.min(countA, countB) < 64) continue;
    const replacement = outlinePair ? options.outlineColor! : countA >= countB ? a : b;
    if (outlinePair && (replacement === a ? countA : countB) < tail * .55) continue;
    let hatchPixels = 0;
    for (let k = 0; k < tail; k++) if (pixels[queue[k]] !== replacement && structure[queue[k]] & 8) hatchPixels++;
    const minorityCount = replacement === a ? countB : countA;
    if (hatchPixels >= 64 && hatchPixels >= minorityCount * .18) continue;
    let changes = 0, left = w, top = h, right = -1, bottom = -1;
    // Reuse the queue prefix to collect edits after the complete region vote.
    for (let k = 0; k < tail; k++) {
      const i = queue[k];
      const grid = Math.floor(Math.floor(i / w) / STEP) * columns + Math.floor((i % w) / STEP);
      if (seen[i] || pixels[i] === replacement || pixels[i] === options.outlineColor || (outlinePair ? structure[i] : structure[i] & 11) || pattern[grid] || (outlinePair ? solid[i] : solid[i] & 2)) continue;
      queue[changes++] = i;
      const x = i % w, y = Math.floor(i / w); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    if (changes < 64) continue;
    for (let k = 0; k < changes; k++) seen[queue[k]] = 1;
    const replacementColors = new Uint8Array(changes); replacementColors.fill(replacement);
    const toHex = (c: number) => '#' + palette[c].map(v => v.toString(16).padStart(2, '0')).join('');
    proposals.push({ id: proposals.length + 1, bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, pixelIndices: queue.slice(0, changes), replacementColors, removedPixels: changes, label: `Flatten ${toHex(a)} / ${toHex(b)} grain to ${toHex(replacement)}` });
  }
  return { proposals, scannedPixels: n, totalPixels: n, limited };
}

/** Apply only the explicitly selected region proposals; the input is never modified. */
export function applyTextureRegions(image: IndexedImage, selected: TextureRegionProposal[]): IndexedImage {
  validate(image);
  if (selected.length > MAX_REGIONS) throw new Error('Too many texture regions selected.');
  const pixels = image.pixels.slice();
  if (!selected.length) return { ...image, pixels };
  const assignments = new Uint16Array(pixels.length);
  for (const proposal of selected) {
    const b = proposal.bounds;
    if (!Number.isSafeInteger(proposal.id) || proposal.id < 1 || ![b.x, b.y, b.width, b.height].every(Number.isInteger) || b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1 || b.x + b.width > image.width || b.y + b.height > image.height || proposal.pixelIndices.length !== proposal.replacementColors.length || proposal.removedPixels !== proposal.pixelIndices.length) throw new Error('Texture proposal has invalid dimensions or buffers.');
    for (let k = 0; k < proposal.pixelIndices.length; k++) {
      const i = proposal.pixelIndices[k], color = proposal.replacementColors[k], x = i % image.width, y = Math.floor(i / image.width);
      if (i >= pixels.length || color >= image.palette.length || x < b.x || x >= b.x + b.width || y < b.y || y >= b.y + b.height) throw new Error('Texture proposal contains an invalid pixel or ink.');
      if (assignments[i] && assignments[i] !== color + 1) throw new Error('Selected texture regions contain conflicting edits.');
      assignments[i] = color + 1; pixels[i] = color;
    }
  }
  return { ...image, pixels };
}
