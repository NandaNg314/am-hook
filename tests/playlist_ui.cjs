// Run with: node tests/playlist_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// In-page playback is checked too when wrapper-lite is online.
// Covers the playlist page: catalog data, chart track rows, shelves, language refetch, playback queue,
// invalid IDs, home-page link detection and the mobile layout.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const shots = process.env.PLAYLIST_UI_SHOTS;
// 每周热门 100 首：全球 — an editorial chart playlist with motion artwork; its tracks change weekly, so no titles are asserted
const playlistLink = 'https://music.apple.com/cn/playlist/%E6%AF%8F%E5%91%A8%E7%83%AD%E9%97%A8-100-%E9%A6%96-%E5%85%A8%E7%90%83/pl.921750b485a6496ea58b16d46c097557';
const playlistPath = '/' + playlistLink;
const loaded = () => !document.getElementById('title').classList.contains('skeleton');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => localStorage.setItem('am-hook:lang', lang), scheme === 'light' ? 'zh' : 'en');
      await page.goto(base + playlistPath);
      await page.waitForFunction(loaded, null, { timeout: 20000 });

      assert.match(await page.locator('#title').textContent(), /100/);
      assert.match(await page.locator('#artist').textContent(), /Apple Music/);
      assert.ok((await page.locator('#sub').textContent()).trim(), 'last-updated date shown');
      assert.ok(!(await page.locator('#notes').isHidden()), 'description shown');
      const rows = await page.locator('.pl-track').count();
      assert.ok(rows >= 90, `tracks listed (${rows})`);
      // Chart playlists number their rows; every row carries its own artwork, artist and album
      assert.ok(await page.locator('#tracks').evaluate((node) => node.classList.contains('chart')));
      assert.equal(await page.locator('.pl-track .track-rank').first().textContent(), '1');
      assert.ok(await page.locator('.pl-track').first().locator('.track-art img').count(), 'row artwork');
      assert.ok((await page.locator('.pl-track .track-artist').first().textContent()).trim(), 'row artist');
      assert.match(await page.locator('.pl-track:not(.video) .track-title').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/cn\/song\/[^/]+\/\d+$/);
      assert.match(await page.locator('a.track-album').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/cn\/album\/[^/]+\/\d+$/);
      assert.ok(await page.locator('.track-album').first().isVisible(), 'album column on wide screens');
      assert.ok(await page.locator('#play-all').isEnabled());
      assert.match(await page.locator('#footer').textContent(), /\d/);
      // Featured artists shelf links out to Apple Music (no artist page here)
      const artist = page.locator('.shelf-item.artist').first();
      assert.match(await artist.getAttribute('href'), /^https:\/\/music\.apple\.com\/[a-z]{2}\/artist\//);
      assert.equal(await artist.getAttribute('target'), '_blank');
      const tint = await page.evaluate(() => document.body.style.getPropertyValue('--album-tint'));
      assert.match(tint, /^#[0-9a-f]{6}$/i, 'page tinted with artwork colour');
      await page.locator('#art .motion-video.ready').waitFor({ timeout: 30000 });
      assert.ok(await page.locator('#art .motion-video').evaluate((v) => !v.paused && v.muted && v.loop && v.currentTime > 0));
      if (shots) await page.screenshot({ path: path.join(shots, `playlist-${scheme}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Switching language refetches the catalog data in the new language
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
      await page.goto(base + playlistPath);
      await page.waitForFunction(loaded, null, { timeout: 20000 });
      const zhTitle = await page.locator('#title').textContent();
      await page.locator('[data-lang-toggle]').click();
      await page.waitForFunction((before) => document.getElementById('title').textContent !== before, zhTitle, { timeout: 20000 });
      assert.match(await page.locator('#title').textContent(), /[A-Za-z]/);
      assert.ok(await page.locator('.pl-track').count() >= 90, 'tracks kept after refetch');
      await page.close();
    }

    // Playback: first track plays in page; its row is marked as playing
    const status = await (await fetch(base + '/status')).json().catch(() => ({}));
    if (status.code === 0) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(base + playlistPath);
      await page.locator('#play-all:not([disabled])').waitFor({ timeout: 20000 });
      const first = await page.locator('.pl-track:not(.video) .track-title').first().textContent();
      await page.locator('#play-all').click();
      await page.locator('.pl-track.playing').first().waitFor({ timeout: 60000 });
      assert.ok(await page.locator('#player').isVisible());
      assert.equal(await page.locator('.player-title').textContent(), first);
      if (shots) await page.screenshot({ path: path.join(shots, 'playlist-playing.png') });
      await page.close();
    } else {
      console.log('wrapper-lite offline: playback check skipped');
    }

    // Links without a slug open the same page; unknown playlist IDs show an error
    {
      const page = await browser.newPage();
      await page.goto(base + '/https://music.apple.com/cn/playlist/pl.921750b485a6496ea58b16d46c097557');
      await page.waitForFunction(loaded, null, { timeout: 20000 });
      assert.ok(await page.locator('.pl-track').count() >= 90);
      await page.goto(base + '/https://music.apple.com/us/playlist/x/pl.00000000000000000000000000000000');
      await page.locator('#alert.error').waitFor({ timeout: 20000 });
      assert.ok(await page.locator('#tracks').isHidden());
      await page.close();
    }

    // Home page recognises playlist links and opens the playlist page
    {
      const page = await browser.newPage();
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
      await page.goto(base + '/');
      await page.locator('#input').fill(playlistLink);
      assert.match(await page.locator('#detect').textContent(), /Playlist · CN/);
      await page.locator('#input').press('Enter');
      await page.waitForURL('**/playlist/**/pl.921750b485a6496ea58b16d46c097557', { timeout: 10000 });
      await page.close();
    }

    // Mobile: tall artwork, album column hidden, no horizontal scroll
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.goto(base + playlistPath);
    await mobile.waitForFunction(loaded, null, { timeout: 20000 });
    await mobile.locator('.pl-track').first().waitFor();
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on mobile');
    assert.ok(await mobile.evaluate(() => document.body.classList.contains('tall-art')), 'tall artwork layout on phones');
    assert.ok(await mobile.locator('.track-album').first().isHidden(), 'album column hidden on phones');
    await mobile.locator('#tall-art .motion-video.ready').waitFor({ timeout: 30000 });
    if (shots) await mobile.screenshot({ path: path.join(shots, 'playlist-mobile.png'), fullPage: true });
    await mobile.close();

    console.log('playlist UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
