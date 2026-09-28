// Run with: node tests/artist_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// In-page playback is checked too when wrapper-lite is online.
// Covers the artist page: the three header styles (circular portrait, wide image, motion video), latest release,
// top songs, shelves with See All, the about section, language refetch, playback, links from other pages and mobile.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const shots = process.env.ARTIST_UI_SHOTS;
// Header styles follow the catalog data, as on music.apple.com:
// Taylor Swift (cn) has only a portrait, The Weeknd (us) a centeredFullscreenBackground, Billie Eilish (us) a motionArtistWide16x9 video
const circularLink = 'https://music.apple.com/cn/artist/taylor-swift/159260351';
const widePath = '/https://music.apple.com/us/artist/the-weeknd/479756766';
const videoPath = '/https://music.apple.com/us/artist/billie-eilish/1065981054';
const loaded = () => !document.getElementById('name').classList.contains('skeleton');
const localPage = (kind) => new RegExp(`^/https://music\\.apple\\.com/[a-z]{2}/${kind}/[^/]+/${kind === 'playlist' ? 'pl\\.[\\w-]+' : '\\d+'}$`);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => localStorage.setItem('am-hook:lang', lang), scheme === 'light' ? 'zh' : 'en');
      await page.goto(base + '/' + circularLink);
      await page.waitForFunction(loaded, null, { timeout: 20000 });

      assert.equal(await page.locator('#name').textContent(), 'Taylor Swift');
      assert.ok(await page.locator('#hero').evaluate((node) => node.classList.contains('circular')), 'portrait-only artists get the circular header');
      assert.ok(await page.locator('#portrait img').count(), 'circular portrait');
      assert.match(await page.evaluate(() => document.body.style.getPropertyValue('--hero-bg')), /^#[0-9a-f]{6}$/i, 'header tinted with artwork colour');
      assert.match(await page.locator('#latest').getAttribute('href'), localPage('album'));
      // The header backdrop must not paint over the section headings below it
      assert.ok(await page.locator('#top-songs-title').evaluate((h) => {
        const r = h.getBoundingClientRect();
        return h.contains(document.elementFromPoint(r.left + 8, r.top + r.height / 2));
      }), 'top songs heading visible');
      const songs = await page.locator('.ts-item').count();
      assert.ok(songs >= 10, `top songs listed (${songs})`);
      assert.match(await page.locator('.ts-item .track-title').first().getAttribute('href'), localPage('song'));
      assert.ok(await page.locator('#play-all').isEnabled());
      const shelves = await page.locator('#shelves .shelf-section').count();
      assert.ok(shelves >= 3, `shelves from views (${shelves})`);
      for (const href of await page.locator('#shelves .shelf-item').evaluateAll((items) => items.map((a) => a.getAttribute('href')))) {
        assert.match(href, /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/(album|music-video|playlist|artist)\//, `shelf link ${href}`);
      }
      // See All pages through the view's next links and lays the shelf out as a grid
      const albums = page.locator('#shelves .shelf-section').filter({ has: page.locator('.shelf-all') }).first();
      const before = await albums.locator('.shelf-item').count();
      await albums.locator('.shelf-all').click();
      await albums.locator('.shelf.expanded').waitFor({ timeout: 30000 });
      assert.ok(await albums.locator('.shelf-item').count() > before, 'See All loads more items');
      assert.ok(await albums.locator('.shelf-all').isHidden());
      assert.ok(!(await page.locator('#about').isHidden()), 'about section');
      const bio = await page.locator('#bio-text').textContent();
      assert.ok(bio.length > 100, 'artist bio');
      assert.doesNotMatch(bio, /<\/?[a-z]+>/i, 'bio markup rendered as text');
      assert.ok(await page.locator('#facts dt').count() >= 2, 'born / genre facts');
      if (shots) await page.screenshot({ path: path.join(shots, `artist-${scheme}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Wide header from editorialArtwork.centeredFullscreenBackground (crop code ea)
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(base + widePath);
      await page.waitForFunction(loaded, null, { timeout: 20000 });
      assert.ok(await page.locator('#hero').evaluate((node) => node.classList.contains('wide')));
      assert.match(await page.locator('#hero-bg img.hero-img').getAttribute('src'), /ea\.jpg$/);
      assert.equal(await page.locator('#portrait img').count(), 0);
      if (shots) await page.screenshot({ path: path.join(shots, 'artist-wide.png') });
      await page.close();
    }

    // Motion video header from editorialVideo.motionArtistWide16x9
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(base + videoPath);
      await page.waitForFunction(loaded, null, { timeout: 20000 });
      assert.ok(await page.locator('#hero').evaluate((node) => node.classList.contains('video')));
      await page.locator('#hero-bg .motion-video.ready').waitFor({ timeout: 30000 });
      assert.ok(await page.locator('#hero-bg .motion-video').evaluate((v) => !v.paused && v.muted && v.loop));
      if (shots) await page.screenshot({ path: path.join(shots, 'artist-video.png') });
      await page.close();
    }

    // Switching language refetches the catalog data in the new language
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
      await page.goto(base + '/' + circularLink);
      await page.waitForFunction(loaded, null, { timeout: 20000 });
      const zhHeading = await page.locator('#top-songs-title').textContent();
      await page.locator('[data-lang-toggle]').click();
      await page.waitForFunction((before) => document.getElementById('top-songs-title').textContent !== before, zhHeading, { timeout: 20000 });
      assert.match(await page.locator('#top-songs-title').textContent(), /[A-Za-z]/);
      assert.match(await page.locator('#about-title').textContent(), /^About /);
      await page.close();
    }

    // Playback: the top songs play in page; the playing row is marked
    const status = await (await fetch(base + '/status')).json().catch(() => ({}));
    if (status.code === 0) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(base + '/' + circularLink);
      await page.locator('#play-all:not([disabled])').waitFor({ timeout: 20000 });
      const first = await page.locator('.ts-item .track-title').first().textContent();
      await page.locator('#play-all').click();
      await page.locator('.ts-item.playing').first().waitFor({ timeout: 60000 });
      assert.equal(await page.locator('.player-title').textContent(), first);
      if (shots) await page.screenshot({ path: path.join(shots, 'artist-playing.png') });
      await page.close();
    } else {
      console.log('wrapper-lite offline: playback check skipped');
    }

    // Unknown artist IDs show an error
    {
      const page = await browser.newPage();
      await page.goto(base + '/https://music.apple.com/us/artist/x/1');
      await page.locator('#alert.error').waitFor({ timeout: 20000 });
      assert.ok(await page.locator('#featured').isHidden());
      await page.close();
    }

    // Other pages link to the artist page: pasted links on the home page, artist names on album pages
    {
      const page = await browser.newPage();
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
      await page.goto(base + '/');
      await page.locator('#input').fill(circularLink);
      assert.match(await page.locator('#detect').textContent(), /Artist · CN/);
      await page.locator('#input').press('Enter');
      await page.waitForURL('**/artist/taylor-swift/159260351', { timeout: 10000 });
      await page.goto(base + '/https://music.apple.com/cn/album/justice-triple-chucks-deluxe-deluxe-video-version/1561058084');
      await page.locator('#artist a').first().waitFor({ timeout: 20000 });
      assert.match(await page.locator('#artist a').first().getAttribute('href'), localPage('artist'));
      await page.close();
    }

    // Mobile: header and top songs fit, no horizontal scroll
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.goto(base + '/' + circularLink);
    await mobile.waitForFunction(loaded, null, { timeout: 20000 });
    await mobile.locator('.ts-item').first().waitFor();
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on mobile');
    const box = await mobile.locator('.ts-item').first().boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'first top song within the viewport');
    if (shots) await mobile.screenshot({ path: path.join(shots, 'artist-mobile.png'), fullPage: true });
    await mobile.close();

    console.log('artist UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
