import type { MachineProfile } from '../../core/src/types';

export const MACHINE_PROFILE_CATALOG_VERSION = 1;
export const MAX_MACHINE_PROFILES = 100;
export const DEFAULT_MACHINE_PROFILE_ID = 'preset-hooks-2400-epi-96-ppi-52';

/**
 * Advertised jacquard formats plus installed 1200/2400/4800 design-hook setups.
 * References and the distinction between head capacity and usable design hooks
 * are recorded in docs/machine-profiles.md. EPI/PPI are editable fabric settings,
 * based on this workspace's requested 96/52 example, not manufacturer specs.
 */
export const MACHINE_HOOK_PRESETS = [
  480, 640, 960, 1200, 1344, 1408, 1440, 1536, 1792, 2048, 2400,
  2688, 2816, 3328, 3840, 4032, 4608, 4800, 5120, 5376, 6144,
] as const;

export const DEFAULT_MACHINE_PROFILES: MachineProfile[] = MACHINE_HOOK_PRESETS.map(hooks => ({
  id: `preset-hooks-${hooks}-epi-96-ppi-52`,
  name: `${hooks.toLocaleString('en-US')} hooks · 96 EPI / 52 PPI`,
  hooks, epi: 96, ppi: 52,
  notes: 'Starting fabric setting: 96 ends/inch and 52 picks/inch. Set hooks to the usable design hooks on your loom; adjust density for the fabric and denting.',
}));

/** Add available presets without replacing edits, equivalent profiles or defaults. */
export function addMissingMachineProfiles(profiles: MachineProfile[]): MachineProfile[] {
  const result = [...profiles], ids = new Set(profiles.map(profile => profile.id));
  const key = (profile: MachineProfile) => `${profile.hooks}/${profile.epi}/${profile.ppi}`;
  const values = new Set(profiles.map(key));
  for (const preset of DEFAULT_MACHINE_PROFILES) {
    if (result.length >= MAX_MACHINE_PROFILES) break;
    if (ids.has(preset.id) || values.has(key(preset))) continue;
    result.push({ ...preset }); ids.add(preset.id); values.add(key(preset));
  }
  return result;
}
