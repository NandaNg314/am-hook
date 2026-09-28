// Run with: node tests/search_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// Covers the home page search: suggestions, results, pagination, ?q= state and the mobile layout.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const shots = process.env.SEARCH_UI_SHOTS;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
    await page.goto(base + '/');

    // Links still go straight to the song page; keywords switch the button to "Search"
    const input = page.locator('#input');
    await input.fill('https://music.apple.com/us/song/cruel-summer/1468058171');
    assert.equal(await page.locator('#submit-label').textContent(), 'Parse');
    await input.fill('');

    // Suggestions come from /amp/v1/catalog/{sf}/search/suggestions
    await input.pressSequentially('born again', { delay: 20 });
    assert.equal(await page.locator('#submit-label').textContent(), 'Search');
    await page.locator('#suggest .suggest-item').first().waitFor({ timeout: 15000 });
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    assert.ok(await page.locator('#suggest .suggest-term').count() > 0, 'term suggestions shown');
    await input.press('ArrowDown');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'suggest-0');
    await input.press('Escape');
    assert.ok(await page.locator('#suggest').isHidden());
    if (shots) {
      await input.press('End');
      await input.pressSequentially(' ', { delay: 20 });
      await page.locator('#suggest .suggest-item').first().waitFor({ timeout: 15000 });
      await page.screenshot({ path: path.join(shots, 'search-suggest.png') });
      await input.press('Escape');
    }

    // Results from /amp/v1/catalog/{sf}/search: songs and music videos
    await input.fill('born again');
    await input.press('Enter');
    await page.locator('.song-row').first().waitFor({ timeout: 15000 });
    assert.equal(new URL(page.url()).searchParams.get('q'), 'born again');
    assert.match(await page.locator('#results-title').textContent(), /born again/);
    const songHref = await page.locator('.song-row').first().getAttribute('href');
    assert.match(songHref, /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/song\/[^/]+\/\d+$/);
    const mvCount = await page.locator('.mv-card').count();
    if (mvCount) assert.match(await page.locator('.mv-card').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/music-video\/[^/]+\/\d+$/);

    // "Load more" follows the API's next link through the proxy
    const songs = await page.locator('.song-row').count();
    const more = page.locator('.result-group').first().locator('.more-btn');
    if (await more.isVisible()) {
      await more.click();
      await page.waitForFunction((n) => document.querySelectorAll('.song-row').length > n, songs, { timeout: 15000 });
    }
    if (shots) await page.screenshot({ path: path.join(shots, 'search-desktop.png'), fullPage: true });

    // ?q= restores results on reload; Close clears it
    await page.reload();
    await page.locator('.song-row').first().waitFor({ timeout: 15000 });
    assert.equal(await input.inputValue(), 'born again');
    await page.locator('#close-results').click();
    assert.ok(await page.locator('#results').isHidden());
    assert.equal(new URL(page.url()).searchParams.get('q'), null);

    // Mobile: no horizontal scroll
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
    await mobile.goto(base + '/?q=' + encodeURIComponent('taylor swift'));
    await mobile.locator('.song-row').first().waitFor({ timeout: 15000 });
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on mobile');
    if (shots) await mobile.screenshot({ path: path.join(shots, 'search-mobile.png'), fullPage: true });

    assert.deepEqual(errors, []);
    console.log(`search UI ok (${songs} songs, ${mvCount} music videos)`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
