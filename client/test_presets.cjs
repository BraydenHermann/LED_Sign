// Headless UI regression checks with all sign/calendar requests intercepted.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const pixels = Array.from({ length: 2560 }, (_, i) => i % 128 < 64 ? '#ff0000' : '#0000ff');
    const preset = { id: 'hw-slot-8', hwSlotId: 8, mode: 'image', fileType: 'gif', pixels, frameDurationMs: 50 };
    let rejectVideo = false;
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      let body;
      let status = 200;
      if (path === '/status') body = { api_version: 2, connected: true, address: 'FF:24:10:29:44:9B', power: true, display_mode: 'preset-8', preview_ts: 1 };
      else if (path === '/hardware-slots') body = { slots: [{ slot_id: 8, occupied: true, preset_data: preset }] };
      else if (path === '/calendar/today') body = { events: [] };
      else if (path === '/process-video') {
        status = rejectVideo ? 500 : 200;
        body = rejectVideo ? { detail: 'Simulated decode failure' } : { pixels, frameDurationMs: 50, frameDurationsMs: [50, 50] };
      } else if (path === '/preset' || path === '/save-preset' || path === '/clock' || path === '/connect' || path === '/disconnect' || path === '/ui-heartbeat') body = { status: 'success', written_to_sign: true };
      else if (path.startsWith('/save-progress/')) body = { progress: 60, phase: 'Writing to sign' };
      if (path === '/preset') {
        return new Promise(resolve => setTimeout(() => resolve(request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })), 400));
      }
      if (body !== undefined) return request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
      return request.continue();
    });
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle2' });
    // A saved animation should be painted without clicking anywhere.
    await page.waitForFunction(() => [...document.querySelectorAll('.preset-card canvas')].some(c => c.getContext('2d').getImageData(0, 0, 1, 1).data[3] > 0));
    await (await page.$$('.preset-card'))[8].click({ offset: { x: 10, y: 10 } });
    await page.waitForSelector('[role=status] .animate-spin');
    await page.waitForSelector('[role=status] .lucide-check');
    const clickText = async text => {
      await page.evaluate(text => {
        const el = [...document.querySelectorAll('button, .preset-card')].find(e => e.textContent.trim() === text);
        if (!el) throw new Error(`Missing control: ${text}`);
        el.click();
      }, text);
    };
    await clickText('Local');
    await clickText('New Preset');
    await clickText('MEDIA');
    await page.waitForSelector('input[type=file]');
    const input = await page.$('input[type=file]');
    await input.uploadFile('C:/Users/brher/Downloads/gemini_generated_video_ab23d74a.mp4');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Save Preset' && !b.disabled));
    await clickText('Save Preset');
    await page.waitForFunction(() => ![...document.querySelectorAll('h3')].some(b => b.textContent.trim() === 'Create Preset'));
    const locals = await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('LEDSignDB', 1);
      open.onsuccess = () => {
        const get = open.result.transaction('presets_store').objectStore('presets_store').get('presets_list');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
    }));
    assert(locals.some(p => p.fileType === 'video' && p.pixels.length === 2560 && p.imgSrc.startsWith('data:video/')), 'Video source and animation must be persisted');
    const restricted = '[title="Please assign animated text, GIFs, and videos to a Saved Preset before pushing."]';
    await page.click(restricted, { offset: { x: 10, y: 10 } });
    await page.waitForSelector('[role=status]');
    const message = await page.$eval('[role=status]', e => e.textContent);
    await (await page.$$('button[role=tab]'))[0].click();
    assert.equal(await page.$eval('[role=status]', e => e.textContent), message, 'Saved toggle must preserve message');
    await (await page.$$('button[role=tab]'))[1].click();
    assert.equal(await page.$eval('[role=status]', e => e.textContent), message, 'Local toggle must preserve message');
    await page.click('[role=status]');
    assert.equal(await page.$('[role=status]'), null, 'Clicking the message must dismiss it');
    // Replace a video while editing and ensure Update closes the editor too.
    await page.$eval(`${restricted} button[title="Edit Preset"]`, button => button.click());
    await page.waitForSelector('input[type=file]');
    await (await page.$('input[type=file]')).uploadFile('C:/Users/brher/Downloads/gemini_generated_video_ab23d74a.mp4');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Update Preset' && !b.disabled));
    await clickText('Update Preset');
    await page.waitForFunction(() => ![...document.querySelectorAll('h3')].some(b => b.textContent.trim() === 'Edit Preset'));
    await clickText('New Preset');
    await clickText('MEDIA');
    await page.waitForSelector('input[type=file]');
    rejectVideo = true;
    await (await page.$('input[type=file]')).uploadFile('C:/Users/brher/Downloads/gemini_generated_video_ab23d74a.mp4');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Save Preset' && !b.disabled));
    await clickText('Save Preset');
    await page.waitForSelector('[role=alert]');
    assert((await page.$eval('[role=alert]', e => e.textContent)).includes('Simulated decode failure'));
    assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join(', ')}`);
    console.log('PASS: cached preview paints; create/edit video save and close; original persists; tab switching preserves status; label click dismisses; processing failure stays visible.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
