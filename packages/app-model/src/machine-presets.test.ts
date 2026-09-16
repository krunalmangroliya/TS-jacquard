import { describe, expect, it } from 'vitest';
import { profileSchema } from '../../core/src/schemas';
import { resolveSize } from '../../core/src/size';
import { addMissingMachineProfiles, DEFAULT_MACHINE_PROFILE_ID, DEFAULT_MACHINE_PROFILES, MAX_MACHINE_PROFILES } from './machine-presets';

describe('ready machine profiles', () => {
  it('provides valid distinct capacities and computes the requested 96/52 dimensions', () => {
    expect(DEFAULT_MACHINE_PROFILES.length).toBe(21);
    expect(new Set(DEFAULT_MACHINE_PROFILES.map(profile => profile.id)).size).toBe(21);
    const profile = DEFAULT_MACHINE_PROFILES.find(profile => profile.id === DEFAULT_MACHINE_PROFILE_ID)!;
    for (const preset of DEFAULT_MACHINE_PROFILES) expect(profileSchema.safeParse(preset).success).toBe(true);
    const result = resolveSize({ w: 100, h: 100 }, profile, { mode: 'physical', unit: 'in', width: 10, height: 10, linkAspect: false });
    expect([result.widthPx, result.heightPx]).toEqual([960, 520]);
  });
  it('preserves edited presets and custom equivalents without adding duplicates', () => {
    const modified = { ...DEFAULT_MACHINE_PROFILES[0], name: 'My border loom', epi: 80, ppi: 60 };
    const equivalent = { ...DEFAULT_MACHINE_PROFILES[1], id: 'my-own-machine', name: 'Our machine' };
    const input = [modified, equivalent], before = structuredClone(input), first = addMissingMachineProfiles(input);
    expect(input).toEqual(before); expect(first.slice(0, 2)).toEqual(before);
    expect(first).toHaveLength(DEFAULT_MACHINE_PROFILES.length);
    expect(first.filter(profile => profile.hooks === equivalent.hooks && profile.epi === equivalent.epi && profile.ppi === equivalent.ppi)).toHaveLength(1);
    expect(addMissingMachineProfiles(first)).toEqual(first);
  });
  it('respects workspace capacity and returns independent appended preset objects', () => {
    const profiles = Array.from({ length: MAX_MACHINE_PROFILES - 1 }, (_, i) => ({ id: `custom-${i}`, name: 'Custom', hooks: 100 + i, epi: 72, ppi: 44 }));
    const merged = addMissingMachineProfiles(profiles);
    expect(merged).toHaveLength(MAX_MACHINE_PROFILES); expect(merged.slice(0, profiles.length)).toEqual(profiles);
    merged.at(-1)!.name = 'Edited locally';
    expect(DEFAULT_MACHINE_PROFILES[0].name).not.toBe('Edited locally');
  });
});
