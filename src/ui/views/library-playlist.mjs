// 本地歌单页（与 music.apple.com 的 /library/playlist/p.… 相同），由 app.mjs 挂载。
// 歌单保存在浏览器中（/assets/library.mjs）：可以编辑名称与描述、拖动排序、从歌单中删除曲目、复制、导出与删除。
import * as library from '/assets/library.mjs';
import { createActions, openMenu } from './actions.mjs';
import {
  LIB_ICON, playlistCover, playlistName, editPlaylist, deletePlaylist, duplicatePlaylist, exportPlaylist,
  playlistMenuItems, trackRow, syncTrackRows,
} from './library-ui.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'album-page playlist-page lib-playlist-page';
export const styles = ['/assets/views/library.css'];

export function mount({ root, url, signal, player, navigate, toast, onLangChange }) {
  const actions = createActions({ signal, player, navigate, toast });
  const $ = (id) => root.querySelector(`#${id}`);
  const id = url.pathname.split('/').filter(Boolean)[2] || '';
  let rows = [];
  let notesExpanded = false;
  /** 排序后要恢复焦点的曲目 uid（键盘移动后） */
  let focusUid = '';

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  const current = () => library.playlist(id);
  const songs = () => (current() ? current().tracks.filter((track) => track.kind === 'song') : []);

  function formatDate(ms) {
    return new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long' }).format(new Date(ms));
  }

  /* ---------- 头部 ---------- */
  function renderHero(list) {
    document.title = `${playlistName(list)} · am-hook`;
    $('title').textContent = playlistName(list);
    $('artist').textContent = t('library.localPlaylist');
    $('sub').textContent = t('playlist.updated', { date: formatDate(list.updatedAt) });
    $('art').replaceChildren(playlistCover(list, 632, 'lib-cover lib-cover-hero'));
    const first = list.tracks.find((track) => track.artwork);
    $('radiosity').replaceChildren(...(first ? [el('img', { src: library.artUrl(first.artwork, 160), alt: '' })] : []));
    $('art').setAttribute('role', 'img');
    $('art').setAttribute('aria-label', t('album.coverAlt', { title: playlistName(list) }));

    const notes = list.description;
    $('notes').hidden = !notes;
    $('hero').classList.toggle('no-notes', !notes);
    $('notes-text').textContent = notes;
    $('notes').classList.toggle('expanded', notesExpanded);
    requestAnimationFrame(() => {
      const text = $('notes-text');
      $('notes-more').hidden = !notesExpanded && text.scrollHeight <= text.clientHeight + 1;
      $('notes-more').textContent = t(notesExpanded ? 'album.less' : 'album.more');
    });
    $('play-all').disabled = $('shuffle').disabled = songs().length === 0;
  }

  /* ---------- 曲目 ---------- */
  function renderTracks(list) {
    const songList = songs();
    rows = list.tracks.map((track, index) => {
      const grip = el('button', { className: 'lib-grip', type: 'button', innerHTML: LIB_ICON.grip, title: t('library.moveHandle') });
      grip.setAttribute('aria-label', t('library.moveTrack', { name: track.name, pos: index + 1, total: list.tracks.length }));
      grip.dataset.uid = track.uid;
      grip.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        if (!step) return;
        e.preventDefault();
        const to = index + step;
        if (to < 0 || to >= list.tracks.length) return;
        focusUid = track.uid;
        library.movePlaylistTrack(id, index, to);
      });
      grip.addEventListener('pointerdown', (e) => startDrag(e, index));
      const songIndex = songList.indexOf(track);
      return trackRow(track, {
        actions, lead: grip, playlistId: id,
        onPlay: track.kind === 'song' ? () => playFrom(songIndex) : null,
        extraItems: [{ icon: LIB_ICON.minus, label: t('library.removeFromPlaylist'), onSelect: () => library.removeFromPlaylist(id, [track.uid]) }],
      });
    });
    $('tracks').replaceChildren(...rows.map((r) => r.row));
    $('tracks').hidden = !rows.length;
    $('empty').hidden = !!rows.length;
    syncTrackRows(rows, player);
    if (focusUid) {
      const grip = [...root.querySelectorAll('.lib-grip')].find((node) => node.dataset.uid === focusUid);
      if (grip) grip.focus();
      focusUid = '';
    }
  }

  function renderFooter(list) {
    const minutes = Math.round(list.tracks.reduce((sum, track) => sum + (track.duration || 0), 0) / 60000);
    const length = minutes >= 60 ? t('album.hours', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('album.minutes', { n: minutes });
    const songCount = list.tracks.filter((track) => track.kind === 'song').length;
    const videoCount = list.tracks.length - songCount;
    const line = [songCount && t('album.songs', { n: songCount }), videoCount && t('album.videos', { n: videoCount }), minutes && length]
      .filter(Boolean).join(AmI18n.lang === 'zh' ? '，' : ', ');
    $('footer').replaceChildren(...(line ? [el('p', { textContent: line })] : []));
    $('footer').hidden = !line;
  }

  /* ---------- 拖动排序：按住行首把手上下拖动（鼠标与触屏相同），松开后写入新顺序 ---------- */
  function startDrag(event, from) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const nodes = rows.map((r) => r.row);
    const dragged = nodes[from];
    const rects = nodes.map((node) => node.getBoundingClientRect());
    const mids = rects.map((r) => r.top + r.height / 2);
    const height = rects[from].height;
    const startY = event.clientY;
    let to = from;
    handle.setPointerCapture(event.pointerId);
    $('tracks').classList.add('is-sorting');
    dragged.classList.add('is-dragging');

    const move = (e) => {
      const dy = e.clientY - startY;
      const center = mids[from] + dy;
      to = from;
      while (to < nodes.length - 1 && center > mids[to + 1]) to++;
      while (to > 0 && center < mids[to - 1]) to--;
      dragged.style.transform = `translateY(${dy}px)`;
      nodes.forEach((node, i) => {
        if (i === from) return;
        const shift = from < to && i > from && i <= to ? -height : from > to && i < from && i >= to ? height : 0;
        node.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      $('tracks').classList.remove('is-sorting');
      dragged.classList.remove('is-dragging');
      for (const node of nodes) node.style.transform = '';
      if (to !== from) library.movePlaylistTrack(id, from, to);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /* ---------- 播放 ---------- */
  function playFrom(index) {
    const list = songs();
    if (player.current && player.current.track === list[index].id) { player.toggle(); return; }
    player.playQueue(list.map(library.entryOf), index);
  }

  $('play-all').addEventListener('click', () => player.playQueue(songs().map(library.entryOf), 0, { shuffle: false }));
  $('shuffle').addEventListener('click', () => {
    const list = songs();
    player.playQueue(list.map(library.entryOf), Math.floor(Math.random() * list.length), { shuffle: true });
  });
  player.onChange(() => syncTrackRows(rows, player));

  $('edit').addEventListener('click', () => editPlaylist(id));
  $('more').addEventListener('click', (e) => {
    e.stopPropagation();
    const list = current();
    if (!list) return;
    openMenu($('more'), [
      { icon: LIB_ICON.edit, label: t('library.editEllipsis'), onSelect: () => editPlaylist(id) },
      { icon: LIB_ICON.addToPlaylist, label: t('library.addToPlaylist'), submenu: () => playlistMenuItems(() => current().tracks, { toast, navigate, except: id }) },
      { icon: LIB_ICON.duplicate, label: t('library.duplicate'), onSelect: () => duplicatePlaylist(id, { toast, navigate }) },
      { icon: LIB_ICON.export, label: t('library.exportPlaylist'), onSelect: () => exportPlaylist(id) },
      '-',
      { icon: LIB_ICON.remove, label: t('library.deletePlaylistEllipsis'), danger: true, onSelect: () => deletePlaylist(id, { toast, onDeleted: () => navigate('/library/all-playlists', { replace: true }) }) },
    ]);
  });
  $('notes-more').addEventListener('click', () => {
    notesExpanded = !notesExpanded;
    render();
  });

  let loaded = false;
  function render() {
    if (!loaded) return;
    const list = current();
    if (!list) {
      document.title = t('library.pageTitle');
      $('title').textContent = t('library.notFoundTitle');
      $('alert').hidden = false;
      $('alert').className = 'alert error';
      $('alert').textContent = t('library.notFound');
      for (const node of root.querySelectorAll('.detail-actions button')) node.disabled = true;
      $('tracks').replaceChildren();
      $('empty').hidden = true;
      $('footer').hidden = true;
      return;
    }
    $('alert').hidden = true;
    renderHero(list);
    renderTracks(list);
    renderFooter(list);
  }

  signal.addEventListener('abort', library.onChange(render), { once: true });
  onLangChange(render);
  document.title = t('library.pageTitle');
  library.ready.then(() => {
    if (signal.aborted) return;
    loaded = true;
    render();
  });
}
