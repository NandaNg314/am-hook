// Run with: node tests/album_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// In-page playback is checked too when wrapper-lite is online.
// Covers the album page: catalog data, track rows, shelves, ?i= redirect, playback queue and the mobile layout.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const shots = process.env.ALBUM_UI_SHOTS;
const albumPath = '/https://music.apple.com/cn/album/justice-triple-chucks-deluxe-deluxe-video-version/1561058084';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => localStorage.setItem('am-hook:lang', lang), scheme === 'light' ? 'zh' : 'en');
      await page.goto(base + albumPath);
      await page.waitForFunction(() => !document.getElementById('title').classList.contains('skeleton'), null, { timeout: 20000 });

      assert.match(await page.locator('#title').textContent(), /Justice/);
      assert.match(await page.locator('#artist').textContent(), /Justin Bieber/);
      const songs = await page.locator('.track:not(.video)').count();
      const videos = await page.locator('.track.video').count();
      assert.ok(songs >= 16, `songs listed (${songs})`);
      assert.ok(videos >= 1, 'music videos in the album are listed');
      assert.match(await page.locator('.track:not(.video) .track-title').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/cn\/song\/[^/]+\/\d+$/);
      assert.match(await page.locator('.track.video .track-title').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/cn\/music-video\/[^/]+\/\d+$/);
      assert.ok(await page.locator('#play-all').isEnabled());
      assert.ok(!(await page.locator('#footer').isHidden()), 'footer shown');
      const shelves = await page.locator('.shelf-section').count();
      assert.ok(shelves >= 1, 'shelves from views');
      assert.match(await page.locator('.shelf-item').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/(album|music-video)\/[^/]+\/\d+$/);
      const tint = await page.evaluate(() => document.body.style.getPropertyValue('--album-tint'));
      assert.match(tint, /^#[0-9a-f]{6}$/i, 'page tinted with artwork colour');
      // Motion artwork (editorialVideo.motionDetailSquare) plays muted over the square cover
      await page.locator('#art .motion-video.ready').waitFor({ timeout: 30000 });
      assert.ok(await page.locator('#art .motion-video').evaluate((v) => !v.paused && v.muted && v.loop && v.currentTime > 0));
      if (shots && scheme === 'dark') await page.screenshot({ path: path.join(shots, 'album-motion-desktop.png') });
      if (shots) await page.screenshot({ path: path.join(shots, `album-${scheme}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Playback: first track plays in page; its row is marked as playing
    const status = await (await fetch(base + '/status')).json().catch(() => ({}));
    if (status.code === 0) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(base + albumPath);
      await page.locator('#play-all:not([disabled])').waitFor({ timeout: 20000 });
      await page.locator('#play-all').click();
      await page.locator('.track.playing').first().waitFor({ timeout: 60000 });
      assert.ok(await page.locator('#player').isVisible());
      assert.match(await page.locator('.player-title').textContent(), /2 Much/);
      if (shots) await page.screenshot({ path: path.join(shots, 'album-playing.png') });
      await page.close();
    } else {
      console.log('wrapper-lite offline: playback check skipped');
    }

    // Album share links with ?i= open the song page
    const redirect = await browser.newPage();
    await redirect.goto(base + '/https://music.apple.com/us/album/lover/1468058165?i=1468058171');
    await redirect.waitForURL('**/song/lover/1468058171', { timeout: 10000 });
    await redirect.close();

    // Mobile: centred hero, no horizontal scroll
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.goto(base + albumPath);
    await mobile.waitForFunction(() => !document.getElementById('title').classList.contains('skeleton'), null, { timeout: 20000 });
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on mobile');
    // Phones use the full-width 3:4 motion artwork (motionDetailTall) with the headings over its faded bottom
    assert.ok(await mobile.evaluate(() => document.body.classList.contains('tall-art')), 'tall artwork layout on phones');
    await mobile.locator('#tall-art .motion-video.ready').waitFor({ timeout: 30000 });
    assert.equal(await mobile.locator('#art .motion-video').count(), 0, 'square video not mounted on phones');
    if (shots) await mobile.screenshot({ path: path.join(shots, 'album-motion-mobile.png') });
    if (shots) await mobile.screenshot({ path: path.join(shots, 'album-mobile.png'), fullPage: true });
    // Wider than 483px switches back to the square cover video
    await mobile.setViewportSize({ width: 800, height: 900 });
    await mobile.locator('#art .motion-video.ready').waitFor({ timeout: 30000 });
    assert.ok(await mobile.evaluate(() => !document.body.classList.contains('tall-art')));
    await mobile.close();

    // Reduced motion: static artwork only, no video
    const calm = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    await calm.goto(base + albumPath);
    await calm.waitForFunction(() => !document.getElementById('title').classList.contains('skeleton'), null, { timeout: 20000 });
    await calm.waitForTimeout(3000);
    assert.equal(await calm.locator('.motion-video.ready').count(), 0, 'no motion artwork with prefers-reduced-motion');
    await calm.close();

    console.log('album UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
