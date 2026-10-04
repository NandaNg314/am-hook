// Run with: node tests/lyrics_ui.cjs <path-to-playwright-package>
// Uses installed Chrome and a local TTML fixture; no wrapper or Apple CDN required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.join(__dirname, '../src/ui');
const variants = [{ group_id: 'audio-stereo-256', codecs: 'mp4a.40.2', channels: '2', uri: 'track.m3u8', file_uri: 'track.mp4' }];
const line = (key, begin, end, words, translation) => ({ key, begin, end, words, translation });
const lines = [
  line('L1', 1, 4, ['First ', 'line'], 'Primera línea'),
  line('L2', 5, 8, ['Second ', 'line'], 'Segunda línea'),
  line('L3', 9, 12, ['Third ', 'line'], 'Tercera línea'),
];
const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en"><head><metadata><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations><translation type="subtitle" xml:lang="es">${
  lines.map(l => `<text for="${l.key}">${l.translation}</text>`).join('')
}</translation></translations><songwriters><songwriter>Writer A</songwriter><songwriter>Writer B</songwriter></songwriters></iTunesMetadata></metadata></head><body dur="00:14.000"><div begin="00:01.000" end="00:12.000">${
  lines.map(l => `<p begin="00:0${l.begin}.000" end="00:${String(l.end).padStart(2, '0')}.000" itunes:key="${l.key}" ttm:agent="v1">${
    l.words.map((w, i) => `<span begin="00:${String(l.begin + i).padStart(2, '0')}.000" end="00:${String(l.begin + i + 1).padStart(2, '0')}.000">${w.trim()}</span>${w.endsWith(' ') ? ' ' : ''}`).join('')
  }</p>`).join('')
}</div></body></tt>`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let scenarios = 0;
  try {
    for (const width of [390, 1440]) {
      for (const hasLyrics of [true, false]) {
        const context = await browser.newContext({ viewport: { width, height: 844 } });
        await context.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
        const lyricRequests = [];
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          // 歌曲信息经 /amp 代理取自 amp-api 的 songs 资源；地区语言信息取不到时页面退回默认写法
          if (/^\/amp\/v1\/catalog\/[a-z]{2}\/songs\//.test(url.pathname)) {
            return route.fulfill({ json: { data: [{ id: url.pathname.split('/').pop(), type: 'songs', attributes: { name: 'Lyric song', artistName: 'Artist' } }] } });
          }
          if (url.pathname.startsWith('/amp/')) return route.fulfill({ status: 404, json: { errors: [] } });
          if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['us'] } });
          if (url.pathname.startsWith('/parse/song/')) return route.fulfill({ json: { masterUrl: 'https://example.com/master.m3u8', hook: false, variants } });
          if (url.pathname.startsWith('/lyrics/')) {
            lyricRequests.push(url.pathname);
            return hasLyrics
              ? route.fulfill({ body: ttml, contentType: 'application/ttml+xml' })
              : route.fulfill({ status: 404, json: { code: 1, msg: 'lyrics not found' } });
          }
          // 单页应用：页面地址返回 app.html，页面视图在 /assets/views/
          const file = url.pathname.startsWith('/assets/lyrics/') ? path.join('lyrics', path.basename(url.pathname))
            : url.pathname.startsWith('/assets/views/') ? path.join('views', path.basename(url.pathname))
            : url.pathname.startsWith('/assets/') ? path.basename(url.pathname) : 'app.html';
          const type = file.endsWith('.css') ? 'text/css' : /\.m?js$/.test(file) ? 'text/javascript' : 'text/html';
          return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: type });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://am.test/https://music.apple.com/us/song/_/123456789');
        await page.locator('.variant').first().waitFor();
        // Drive the lyric view from a fake transport; real decoding is covered elsewhere.
        await page.evaluate(() => {
          window.fakeTransport = { currentTime: 0, paused: false, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } };
          // 歌词界面跟随正在播放的歌曲（current.track）
          const { player } = window.AmApp;
          player.current = { id: 'fake', track: '123456789', country: 'us', mode: 'mse', title: 'Lyric song' };
          player.transport = () => window.fakeTransport;
          player.emit();
          const bar = document.getElementById('player');
          bar.hidden = false;
          document.body.classList.add('has-player');
          const notice = bar.querySelector('.player-notice');
          notice.textContent = 'Playback notice';
          notice.hidden = false;
        });
        await page.locator('.player-lyrics:not([hidden])').waitFor();
        await page.waitForTimeout(300);
        assert.deepEqual(lyricRequests, [], 'lyrics are not fetched until requested');
        if (!hasLyrics) {
          await page.locator('.player-lyrics').click();
          await page.locator('#toast:not([hidden])').waitFor();
          assert.equal(await page.locator('#toast').textContent(), '这首歌没有歌词');
          assert(await page.locator('.player-lyrics').isHidden(), 'no lyrics: button hides');
          assert(await page.locator('#lyrics-overlay').isHidden());
          // 没有歌词时点击播放条仍展开界面（同 music.apple.com），只显示封面、标题与播放控件
          await page.locator('.player-track').click();
          await page.locator('#lyrics-overlay:not([hidden])').waitFor();
          assert(await page.locator('#lyrics-overlay').evaluate(el => el.classList.contains('lyrics-hidden')), 'no lyrics: the view opens without lyrics');
          assert(await page.locator('.lyric-panel').isHidden());
          assert(await page.locator('#lyrics-overlay .player-lyrics').isHidden(), 'no lyrics: no lyrics toggle');
          assert(await page.locator('.lyrics-fav').isVisible() && await page.locator('.lyrics-more').isVisible(), 'favorite and More buttons');
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
          assert.deepEqual(lyricRequests, ['/lyrics/123456789'], 'the 404 is not refetched');
          await page.keyboard.press('Escape');
          await page.locator('#lyrics-overlay').waitFor({ state: 'hidden' });
          assert.deepEqual(errors, []);
          await context.close();
          scenarios++;
          continue;
        }
        // Narrow layout opens from the player bar, wide layout from the button; both fetch once
        await page.locator(width === 390 ? '.player-track' : '.player-lyrics').click();
        await page.locator('#lyrics-overlay:not([hidden])').waitFor();
        assert.deepEqual(lyricRequests, ['/lyrics/123456789']);
        // AMLL line wrappers use hashed CSS-module class names; match their stable suffixes
        const lineSel = '.amll-lyric-player [class*="_lyricLineWrapper"]:not([class*="_bottomLineWrapper"])';
        await page.locator(lineSel).first().waitFor();
        assert.equal(await page.locator(lineSel).count(), 3, 'three lyric lines');
        const activeLines = () => page.evaluate(sel => [...document.querySelectorAll(sel)]
          .filter(el => [el, ...el.querySelectorAll('*')].some(n => [...n.classList].some(c => c.endsWith('_active'))))
          .map(el => el.querySelector('[class*="_lyricMainLine"]').textContent.trim()), lineSel);
        assert.equal(await page.locator('.lyrics-title').textContent(), 'Lyric song');
        // 翻译菜单（同 music.apple.com）：点按钮弹出，歌曲没有的一项置灰，Esc 只关闭菜单
        const openMenu = async () => {
          await page.locator('.lyrics-translation-button').click();
          await page.locator('.lyrics-menu:not([hidden])').waitFor();
        };
        await openMenu();
        assert.equal(await page.locator('[data-option="pronunciation"]').isDisabled(), true, 'no pronunciation for this song');
        await page.keyboard.press('Escape');
        await page.locator('.lyrics-menu').waitFor({ state: 'hidden' });
        assert(await page.locator('#lyrics-overlay').isVisible(), 'Escape closes only the menu');

        await page.evaluate(() => { fakeTransport.currentTime = 5.5; });
        await page.waitForTimeout(300);
        assert.deepEqual(await activeLines(), ['Second line']);
        await page.locator(lineSel).filter({ hasText: 'Third line' }).click();
        assert.equal(await page.evaluate(() => fakeTransport.currentTime), 9, 'clicking a line seeks the player');
        await page.waitForTimeout(300);
        assert.deepEqual(await activeLines(), ['Third line']);

        await openMenu();
        await page.locator('[data-option="translation"]').click();
        assert(await page.locator('.lyrics-menu').isHidden(), 'choosing an option closes the menu');
        assert.equal(await page.locator('.lyrics-translation-button .invertible-mask--inverted').count(), 1, 'the icon inverts while translations are shown');
        await openMenu();
        assert.equal(await page.locator('[data-option="translation"]').getAttribute('title'), await page.evaluate(() => AmI18n.t('lyrics.hideTranslation')));
        await page.keyboard.press('Escape');
        await page.locator('.lyrics-menu').waitFor({ state: 'hidden' });
        await page.locator(lineSel).filter({ hasText: 'Tercera línea' }).waitFor({ state: 'visible', timeout: 2000 });
        assert.equal(await page.locator('.credit-names').textContent(), 'Writer A、Writer B');
        await page.evaluate(() => AmI18n.toggle()); // the overlay covers the page's language button
        assert.equal(await page.locator('.credit-names').textContent(), 'Writer A, Writer B');
        assert.equal(await page.locator('.lyrics-close').getAttribute('aria-label'), 'Close lyrics');

        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
        const panel = await page.locator('.lyric-panel').boundingBox();
        const bar = await page.locator('#player').boundingBox();
        const overlaps = (a, b) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
        assert(!overlaps(panel, bar), 'lyrics and the player controls must not overlap');
        assert(bar.y + bar.height <= 844, 'player controls stay on screen');
        assert(await page.locator('#lyrics-overlay .lyrics-controls #player').count(), 'the player moves into the lyrics view');
        assert(await page.locator('.player-notice').isHidden(), 'playback notices are hidden in the lyrics view');
        await page.screenshot({ path: `target/ui-lyrics-${width}.png` });

        // 标题旁的喜爱与「更多」（同 music.apple.com 全屏播放界面）：喜爱正在播放的歌曲并加入资料库
        const fav = page.locator('.lyrics-fav');
        assert.equal(await fav.getAttribute('aria-pressed'), 'false');
        await fav.click();
        await page.locator('.lyrics-fav[aria-pressed="true"]').waitFor();
        assert(await page.evaluate(async () => {
          const library = await import('/assets/library.mjs');
          return library.isFavorite('song', '123456789') && library.inLibrary('song', '123456789');
        }), 'the playing song is favorited and added to the library');
        await page.locator('.lyrics-more').click();
        // 条目菜单（actions.mjs）没有 id，#menu 是页面上的另一个菜单
        const moreMenu = page.locator('.menu:not(#menu)');
        await moreMenu.waitFor();
        const menuText = await moreMenu.textContent();
        assert(menuText.includes('Undo Favorite') && menuText.includes('Delete from Library') && menuText.includes('Add to Playlist'), menuText);
        assert.equal(await moreMenu.locator('.menu-label', { hasText: /^Play$/ }).count(), 0, 'no Play item for the playing song');
        await page.keyboard.press('Escape');
        await moreMenu.waitFor({ state: 'hidden' });
        assert(await page.locator('#lyrics-overlay').isVisible(), 'Escape closes only the More menu');

        // 界面里的歌词按钮：隐藏歌词后封面与控件居中，选择保存在浏览器中，再次点击恢复
        const lyricToggle = page.locator('#lyrics-overlay .player-lyrics');
        assert.equal(await lyricToggle.getAttribute('aria-pressed'), 'true');
        assert.equal(await lyricToggle.getAttribute('aria-label'), 'Hide lyrics');
        await lyricToggle.click();
        assert(await page.locator('#lyrics-overlay.lyrics-hidden').count(), 'lyrics hidden');
        assert(await page.locator('.lyric-panel').isHidden() && await page.locator('.lyrics-translation-menu').isHidden());
        assert.equal(await lyricToggle.getAttribute('aria-label'), 'Show lyrics');
        assert.equal(await page.evaluate(() => localStorage.getItem('am-hook:lyrics-hidden')), '1');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width} without lyrics`);
        // 这里的歌曲没有封面（.lyrics-art 隐藏），检查标题行与控件
        const head = await page.locator('.lyrics-head').boundingBox();
        const hiddenBar = await page.locator('#player').boundingBox();
        assert(hiddenBar.y + hiddenBar.height <= 844 && head.y >= 0 && head.y + head.height <= hiddenBar.y, 'title and controls fit on screen');
        await page.screenshot({ path: `target/ui-lyrics-hidden-${width}.png` });
        await lyricToggle.click();
        assert.equal(await page.locator('#lyrics-overlay.lyrics-hidden').count(), 0, 'lyrics shown again');
        await page.locator(lineSel).filter({ hasText: 'Third line' }).waitFor({ state: 'visible', timeout: 2000 });
        assert.equal(await page.evaluate(() => localStorage.getItem('am-hook:lyrics-hidden')), null);

        // 待播清单开关只在手机的界面里：清单占据歌词的位置，随机 / 重复在清单标题旁；Esc 或歌词开关回到歌词
        const queueToggle = page.locator('#lyrics-overlay .player-queue');
        if (width === 390) {
          assert(await page.locator('#lyrics-overlay .player-shuffle').isHidden(), 'no shuffle among the phone controls');
          await queueToggle.click();
          await page.locator('#queue-panel.in-lyrics').waitFor();
          assert(await page.locator('#lyrics-overlay.queue-open').count(), 'queue replaces the lyrics');
          assert(await page.locator('#queue-panel .player-shuffle').isVisible() && await page.locator('#queue-panel .player-repeat').isVisible(), 'shuffle and repeat are in the queue');
          const queue = await page.locator('#queue-panel').boundingBox();
          const controls = await page.locator('#player').boundingBox();
          const title = await page.locator('.lyrics-side').boundingBox();
          assert(queue.y >= title.y + title.height - 1 && queue.y + queue.height <= controls.y + 1, 'queue sits between the title row and the controls');
          await page.screenshot({ path: 'target/ui-lyrics-queue-390.png' });
          await page.keyboard.press('Escape');
          assert(await page.locator('#queue-panel').isHidden() && await page.locator('#lyrics-overlay').isVisible(), 'Escape closes only the queue');
          await queueToggle.click();
          await lyricToggle.click();
          assert(await page.locator('#queue-panel').isHidden() && await page.locator('#lyrics-overlay.queue-open, #lyrics-overlay.lyrics-hidden').count() === 0, 'the lyrics toggle returns to the lyrics');
        } else {
          assert(await queueToggle.isHidden(), 'no queue toggle in the desktop view');
        }

        await page.keyboard.press('Escape');
        assert(await page.locator('#lyrics-overlay').isHidden());
        assert(await page.locator('.player-lyrics').evaluate(el => el === document.activeElement), 'focus returns to the lyrics button');
        await page.locator('.player-track').click();
        await page.locator('#lyrics-overlay:not([hidden])').waitFor();
        assert.deepEqual(lyricRequests, ['/lyrics/123456789'], 'reopening uses the cached lyrics');
        await page.locator('.seek').click();
        assert(await page.locator('#lyrics-overlay').isVisible(), 'the seek bar seeks instead of toggling lyrics');
        await page.keyboard.press('Escape');
        assert.deepEqual(errors, []);
        await context.close();
        scenarios++;
      }
    }
    console.log(`Passed ${scenarios} lyric scenarios: loading, line tracking, seeking, translation, language and layout.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
