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
      return stored ? { ...defaultOptions, ...JSON.parse(stored) } : { ...defaultOptions };
    } catch {
      return { ...defaultOptions };
    }
  }

  function saveOptions(opts) {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
    } catch {}
  }

  window.AmDeliveryOptions = {
    get: loadOptions,
    set: saveOptions,
    getDeliveryMode: () => loadOptions().deliveryMode,
    isGofileMode: () => loadOptions().deliveryMode === 'gofile',
    shouldEmbedMetadata: () => loadOptions().embedMetadata,
    shouldDownloadLrc: () => loadOptions().downloadLrc,
    showGofileResult: (zipName, downloadPage) => {
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
        try {
          await navigator.clipboard.writeText(gofileUrlInput.value);
          const originalText = gofileCopyBtn.querySelector('span')?.textContent;
          if (gofileCopyBtn.querySelector('span')) {
            gofileCopyBtn.querySelector('span').textContent = '已复制!';
            setTimeout(() => {
              if (gofileCopyBtn.querySelector('span')) {
                gofileCopyBtn.querySelector('span').textContent = originalText || '复制下载链接';
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