// Cross-device sync of presets, settings and AI keys through the server's
// Google Drive app folder. Every item carries an updatedAt time; the newest
// change wins per item, and deletions are kept as tombstones so they spread.
import axios from 'axios';

// Browser-side values that follow the user between devices.
export const SYNCED_SETTINGS = ['loy_clean_name', 'loy_device_names_v2', 'led_last_generated_provider'];
export const SYNCED_SECRETS = ['led_gemini_api_key', 'led_openai_api_key'];
const SNAPSHOT_KEY = 'ledsign_sync_snapshot';
// Bumped when stored data from older builds cannot be trusted; such a
// manifest is ignored and this device uploads everything again.
export const SYNC_FORMAT = 2;
// Preset ids are numbers or strings; manifests key them as strings.
const idOf = (preset) => String(preset.id);
export const SYNC_APPLIED_EVENT = 'ledsign-sync-applied';

// FNV-1a over the JSON text: cheap change detection, not security.
export function hashValue(value) {
  const text = JSON.stringify(value ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// Describe local state as manifest entries, keeping the previous sync's
// timestamp for anything unchanged so it does not look newer than it is.
export function describeLocal({ presets, settings, secrets }, snapshot = {}, now = Date.now()) {
  // On a device's first sync, anything already in the account wins over this
  // device's untouched copies (such as the built-in default presets).
  const firstSync = !snapshot.presets;
  const stamp = (prev, hash) => {
    if (prev && !prev.deleted && prev.hash === hash) return prev.updatedAt;
    return firstSync ? 0 : now;
  };
  const out = { presets: {}, settings: {}, secrets: {} };
  const known = snapshot.presets || {};
  for (const preset of presets) {
    const hash = hashValue(preset);
    out.presets[idOf(preset)] = { hash, updatedAt: stamp(known[idOf(preset)], hash) };
  }
  for (const [id, entry] of Object.entries(known)) {
    if (out.presets[id]) continue;
    out.presets[id] = entry.deleted ? entry : { deleted: true, updatedAt: now };
  }
  const order = presets.map(idOf);
  const orderHash = hashValue(order);
  out.order = { value: order, hash: orderHash, updatedAt: stamp(snapshot.order, orderHash) };
  for (const [group, values] of [['settings', settings], ['secrets', secrets]]) {
    for (const [key, value] of Object.entries(values)) {
      const hash = hashValue(value);
      out[group][key] = { value, hash, updatedAt: stamp(snapshot[group]?.[key], hash) };
    }
  }
  return out;
}

const newer = (a, b) => (a?.updatedAt || 0) > (b?.updatedAt || 0);
const sameEntry = (a, b) => Boolean(a && b) && a.hash === b.hash &&
  a.updatedAt === b.updatedAt && Boolean(a.deleted) === Boolean(b.deleted);

// Decide, item by item, which side wins and what has to move.
export function planSync(local, remote = {}, now = Date.now()) {
  // A first-sync item (updatedAt 0) that wins gets a real time once stored,
  // so the next new device prefers it over its own untouched copy.
  const keep = (entry) => (entry && entry.updatedAt === 0 ? { ...entry, updatedAt: now } : entry);
  const plan = { manifest: { format: SYNC_FORMAT, presets: {}, settings: {}, secrets: {} }, download: [], upload: [], remove: [], applySettings: {}, applySecrets: {} };
  const ids = new Set([...Object.keys(local.presets), ...Object.keys(remote.presets || {})]);
  for (const id of ids) {
    const mine = local.presets[id];
    const theirs = remote.presets?.[id];
    const winner = !mine || newer(theirs, mine) ? theirs : keep(mine);
    plan.manifest.presets[id] = winner;
    if (winner === theirs) {
      if (theirs.deleted) {
        if (mine && !mine.deleted) plan.remove.push(id);
      } else if (!mine || mine.deleted || mine.hash !== theirs.hash) {
        plan.download.push(id);
      }
    } else if (!mine.deleted && (!theirs || theirs.deleted || theirs.hash !== mine.hash)) {
      plan.upload.push(id);
    }
  }
  plan.manifest.order = remote.order && newer(remote.order, local.order) ? remote.order : keep(local.order);
  for (const [group, applyKey] of [['settings', 'applySettings'], ['secrets', 'applySecrets']]) {
    const keys = new Set([...Object.keys(local[group]), ...Object.keys(remote[group] || {})]);
    keys.delete('loySession');
    for (const key of keys) {
      const mine = local[group][key];
      const theirs = remote[group]?.[key];
      if (theirs && (!mine || newer(theirs, mine))) {
        plan.manifest[group][key] = theirs;
        if (!mine || mine.hash !== theirs.hash) plan[applyKey][key] = theirs.value;
      } else {
        plan.manifest[group][key] = keep(mine);
      }
    }
  }
  // The server keeps the LOY SPACE session itself; pass its entry through.
  if (remote.secrets?.loySession) plan.manifest.secrets.loySession = remote.secrets.loySession;
  return plan;
}

// Apply downloads and deletions, then order the list as the winning order says.
export function applyPresetChanges(presets, plan, downloaded) {
  const byId = new Map(presets.map(p => [idOf(p), p]));
  for (const id of plan.remove) byId.delete(id);
  for (const [id, preset] of Object.entries(downloaded)) byId.set(id, preset);
  const ordered = [];
  for (const id of plan.manifest.order?.value || []) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}

const readLocal = (keys) => Object.fromEntries(keys.map(k => {
  try { return [k, localStorage.getItem(k)]; } catch { return [k, null]; }
}));

const writeLocal = (values) => {
  for (const [key, value] of Object.entries(values)) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* storage unavailable */ }
  }
};

