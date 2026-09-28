// Run with: node tests/shell_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api and an online wrapper-lite
// (default http://127.0.0.1:8888).
// Covers the persistent player bar (src/ui/shell.html): top-level requests get the shell, pages open in its iframe,
// playback and the queue survive in-site navigation, the address bar / title / Back button follow the page,
// keyboard shortcuts inside the page, lyrics for the playing song and language switching.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage } = require('./shell.cjs');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const albumPath = '/https://music.apple.com/cn/album/justice-triple-chucks-deluxe-deluxe-video-version/1561058084';

/** 外壳播放器的状态 */
const state = (page) => page.evaluate(() => {
  const p = window.AmShell.player;
  return {
    path: decodeURIComponent(location.pathname), title: document.title,
    track: p.current && p.current.track, paused: p.transport().paused, time: p.transport().currentTime,
    pos: p.queue ? p.queue.pos : null,
  };
});
const playing = () => { const p = window.AmShell.player; return !!p.current && !p.transport().paused && p.transport().currentTime > 0.3; };

(async () => {
  // The shell is only served to top-level navigations; other requests (iframe, old browsers) get the page itself
  const direct = await (await fetch(base + albumPath)).text();
  assert.match(direct, /id="player"/);
  const top = await fetch(base + albumPath, { headers: { 'Sec-Fetch-Dest': 'document' } });
  assert.match(await top.text(), /class="app-frame"/);
  assert.match(top.headers.get('vary') || '', /Sec-Fetch-Dest/i);

  const status = await (await fetch(base + '/status')).json().catch(() => ({}));
  if (status.code !== 0) {
    console.log('wrapper-lite offline: shell playback checks skipped');
    return;
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
    const frame = await openPage(page, base + albumPath);
    await frame.waitForFunction(() => !document.getElementById('title').classList.contains('skeleton'), null, { timeout: 20000 });
    let s = await state(page);
    assert.equal(s.path, albumPath, 'address bar shows the page');
    assert.match(s.title, /Justice/, 'title follows the page');
    assert.equal(await frame.locator('#player').count(), 0, "page's own bar removed inside the shell");

    await frame.locator('#play-all').click();
    await page.waitForFunction(playing, null, { timeout: 60000 });
    const first = (await state(page)).track;
    assert.ok(await page.locator('#player').isVisible());
    assert.ok(await frame.locator('body.has-player').count(), 'page leaves room for the bar');
    assert.ok(await frame.locator('.track.playing').count(), 'playing row marked');

    // In-site navigation keeps playing
    await frame.locator('a.brand').click();
    await page.waitForFunction(() => location.pathname === '/', null, { timeout: 15000 });
    const before = (await state(page)).time;
    await page.waitForTimeout(2000);
    s = await state(page);
    assert.equal(s.paused, false, 'still playing after navigation');
    assert.ok(s.time > before + 1, 'playback position advancing');
    assert.ok(await frame.locator('body.has-player').count(), 'next page leaves room for the bar');

    // Space inside the page toggles playback
    await frame.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.AmShell.player.transport().paused, null, { timeout: 5000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !window.AmShell.player.transport().paused, null, { timeout: 5000 });

    // The album queue continues after leaving the album page
    await page.evaluate(() => window.AmShell.player.ended());
    await page.waitForFunction((id) => { const p = window.AmShell.player; return p.current.track !== id && !p.transport().paused; }, first, { timeout: 60000 });
    assert.equal((await state(page)).pos, 1);

    // Back returns to the album with the playing row marked
    await page.goBack();
    await page.waitForFunction((path) => decodeURIComponent(location.pathname) === path, albumPath, { timeout: 15000 });
    await frame.locator('.track.playing').waitFor({ timeout: 30000 });

    // Lyrics of the playing song open from the shell bar
    const lyrics = page.locator('#player .player-lyrics');
    assert.ok(await lyrics.isVisible(), 'lyrics button for the playing song');
    await lyrics.click();
    await page.locator('#lyrics-overlay:not([hidden])').waitFor({ timeout: 20000 });
    await page.keyboard.press('Escape');
    await page.locator('#lyrics-overlay').waitFor({ state: 'hidden' });

    // Song page: switching language updates the shell bar; playing a single song ends the queue
    await frame.locator('.track:not(.video) .track-title').nth(2).click();
    await frame.locator('#variant-list .variant').first().waitFor({ timeout: 30000 });
    await frame.locator('[data-lang-toggle]').click();
    await page.waitForFunction(() => /Play|Pause/.test(document.querySelector('#player .player-toggle').getAttribute('aria-label')), null, { timeout: 5000 });
    await frame.locator('#play-best').click();
    await page.waitForFunction(() => { const p = window.AmShell.player; return !p.queue && !p.transport().paused && p.current.id.includes(':'); }, null, { timeout: 60000 });
    await frame.locator('.variant.playing').waitFor({ timeout: 5000 });

    assert.deepEqual(errors, []);
    console.log('shell UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
