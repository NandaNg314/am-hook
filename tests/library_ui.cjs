// Run with: node tests/library_ui.cjs <path-to-playwright-package>
// 资料库与歌单（src/ui/library.mjs、views/library*.mjs）：用本地 fixture 与已安装的 Chrome，不需要 wrapper-lite 或 Apple CDN。
// 覆盖：专辑页「+」把专辑与曲目加入资料库、资料库各分类、新建歌单、「添加到歌单」子菜单、键盘排序、
// 刷新后数据仍在（IndexedDB）、导出 / 清空 / 导入（合并）、导入文件的链接校验，以及手机宽度下不横向溢出。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const root = path.join(__dirname, '../src/ui');
const BASE = 'http://am.test';
const ALBUM_PATH = '/https://music.apple.com/us/album/test-album/100';
const art = (id) => ({ url: `https://img.test/${id}/{w}x{h}bb.jpg`, bgColor: '334455' });
const artist = { id: '42', type: 'artists', attributes: { name: 'Fixture Artist', url: 'https://music.apple.com/us/artist/fixture-artist/42' } };

function song(id, name, n) {
  return {
    id, type: 'songs',
    attributes: {
      name, artistName: 'Fixture Artist', albumName: 'Test Album', durationInMillis: 180000 + n * 1000, trackNumber: n, discNumber: 1,
      artwork: art('100'), playParams: { id, kind: 'song' }, url: `https://music.apple.com/us/album/test-album/100?i=${id}`,
    },
    relationships: { artists: { data: [artist] } },
  };
}

