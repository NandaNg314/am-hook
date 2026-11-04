/**
 * auth-client.js
 *
 * 全局交付选项管理与结果展示（已移除后端起不来的密码鉴权僵尸代码）：
 * 1. 全局交付选项状态管理 (Local Storage vs Gofile) 与结果展示卡片交互
 * 说明：早期计划中的 Apple Music 密码鉴权（/api/auth）从未在后端实现，已整体移除，
 *       避免渲染一个点了没反应的"锁定"按钮。
 */

(function () {
  'use strict';

  const OPTIONS_KEY = 'am_hook_delivery_options';

  // 1. 全局配置选项管理
  const defaultOptions = {
    deliveryMode: 'local', // 'local' | 'gofile'
    embedMetadata: true,
    downloadLrc: true
  };

  function loadOptions() {
    try {
      const stored = localStorage.getItem(OPTIONS_KEY);
      const parsed = stored ? { ...defaultOptions, ...JSON.parse(stored) } : { ...defaultOptions };
      // 与单曲/专辑/歌单页的独立开关保持双向同步
      if (localStorage.getItem('am_gofile_upload') !== null) {
        parsed.deliveryMode = localStorage.getItem('am_gofile_upload') === 'true' ? 'gofile' : 'local';
      }
      if (localStorage.getItem('am_save_lrc') !== null) {
        parsed.downloadLrc = localStorage.getItem('am_save_lrc') === 'true';
      }
      if (localStorage.getItem('am_lyrics_fmt') !== null) {
        parsed.embedMetadata = localStorage.getItem('am_lyrics_fmt') !== 'off';
      }
      return parsed;
    } catch {
      return { ...defaultOptions };
    }
  }

  function saveOptions(opts) {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
      localStorage.setItem('am_gofile_upload', String(opts.deliveryMode === 'gofile'));
      localStorage.setItem('am_save_lrc', String(Boolean(opts.downloadLrc)));
      if (!opts.embedMetadata) {
        localStorage.setItem('am_lyrics_fmt', 'off');
      } else if (localStorage.getItem('am_lyrics_fmt') === 'off') {
        localStorage.setItem('am_lyrics_fmt', 'lrc');
      }
    } catch {}
  }

  function syncGlobalGofileModalI18n() {
    const isEn = window.AmI18n?.lang === 'en';
    const closeBtn = document.getElementById('gofile-modal-close');
    const titleEl = document.getElementById('gofile-title');
    const copySpan = document.querySelector('#gofile-copy-btn span');
    const openSpan = document.querySelector('#gofile-open-btn span');
    const cleanSpan = document.querySelector('.gofile-clean-notice span');
    const zipSub = document.getElementById('gofile-zip-name');
    if (closeBtn) closeBtn.setAttribute('aria-label', isEn ? 'Close' : '关闭');
    if (titleEl) titleEl.textContent = isEn ? 'Gofile Cloud Transfer Complete' : 'Gofile 云端转存完成';
    if (copySpan && copySpan.textContent !== '已复制!' && copySpan.textContent !== 'Copied!') {
      copySpan.textContent = isEn ? 'Copy Download Link' : '复制下载链接';
    }
    if (openSpan) openSpan.textContent = isEn ? 'Open Link' : '直接打开';
    if (cleanSpan) cleanSpan.textContent = isEn ? 'Temporary files cleaned automatically · 0 VPS disk usage' : '本地临时文件与 zip 已自动清理，VPS 磁盘 0 占用';
    if (zipSub && zipSub.textContent === 'YOASOBI - 夜に駆ける.zip') {
      zipSub.textContent = 'archive.zip';
    }
  }

  window.AmDeliveryOptions = {
    get: loadOptions,
    set: saveOptions,
    getDeliveryMode: () => loadOptions().deliveryMode,
    isGofileMode: () => loadOptions().deliveryMode === 'gofile',
    shouldEmbedMetadata: () => loadOptions().embedMetadata,
    shouldDownloadLrc: () => loadOptions().downloadLrc,
    showGofileResult: (zipName, downloadPage) => {
      syncGlobalGofileModalI18n();
      const modal = document.getElementById('gofile-result-modal');
      const nameEl = document.getElementById('gofile-zip-name');
      const urlInput = document.getElementById('gofile-url-input');
      const openBtn = document.getElementById('gofile-open-btn');

      if (!modal) return;
      if (nameEl) nameEl.textContent = zipName || 'archive.zip';
      if (urlInput) urlInput.value = downloadPage || '';
      if (openBtn) openBtn.href = downloadPage || '#';

      modal.hidden = false;
    }
  };

  // 2. UI 交互控制
  document.addEventListener('DOMContentLoaded', () => {
    syncGlobalGofileModalI18n();
    if (window.AmI18n?.onChange) {
      window.AmI18n.onChange(() => syncGlobalGofileModalI18n());
    }
    // 交付选项卡片事件与持久化
    function initOptionsCard() {
      const modeLocal = document.getElementById('mode-local');
      const modeGofile = document.getElementById('mode-gofile');
      const chkMeta = document.getElementById('opt-embed-metadata');
      const chkLrc = document.getElementById('opt-download-lrc');

      if (!modeLocal && !modeGofile) return;

      const current = loadOptions();
      if (modeLocal && modeGofile) {
        if (current.deliveryMode === 'gofile') modeGofile.checked = true;
        else modeLocal.checked = true;

        const handleModeChange = () => {
          current.deliveryMode = modeGofile.checked ? 'gofile' : 'local';
          saveOptions(current);
        };
        modeLocal.addEventListener('change', handleModeChange);
        modeGofile.addEventListener('change', handleModeChange);
      }

      if (chkMeta) {
        chkMeta.checked = current.embedMetadata;
        chkMeta.addEventListener('change', () => {
          current.embedMetadata = chkMeta.checked;
          saveOptions(current);
        });
      }

      if (chkLrc) {
        chkLrc.checked = current.downloadLrc;
        chkLrc.addEventListener('change', () => {
          current.downloadLrc = chkLrc.checked;
          saveOptions(current);
        });
      }
    }

    initOptionsCard();

    // 监听视图切换以在渲染页面时重新初始化选项卡片
    const observer = new MutationObserver(() => {
      initOptionsCard();
    });
    const viewContainer = document.getElementById('view');
    if (viewContainer) {
      observer.observe(viewContainer, { childList: true, subtree: true });
    }

    // Gofile 结果弹窗关闭与复制逻辑
    const gofileModal = document.getElementById('gofile-result-modal');
    const gofileClose = document.getElementById('gofile-modal-close');
    const gofileCopyBtn = document.getElementById('gofile-copy-btn');
    const gofileUrlInput = document.getElementById('gofile-url-input');

    if (gofileClose && gofileModal) {
      gofileClose.addEventListener('click', () => {
        gofileModal.hidden = true;
      });
    }

    if (gofileCopyBtn && gofileUrlInput) {
      gofileCopyBtn.addEventListener('click', async () => {
        const isEn = window.AmI18n?.lang === 'en';
        try {
          await navigator.clipboard.writeText(gofileUrlInput.value);
          if (gofileCopyBtn.querySelector('span')) {
            gofileCopyBtn.querySelector('span').textContent = isEn ? 'Copied!' : '已复制!';
            setTimeout(() => {
              if (gofileCopyBtn.querySelector('span')) {
                gofileCopyBtn.querySelector('span').textContent = isEn ? 'Copy Download Link' : '复制下载链接';
              }
            }, 2000);
          }
        } catch {
          gofileUrlInput.select();
          document.execCommand('copy');
        }
      });
    }
  });
})();