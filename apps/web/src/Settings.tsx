import { useState } from 'react';
import type { WorkspaceSettings } from '../../../packages/app-model/src';
import { addMissingMachineProfiles, MAX_MACHINE_PROFILES } from '../../../packages/app-model/src/machine-presets';
import { MAX_COLORS, type MachineProfile } from '../../../packages/core/src/types';
import { paletteSchema, profileSchema } from '../../../packages/core/src/schemas';
import { hexToRgb, Icon, Notice, request, rgbToHex, ScreenHeader, Spinner } from './ui';
import './library.css';

interface Props { settings: WorkspaceSettings; onSaved: (settings: WorkspaceSettings) => void; onCancel: () => void }
export default function Settings({ settings, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<WorkspaceSettings>(() => structuredClone(settings));
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [removeId, setRemoveId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState(settings.defaultProfileId);
  const [profileSearch, setProfileSearch] = useState('');
  const [profileNotice, setProfileNotice] = useState('');
  const search = profileSearch.trim().toLowerCase();
  const visibleProfiles = draft.profiles.filter(profile => profile.id === expandedId || `${profile.name} ${profile.hooks} ${profile.hooks.toLocaleString()} ${profile.epi}/${profile.ppi} ${profile.notes ?? ''}`.toLowerCase().includes(search));
  const missingPresetCount = addMissingMachineProfiles(draft.profiles).length - draft.profiles.length;
  const updateProfile = (id: string, changes: Partial<MachineProfile>) => setDraft(value => ({ ...value, profiles: value.profiles.map(profile => {
    if (profile.id !== id) return profile;
    const next = { ...profile, ...changes };
    const automaticName = (item: MachineProfile) => `${item.hooks.toLocaleString('en-US')} hooks · ${item.epi} EPI / ${item.ppi} PPI`;
    if (changes.name === undefined && profile.name === automaticName(profile)) next.name = automaticName(next);
    return next;
  }) }));
  function addProfile() {
    if (draft.profiles.length >= MAX_MACHINE_PROFILES) return;
    const id = crypto.randomUUID();
    setDraft(value => ({ ...value, profiles: [{ id, name: 'New machine', hooks: 2400, epi: 96, ppi: 52 }, ...value.profiles], defaultProfileId: value.defaultProfileId || id }));
    setProfileSearch(''); setExpandedId(id); setRemoveId(null); setProfileNotice('');
  }
  function addPresets() {
    const profiles = addMissingMachineProfiles(draft.profiles);
    const addedCount = profiles.length - draft.profiles.length;
    setDraft(value => ({ ...value, profiles }));
    setProfileSearch('');
    setProfileNotice(`${addedCount} preset ${addedCount === 1 ? 'profile added' : 'profiles added'}. Save settings to keep them.`);
  }
  function removeProfile(id: string) {
    if (draft.profiles.length < 2) { setError('Keep at least one machine profile in this workspace.'); return; }
    if (draft.defaultProfileId === id) { setError('Choose another default machine before removing this profile.'); return; }
    setDraft(value => ({ ...value, profiles: value.profiles.filter(profile => profile.id !== id) })); setRemoveId(null); setProfileNotice('');
    if (expandedId === id) setExpandedId('');
  }
  async function save() {
    setError('');
    try {
      if (!draft.name.trim()) throw new Error('Give your workspace a name.');
      if (!draft.profiles.length || !draft.profiles.some(profile => profile.id === draft.defaultProfileId)) throw new Error('Choose a default machine profile.');
      if (draft.profiles.length > MAX_MACHINE_PROFILES) throw new Error(`Keep up to ${MAX_MACHINE_PROFILES} machine profiles in this workspace.`);
      if (draft.profiles.some(profile => !profile.name.trim())) throw new Error('Every machine profile needs a name.');
      for (const profile of draft.profiles) profileSchema.parse(profile);
      paletteSchema.parse(draft.defaultPalette);
      if (draft.defaultPalette.entries.some(entry => !entry.name.trim())) throw new Error('Give each palette color a name.');
      setSaving(true);
      const next = { ...draft, name: draft.name.trim(), profiles: draft.profiles.map(profile => ({ ...profile, name: profile.name.trim() })) };
      const saved = await request<WorkspaceSettings>('/api/workspace', { method: 'PUT', body: JSON.stringify(next) }); onSaved(saved ?? next);
    } catch (error) {
      const validation = error as { issues?: { message: string }[]; message: string };
      setError(validation.issues ? 'Check the machine values and colors. Hooks must be a positive whole number; EPI and PPI must be greater than zero.' : validation.message);
    } finally { setSaving(false); }
  }
  return <main className="jdm-settings jdm-screen">
    <ScreenHeader eyebrow="YOUR LOCAL WORKSPACE" title="Workspace settings" description="Set the machines and colors you start every design with." back={saving ? undefined : onCancel}><button className="jdm-button" onClick={onCancel} disabled={saving}>Cancel</button><button className="jdm-button jdm-button-primary" onClick={() => void save()} disabled={saving}>{saving ? <Spinner label="Saving…" /> : <><Icon name="check" /> Save settings</>}</button></ScreenHeader>
    {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
    <fieldset className="jdm-settings-fields" disabled={saving} aria-label="Workspace settings fields">
    <section className="jdm-settings-section"><div className="jdm-section-intro"><div className="jdm-section-number">01</div><h2>Workspace</h2><p>A familiar name for this computer's design library.</p></div><div className="jdm-settings-body"><label className="jdm-field">Workspace name<input className="jdm-input" value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} placeholder="Your studio" maxLength={120} /></label><div className="jdm-fine jdm-local-note"><span className="jdm-local-dot" /> Designs and settings are stored on this computer.</div></div></section>
    <section className="jdm-settings-section"><div className="jdm-section-intro"><div className="jdm-section-number">02</div><h2>Machine profiles</h2><p>Choose a preset capacity, then match the hooks to your machine's available design hooks.</p><p>Presets start at 96 EPI and 52 PPI. Edit these fabric settings to control the physical size of your exports.</p><p className="jdm-fine">EPI is ends per inch. Reed count can differ depending on denting (ends per dent). Profiles used by saved designs must remain available.</p></div><div className="jdm-settings-body jdm-profiles">
      <label className="jdm-search jdm-profile-search"><Icon name="search" size={18} /><input type="search" aria-label="Search machine profiles" placeholder="Search by name, hooks or density" value={profileSearch} onChange={event => { setProfileSearch(event.target.value); setExpandedId(''); setRemoveId(null); }} /></label>
      <div className="jdm-profile-actions">
        <button className="jdm-button jdm-button-add" onClick={addProfile} disabled={draft.profiles.length >= MAX_MACHINE_PROFILES}><Icon name="plus" size={17} /> Add custom machine profile</button>
        <button className="jdm-button jdm-button-small" onClick={addPresets} disabled={missingPresetCount === 0}>Add missing preset profiles{missingPresetCount > 0 ? ` (${missingPresetCount})` : ''}</button>
      </div>
      <p className="jdm-fine jdm-profile-count">{search ? `${visibleProfiles.length} of ${draft.profiles.length}` : draft.profiles.length} profiles · Open a profile to edit.{draft.profiles.length >= MAX_MACHINE_PROFILES ? ` Maximum ${MAX_MACHINE_PROFILES} profiles reached.` : ''}</p>
      {profileNotice && <Notice tone="success" onClose={() => setProfileNotice('')}>{profileNotice}</Notice>}
      {visibleProfiles.length === 0 && <p className="jdm-profile-no-results">No matching profiles. Try a machine name or hook count.</p>}
      {visibleProfiles.map(profile => {
        const expanded = expandedId === profile.id;
        const isDefault = draft.defaultProfileId === profile.id;
        return <article className={`jdm-profile-card jdm-profile-accordion${expanded ? ' is-expanded' : ''}`} key={profile.id}>
          <button className="jdm-profile-summary" aria-expanded={expanded} aria-controls={`machine-profile-${profile.id}`} onClick={() => { setExpandedId(expanded ? '' : profile.id); setRemoveId(null); }}>
            <span className="jdm-profile-summary-text"><strong>{profile.name || 'Unnamed machine'}</strong><span>{profile.hooks.toLocaleString()} hooks · {profile.epi} EPI · {profile.ppi} PPI</span></span>
            {isDefault && <span className="jdm-pill">Default</span>}
            <span className="jdm-profile-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
          </button>
          {expanded && <div className="jdm-profile-details" id={`machine-profile-${profile.id}`}>
            <div className="jdm-profile-title"><label className="jdm-field">Machine name<input className="jdm-input" value={profile.name} onChange={event => updateProfile(profile.id, { name: event.target.value })} /></label><label className="jdm-default-profile"><input type="radio" name="default-profile" checked={isDefault} onChange={() => setDraft(value => ({ ...value, defaultProfileId: profile.id }))} /> Default</label></div>
            <div className="jdm-profile-values">
              <label className="jdm-field">Total hooks<span className="jdm-fine">available for the design</span><input className="jdm-input" type="number" min="1" step="1" value={profile.hooks || ''} onChange={event => updateProfile(profile.id, { hooks: Number(event.target.value) })} /></label>
              <label className="jdm-field">Reed / EPI<span className="jdm-fine">ends / inch</span><input className="jdm-input" type="number" min="0.01" step="any" value={profile.epi || ''} onChange={event => updateProfile(profile.id, { epi: Number(event.target.value) })} /></label>
              <label className="jdm-field">Pick / PPI<span className="jdm-fine">picks / inch</span><input className="jdm-input" type="number" min="0.01" step="any" value={profile.ppi || ''} onChange={event => updateProfile(profile.id, { ppi: Number(event.target.value) })} /></label>
            </div>
            <label className="jdm-field">Notes <span className="jdm-fine">optional</span><input className="jdm-input" value={profile.notes ?? ''} onChange={event => updateProfile(profile.id, { notes: event.target.value })} placeholder="Loom, fabric, or setup notes" /></label>
            {removeId === profile.id ? <div className="jdm-inline-confirm"><span>Remove this profile?</span><div><button className="jdm-button jdm-button-small" onClick={() => setRemoveId(null)}>Keep</button><button className="jdm-button jdm-button-small jdm-button-danger" onClick={() => removeProfile(profile.id)}>Remove</button></div></div> : <button className="jdm-link-button jdm-remove-profile" onClick={() => setRemoveId(profile.id)}>Remove profile</button>}
          </div>}
        </article>;
      })}
    </div></section>
    <section className="jdm-settings-section"><div className="jdm-section-intro"><div className="jdm-section-number">03</div><h2>Starting palette</h2><p>Choose the starting colors for new sketch masters, up to {MAX_COLORS} including ground and outlines. Uploaded images use their own colors.</p><p className="jdm-fine">Display colors are used in the editor. Export colors are written into PNG and BMP files.</p></div><div className="jdm-settings-body"><div className="jdm-palette-head"><span>Slot / name</span><span>Display</span><span>Export</span></div><div className="jdm-settings-palette-list">{draft.defaultPalette.entries.map((entry, index) => <div className="jdm-palette-row" key={entry.index}><label className="jdm-palette-name"><span className="jdm-color-index" style={{ background: rgbToHex(entry.displayRgb) }}>{entry.index}</span><input className="jdm-input" aria-label={`Color ${entry.index} name`} value={entry.name} onChange={event => setDraft(value => ({ ...value, defaultPalette: { entries: value.defaultPalette.entries.map((color, i) => i === index ? { ...color, name: event.target.value } : color) } }))} /></label><label className="jdm-color-input"><input type="color" aria-label={`${entry.name} display color`} value={rgbToHex(entry.displayRgb)} onChange={event => setDraft(value => ({ ...value, defaultPalette: { entries: value.defaultPalette.entries.map((color, i) => i === index ? { ...color, displayRgb: hexToRgb(event.target.value) } : color) } }))} /><span>{rgbToHex(entry.displayRgb).toUpperCase()}</span></label><label className="jdm-color-input"><input type="color" aria-label={`${entry.name} export color`} value={rgbToHex(entry.exportRgb)} onChange={event => setDraft(value => ({ ...value, defaultPalette: { entries: value.defaultPalette.entries.map((color, i) => i === index ? { ...color, exportRgb: hexToRgb(event.target.value) } : color) } }))} /><span>{rgbToHex(entry.exportRgb).toUpperCase()}</span></label></div>)}</div>{draft.defaultPalette.entries.length < MAX_COLORS && <button className="jdm-button jdm-button-add" onClick={() => setDraft(value => ({ ...value, defaultPalette: { entries: [...value.defaultPalette.entries, { index: value.defaultPalette.entries.length, name: 'New color', displayRgb: [90, 105, 98], exportRgb: [90, 105, 98] }] } }))}><Icon name="plus" /> Add palette color</button>}<p className="jdm-fine">Slot 0 is ground. Existing masters keep their own palettes.</p></div></section>
    </fieldset>
  </main>;
}
