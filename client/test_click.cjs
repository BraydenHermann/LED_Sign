const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2000);
  
  // Find the text "Saved Presets" and click its parent tab if needed
  // Actually they are already visible since it's one page
  
  // Find Slot 2 and click it
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('div')).find(e => e.textContent === 'SLOT 2');
    if (el) {
      console.log('Found SLOT 2 element, clicking it...');
      
      // We need to simulate a full mousedown/mouseup sequence because of handleMouseDown/Up
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      
      const evtDown = new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y });
      el.dispatchEvent(evtDown);
      
      const evtUp = new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y });
      el.dispatchEvent(evtUp);
      
    } else {
      console.log('SLOT 2 not found');
    }
  });
  
  await page.waitForTimeout(2000);
  await browser.close();
})();