const album = {
  id: '100', type: 'albums',
  attributes: {
    name: 'Test Album', artistName: 'Fixture Artist', artwork: art('100'), url: 'https://music.apple.com/us/album/test-album/100',
    releaseDate: '2024-05-01', trackCount: 3, genreNames: ['Pop'], playParams: { id: '100', kind: 'album' },
  },
  relationships: {
    artists: { data: [artist] },
    tracks: { data: [song('101', 'First Song', 1), song('102', 'Second Song', 2), song('103', 'Third Song', 3)] },
  },
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-hook-library-'));
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== BASE) return route.fulfill({ status: 404, body: '' });
      if (url.pathname === '/amp/v1/catalog/us/albums/100') return route.fulfill({ json: { data: [album] } });
      if (url.pathname.startsWith('/amp/')) return route.fulfill({ status: 404, json: { errors: [] } });
      if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['us'] } });
      if (url.pathname.startsWith('/lyrics/') || url.pathname.startsWith('/parse/')) return route.fulfill({ status: 404, json: { code: 1, msg: 'offline' } });
      // 单页应用：页面地址返回 app.html，页面视图在 /assets/views/
      const file = url.pathname.startsWith('/assets/lyrics/') ? path.join('lyrics', path.basename(url.pathname))
        : url.pathname.startsWith('/assets/views/') ? path.join('views', path.basename(url.pathname))
        : url.pathname.startsWith('/assets/') ? path.basename(url.pathname) : 'app.html';
      const type = file.endsWith('.css') ? 'text/css' : /\.m?js$/.test(file) ? 'text/javascript' : 'text/html';
      return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: type });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const toast = async (pattern) => {
      await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent), pattern.source);
    };
    const rowTitles = () => page.locator('#view .lib-track .track-title').allTextContents();

    // 1. 专辑页头部的「+」：专辑与全部曲目加入资料库，按钮变为 ✓
    await page.goto(BASE + ALBUM_PATH);
    const toggle = page.locator('.detail-extra .lib-toggle');
    await page.waitForFunction(() => document.querySelector('.detail-extra .lib-toggle')?.disabled === false);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await toggle.click();
    await toast(/Added “Test Album”/);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'album is in the library');

    // 2. 资料库各分类：歌曲、专辑、艺人、最近添加
    await page.locator('#nav [data-nav="library:songs"]').click();
    await page.waitForURL('**/library/songs', { waitUntil: 'commit' });
    await page.locator('#view .lib-track').first().waitFor();
    assert.deepEqual(await rowTitles(), ['First Song', 'Second Song', 'Third Song'], 'songs sorted by title');
    assert.equal(await page.locator('#nav [data-nav="library:songs"]').getAttribute('aria-current'), 'page');
    await page.locator('#filter').fill('second');
    assert.deepEqual(await rowTitles(), ['Second Song'], 'filter narrows the list');
    await page.locator('#filter').fill('');
    await page.locator('#nav [data-nav="library:albums"]').click();
    await page.locator('#view .lib-grid .shelf-title').first().waitFor();
    assert.deepEqual(await page.locator('#view .lib-grid .shelf-title').allTextContents(), ['Test Album']);
    assert.equal(await page.locator('#view .lib-grid a.shelf-item').getAttribute('href'), ALBUM_PATH);
    await page.locator('#nav [data-nav="library:artists"]').click();
    await page.locator('#view .lib-artist-title').waitFor();
    assert.equal(await page.locator('#view .lib-artist-title').textContent(), 'Fixture Artist');
    assert.equal(await page.locator('#view .lib-artist-detail .lib-track').count(), 3, 'artist shows their songs');

    // 3. 侧边栏「+」新建歌单：对话框 → 创建后打开歌单页（空）
    await page.locator('[data-new-playlist]').click();
    await page.locator('.lib-dialog input[name="name"]').fill('Road Trip');
    await page.locator('.lib-dialog textarea[name="description"]').fill('Songs for the drive');
    await page.locator('.lib-dialog .primary').click();
    await page.waitForURL(/\/library\/playlist\/p\.[\w-]+$/, { waitUntil: 'commit' });
    const playlistUrl = page.url();
    await page.locator('#empty:not([hidden])').waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Road Trip');
    assert.equal(await page.locator('#nav-playlists a').textContent(), 'Road Trip', 'sidebar lists the playlist');
    assert.equal(await page.locator('#nav-playlists a').getAttribute('aria-current'), 'page');

    // 4. 歌曲行「更多」→「添加到歌单」子菜单 → 歌单；重复添加时提示已存在
    const addToPlaylist = async (title) => {
      await page.locator('#view .lib-track', { hasText: title }).locator('.track-more').click();
      await page.locator('.menu .menu-item', { hasText: 'Add to Playlist' }).click();
      assert.equal(await page.locator('.menu .menu-back').textContent(), 'Add to Playlist', 'submenu has a back item');
      await page.locator('.menu .menu-item', { hasText: 'Road Trip' }).click();
    };
    await page.locator('#nav [data-nav="library:songs"]').click();
    await page.locator('#view .lib-track').first().waitFor();
    await addToPlaylist('First Song');
    await toast(/Added 1 to “Road Trip”/);
    await addToPlaylist('Third Song');
    await toast(/Added 1 to “Road Trip”/);
    await addToPlaylist('First Song');
    await toast(/Already in “Road Trip”/);

    // 5. 歌单页：两首，键盘排序（把手上按 ↑），从歌单中删除
    await page.locator('#nav-playlists a').click();
    await page.locator('#view .lib-track').nth(1).waitFor();
    assert.deepEqual(await rowTitles(), ['First Song', 'Third Song']);
    await page.locator('#view .lib-grip').nth(1).focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('#view .lib-track .track-title').textContent === 'Third Song');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('lib-grip')), true, 'focus stays on the moved handle');
    assert.equal(await page.locator('#notes-text').textContent(), 'Songs for the drive');

    // 6. 刷新后仍在（IndexedDB）
    await page.reload();
    await page.locator('#view .lib-track').nth(1).waitFor();
    assert.deepEqual(await rowTitles(), ['Third Song', 'First Song'], 'order persists across reloads');

    // 7. 导出整个资料库
    await page.goto(BASE + '/library/all-playlists');
    await page.locator('#view .lib-grid .shelf-title').first().waitFor();
    await page.locator('#lib-more').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.menu .menu-item', { hasText: 'Export Library' }).click()]);
    const exportFile = path.join(tmp, download.suggestedFilename());
    await download.saveAs(exportFile);
    const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    assert.equal(exported.format, 'am-hook-library');
    assert.equal(exported.version, 1);
    assert.equal(exported.items.filter((item) => item.kind === 'song').length, 3);
    assert.equal(exported.items.filter((item) => item.kind === 'album').length, 1);
    assert.deepEqual(exported.playlists.map((list) => list.tracks.map((track) => track.name)), [['Third Song', 'First Song']]);

    // 8. 清空（确认对话框）→ 导入（合并）恢复
    await page.locator('#lib-more').click();
    await page.locator('.menu .menu-item', { hasText: 'Clear Library' }).click();
    await page.locator('.lib-dialog .primary').click();
    await page.locator('#view .lib-empty').waitFor();
    assert.equal(await page.locator('#nav-playlists a').count(), 0, 'sidebar empties too');
    await page.locator('#lib-more').click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.menu .menu-item', { hasText: 'Import' }).click()]);
    await chooser.setFiles(exportFile);
    await page.locator('.lib-dialog').waitFor();
    assert.match(await page.locator('.lib-dialog-message').textContent(), /4 library items and 1 playlists \(2 tracks\)/);
    await page.locator('.lib-dialog .primary').click();
    await toast(/Imported 4 library items and 1 playlists/);
    await page.goto(playlistUrl);
    await page.locator('#view .lib-track').nth(1).waitFor();
    assert.deepEqual(await rowTitles(), ['Third Song', 'First Song'], 'import restores the playlist with the same id');

    // 9. 导入文件的校验：危险链接被清除，无效条目被跳过
    const hostile = {
      format: 'am-hook-library', version: 1,
      items: [{ kind: 'song', id: 'not-a-number', name: 'bad' }],
      playlists: [{ id: 'p.shared1', name: 'Shared', tracks: [
        { kind: 'song', id: '555', name: 'Evil', href: 'javascript:alert(1)', artwork: 'javascript:alert(2)', artists: [{ name: 'X', href: 'https://evil.test/' }] },
      ] }],
    };
    const hostileFile = path.join(tmp, 'shared.am-hook-playlist.json');
    fs.writeFileSync(hostileFile, JSON.stringify(hostile));
    await page.goto(BASE + '/library/all-playlists');
    await page.locator('#view .lib-grid').waitFor();
    await page.locator('#lib-more').click();
    const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.menu .menu-item', { hasText: 'Import' }).click()]);
    await chooser2.setFiles(hostileFile);
    await page.locator('.lib-dialog').waitFor();
    assert.match(await page.locator('.lib-dialog-message').textContent(), /1 invalid entries will be skipped/);
    await page.locator('.lib-dialog .primary').click();
    await page.waitForURL('**/library/playlist/p.shared1', { waitUntil: 'commit' });
    await page.locator('#view .lib-track').first().waitFor();
    assert.equal(await page.locator('#view .lib-track a[href^="javascript"], #view .lib-track a[href^="https://evil"]').count(), 0, 'unsafe links dropped');
    assert.equal(await page.locator('#view .lib-track span.track-title').textContent(), 'Evil', 'title kept as plain text');

    // 10. 手机宽度：资料库与歌单页不横向溢出
    await page.setViewportSize({ width: 360, height: 780 });
    for (const target of ['/library/songs', '/library/albums', '/library/artists', playlistUrl]) {
      await page.goto(target.startsWith('http') ? target : BASE + target);
      await page.locator('#view .app-page').waitFor({ state: 'attached' });
      await page.waitForTimeout(150);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow on ${target}`);
    }
    await page.screenshot({ path: 'target/ui-library-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE + '/library/songs');
    await page.locator('#view .lib-track').first().waitFor();
    await page.screenshot({ path: 'target/ui-library.png' });

    assert.deepEqual(errors, []);
    await context.close();
    console.log('Passed library: add album, sections, playlists, add-to-playlist, reorder, persistence, export / clear / import, validation, mobile layout.');
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