const readSnapshot = () => {
  try {
    const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
    return snapshot.format === SYNC_FORMAT ? snapshot : {};
  } catch { return {}; }
};

// One full sync round. Returns what to apply to the preset list (callers use
// applyPresetChanges on their latest list) and throws with `reason` when
// Drive is unusable.
export async function runSync(presets, apiBase = '') {
  const local = describeLocal({ presets, settings: readLocal(SYNCED_SETTINGS), secrets: readLocal(SYNCED_SECRETS) }, readSnapshot());
  let remote;
  try {
    remote = (await axios.get(`${apiBase}/sync/manifest`, { timeout: 30000 })).data || {};
    if (remote.format !== SYNC_FORMAT) {
      // Keep only what the server manages itself.
      remote = { secrets: remote.secrets?.loySession ? { loySession: remote.secrets.loySession } : {}, needsPush: true };
    }
  } catch (err) {
    const detail = err.response?.data?.detail;
    const error = new Error(detail?.message || err.message);
    error.reason = detail?.reason || 'error';
    throw error;
  }
  const plan = planSync(local, remote, Date.now());
  let downloaded = {};
  if (plan.download.length) {
    downloaded = (await axios.post(`${apiBase}/sync/presets`, { ids: plan.download }, { timeout: 120000 })).data?.presets || {};
    // A preset whose file is missing stays as it was locally.
    for (const id of plan.download) {
      if (!downloaded[id] && local.presets[id] && !local.presets[id].deleted) plan.manifest.presets[id] = local.presets[id];
    }
  }
  const nextPresets = applyPresetChanges(presets, plan, downloaded);
  const byId = new Map(nextPresets.map(p => [idOf(p), p]));
  const uploads = Object.fromEntries(plan.upload.filter(id => byId.has(id)).map(id => [id, byId.get(id)]));
  const changedRemote = plan.upload.length > 0 || Boolean(remote.needsPush) ||
    Object.keys(plan.manifest.presets).some(id => !sameEntry(plan.manifest.presets[id], remote.presets?.[id])) ||
    !sameEntry(plan.manifest.order, remote.order) ||
    ['settings', 'secrets'].some(g => Object.keys(plan.manifest[g]).some(k => k !== 'loySession' && !sameEntry(plan.manifest[g][k], remote[g]?.[k])));
  if (changedRemote) {
    await axios.post(`${apiBase}/sync/push`, { manifest: plan.manifest, presets: uploads }, { timeout: 120000 });
  }
  writeLocal(plan.applySettings);
  writeLocal(plan.applySecrets);
  const secrets = { ...plan.manifest.secrets };
  delete secrets.loySession;
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...plan.manifest, secrets }));
  const appliedValues = { ...plan.applySettings, ...plan.applySecrets };
  if (Object.keys(appliedValues).length) {
    window.dispatchEvent(new CustomEvent(SYNC_APPLIED_EVENT, { detail: appliedValues }));
  }
  const presetsChanged = plan.download.length > 0 || plan.remove.length > 0 ||
    nextPresets.some((p, i) => p !== presets[i]) || nextPresets.length !== presets.length;
  return { presetsChanged, plan, downloaded };
}
