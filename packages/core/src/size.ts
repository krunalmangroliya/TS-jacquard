import type { Bounds, MachineProfile, ResolvedSize, SizeInput } from './types';

function positive(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite number greater than zero`);
  return value;
}
export function nearestDivisors(hooks: number, width: number): number[] {
  const divisors: number[] = [];
  for (let i = 1; i * i <= hooks; i++) if (hooks % i === 0) { divisors.push(i); if (i * i !== hooks) divisors.push(hooks / i); }
  return divisors.sort((a, b) => Math.abs(a - width) - Math.abs(b - width) || a - b).slice(0, 2);
}
export function resolveSize(bounds: Bounds, profile: MachineProfile, input: SizeInput): ResolvedSize {
  positive(bounds.w, 'Master width'); positive(bounds.h, 'Master height');
  positive(profile.hooks, 'Hooks'); positive(profile.epi, 'EPI'); positive(profile.ppi, 'PPI');
  if (!Number.isSafeInteger(profile.hooks)) throw new Error('Hooks must be an integer');
  const aspectKnown = bounds.pixelAspect !== null;
  if (aspectKnown) positive(bounds.pixelAspect ?? 1, 'Source pixel aspect');
  const ratio = bounds.h / bounds.w * (bounds.pixelAspect ?? 1) * profile.ppi / profile.epi;
  if (!aspectKnown && (input.mode === 'fitAcross' || input.linkAspect)) throw new Error('Enter the prepared image’s source EPI and PPI before linking proportions, or specify both pixel dimensions with aspect unlocked.');
  let width: number | undefined, height: number | undefined;
  if (input.mode === 'fitAcross') {
    positive(input.n, 'Repeat count');
    if (!Number.isSafeInteger(input.n)) throw new Error('Repeat count must be an integer');
    width = Math.floor(profile.hooks / input.n);
  } else if (input.mode === 'physical') {
    const factor = input.unit === 'cm' ? 1 / 2.54 : 1;
    if (input.width !== undefined) width = Math.round(positive(input.width, 'Width') * factor * profile.epi);
    if (input.height !== undefined) height = Math.round(positive(input.height, 'Height') * factor * profile.ppi);
    if (!input.linkAspect && (width === undefined || height === undefined)) throw new Error('Specify both dimensions when aspect is unlocked');
  } else {
    width = input.widthPx; height = input.heightPx;
    for (const value of [width, height]) if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Grid dimensions must be positive integers');
    if (!input.linkAspect && (width === undefined || height === undefined)) throw new Error('Specify both dimensions when aspect is unlocked');
  }
  if (width === undefined && height === undefined) throw new Error('Specify at least one size dimension');
  if (width === undefined) width = Math.round(height! / ratio);
  if (height === undefined) height = Math.round(width * ratio);
  positive(width, 'Resolved width'); positive(height, 'Resolved height');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > 40_000_000) throw new Error('Output exceeds the 40 million pixel limit');
  const warnings: string[] = [];
  if (width > profile.hooks) warnings.push(`Width ${width} exceeds ${profile.hooks} available hooks`);
  if (profile.hooks % width) warnings.push(`${width} does not divide ${profile.hooks} hooks evenly (${profile.hooks % width} hooks remain)`);
  if (aspectKnown) {
    const expected = Math.round(width * ratio);
    if (height !== expected) warnings.push(`Physical aspect differs from the master by ${(100 * (height / (width * ratio) - 1)).toFixed(1)}% vertically`);
  } else warnings.push('Source density is unknown. Explicit dimensions are used; physical proportions cannot be compared with the source.');
  return { widthPx: width, heightPx: height, widthIn: width / profile.epi, heightIn: height / profile.ppi, warnings, suggestedWidths: profile.hooks % width ? nearestDivisors(profile.hooks, width) : [] };
}
