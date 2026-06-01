const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    try {
        await page.goto('http://localhost:5173', {waitUntil: 'domcontentloaded'});
        await new Promise(r => setTimeout(r, 1000));
        const rootHtml = await page.$eval('#root', el => el.innerHTML);
        console.log("ROOT HTML:");
        console.log(rootHtml.substring(0, 500));
    } catch(e) {
        console.log("Error loading page:", e);
    }
    await browser.close();
})();
