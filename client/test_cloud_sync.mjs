// Offline checks for the cross-device merge rules in src/cloudSync.js.
import assert from 'node:assert/strict';
import { describeLocal, planSync, applyPresetChanges } from './src/cloudSync.js';

// A tiny in-memory "Drive": one device syncs, the other syncs later.
function device(presets, settings = {}, secrets = {}) {
  return { presets, settings, secrets, snapshot: {} };
}
function sync(dev, drive, now) {
  const local = describeLocal(dev, dev.snapshot, now);
  const plan = planSync(local, drive.manifest, now);
  const downloaded = Object.fromEntries(plan.download.map(id => [id, drive.files[id]]));
  dev.presets = applyPresetChanges(dev.presets, plan, downloaded);
  for (const id of plan.upload) drive.files[id] = dev.presets.find(p => String(p.id) === id);
  for (const [id, entry] of Object.entries(plan.manifest.presets)) if (entry.deleted) delete drive.files[id];
  Object.assign(dev.settings, plan.applySettings);
  Object.assign(dev.secrets, plan.applySecrets);
  drive.manifest = plan.manifest;
  dev.snapshot = plan.manifest;
  return plan;
}

const clock = (text = '') => ({ id: 'clock-default', name: 'Digital Clock', mode: 'clock', text });
const drive = { manifest: {}, files: {} };

// Device A signs in first and uploads everything it has.
const a = device([clock(), { id: 'p1', name: 'Hello', text: 'HI' }], { loy_clean_name: 'true' }, { led_gemini_api_key: 'key-a' });
sync(a, drive, 1000);
assert.deepEqual(Object.keys(drive.files).sort(), ['clock-default', 'p1']);

// A new device B: its untouched built-in clock must not overwrite A's edits,
// its own presets are kept and uploaded, and A's key reaches it.
a.presets[0] = clock('edited on A');
sync(a, drive, 2000);
const b = device([clock(), { id: 'p2', name: 'Only on B' }], { loy_clean_name: 'false' }, { led_gemini_api_key: null });
const firstB = sync(b, drive, 3000);
assert.equal(b.presets.find(p => p.id === 'clock-default').text, 'edited on A');
assert.deepEqual(b.presets.map(p => p.id), ['clock-default', 'p1', 'p2']);
assert.ok(firstB.upload.includes('p2'));
assert.equal(b.secrets.led_gemini_api_key, 'key-a');
assert.equal(b.settings.loy_clean_name, 'true');

// A deletion on B reaches A instead of A re-uploading the preset.
b.presets = b.presets.filter(p => p.id !== 'p1');
sync(b, drive, 4000);
const plan = sync(a, drive, 5000);
assert.ok(plan.remove.includes('p1'));
assert.ok(!a.presets.some(p => p.id === 'p1'));
assert.ok(!drive.files.p1);

// Both edit the same preset: the later change wins on both devices.
a.presets = a.presets.map(p => p.id === 'p2' ? { ...p, name: 'A at 6000' } : p);
b.presets = b.presets.map(p => p.id === 'p2' ? { ...p, name: 'B at 7000' } : p);
sync(a, drive, 6000);
sync(b, drive, 7000);
sync(a, drive, 8000);
assert.equal(a.presets.find(p => p.id === 'p2').name, 'B at 7000');
assert.equal(b.presets.find(p => p.id === 'p2').name, 'B at 7000');

// Clearing a key on one device clears it on the other.
a.secrets.led_gemini_api_key = null;
sync(a, drive, 9000);
sync(b, drive, 10000);
assert.equal(b.secrets.led_gemini_api_key, null);

// Numeric ids (as the editor creates them) upload, download and delete.
const c = device([{ id: 1779376912451, name: 'Numeric' }]);
const numericPlan = sync(c, drive, 10500);
assert.ok(numericPlan.upload.includes('1779376912451'));
assert.equal(drive.files['1779376912451'].name, 'Numeric');
const bPlan = sync(b, drive, 10600);
assert.deepEqual(bPlan.download, ['1779376912451']);
assert.equal(b.presets.at(-1).id, 1779376912451);
assert.ok(applyPresetChanges([{ id: 1779376912451 }], { remove: ['1779376912451'], manifest: {} }, {}).length === 0);
const numericDownload = applyPresetChanges([{ id: 5, name: 'old' }], { remove: [], manifest: { order: { value: ['5'] } } }, { 5: { id: 5, name: 'new' } });
assert.deepEqual(numericDownload, [{ id: 5, name: 'new' }]);

// Nothing changed: a further round moves nothing.
const idle = sync(b, drive, 11000);
assert.deepEqual([idle.download, idle.upload, idle.remove], [[], [], []]);

console.log('PASS: first sync, deletions, conflicts, secrets and idle rounds merge correctly.');
