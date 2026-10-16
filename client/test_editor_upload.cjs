const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(process.argv[2] || 'http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(element => element.textContent.trim() === 'Local'));
    await page.evaluate(() => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === 'Local').click());
    try {
      await page.waitForFunction(() => [...document.querySelectorAll('.preset-card')].some(element => element.textContent.includes('Create Preset')), { timeout: 15000 });
    } catch (error) {
      console.error('Initial page:', await page.evaluate(() => document.body.innerText.slice(0, 1000)), 'errors:', errors);
      throw error;
    }
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.preset-card')].find(element => element.textContent.includes('Create Preset'));
      if (!card) throw new Error('Create Preset card not found');
      card.click();
    });
    await page.waitForSelector('h3');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === 'MEDIA');
      if (!button) throw new Error('MEDIA button not found');
      button.click();
    });
    await page.waitForSelector('#img-upload');
    await page.evaluate(() => {
      window.__uploadEvents = [];
      document.querySelector('#img-upload').addEventListener('change', event => {
        window.__uploadEvents.push({ files: [...event.target.files].map(file => ({ name: file.name, size: file.size, type: file.type })) });
      });
    });
    const [fileChooser] = await Promise.all([
      page.waitForFileChooser(),
      page.click('button[title="Upload image or video"]')
    ]);
    await fileChooser.accept([path.resolve(__dirname, 'src/assets/hero.png')]);
    try {
      await page.waitForFunction(() => {
        const saveButton = [...document.querySelectorAll('button')].find(element => element.textContent.includes('Save Preset'));
        return saveButton && !saveButton.disabled;
      }, { timeout: 10000 });
    } catch (error) {
      console.error(await page.evaluate(() => ({
        mediaInput: document.querySelector('#img-upload')?.outerHTML,
        uploadEvents: window.__uploadEvents,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
        statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent),
        saveButton: [...document.querySelectorAll('button')].find(element => element.textContent.includes('Save Preset'))?.outerHTML,
        preview: document.querySelector('.preview-box')?.outerHTML.slice(0, 400)
      })));
      throw error;
    }
    await page.click('.preview-box');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => ![...document.querySelectorAll('h3')].some(element => element.textContent === 'Create Preset'), { timeout: 10000 });
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.preset-card')].find(element => element.textContent.includes('Create Preset'));
      card.click();
    });
    await page.waitForSelector('input[placeholder="Type something..."]');
    await page.click('input[placeholder="Type something..."]');
    await page.keyboard.press('Enter');
    const disabledEditorStayedOpen = await page.evaluate(() => [...document.querySelectorAll('h3')].some(element => element.textContent === 'Create Preset'));
    if (!disabledEditorStayedOpen) throw new Error('Enter saved a preset while Save Preset was disabled');
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    console.log('File upload enabled Save Preset; Enter saved it, but did not bypass disabled Save Preset.');
  } finally {
    const browserProcess = browser.process();
    await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (browserProcess && browserProcess.exitCode === null) browserProcess.kill();
  }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
