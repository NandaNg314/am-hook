/**
 * auth-client.js
 * 
 * 客户端鉴权拦截与 Apple Music 交互逻辑：
 * 1. 自动注入 Session Token 请求头
 * 2. 拦截 401 / 429 状态码，展示 Apple Music 官方风格全屏毛玻璃密码卡片
 * 3. 密码错误触发 iOS 原生弹簧微震与错误反馈
 * 4. 退出锁定按钮与会话管理
 * 5. 全局交付选项状态管理 (Local Storage vs Gofile) 与结果展示卡片交互
 */

(function () {
  'use strict';

  const TOKEN_KEY = 'am_auth_token';
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

  // 2. 原生 Fetch 拦截注入 Bearer Token
  const originalFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = new Headers(init.headers || {});
    
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const modifiedInit = { ...init, headers };
    try {
      const response = await originalFetch(input, modifiedInit);

      // 若 API 接口返回 401，主动唤起 Apple Music 登录遮罩弹窗
      if (response.status === 401) {
        const urlStr = typeof input === 'string' ? input : input?.url || '';
        if (!urlStr.includes('/api/auth')) {
          showAuthModal('会话已失效，请重新输入访问密码');
        }
      }
      return response;
    } catch (err) {
      throw err;
    }
  };

  // 3. UI 交互控制
  function showAuthModal(errMsg = '') {
    document.documentElement.classList.add('needs-auth');
    const overlay = document.getElementById('auth-overlay');
    const input = document.getElementById('auth-password');
    const errorEl = document.getElementById('auth-error-msg');

    if (overlay) {
      overlay.hidden = false;
      overlay.style.opacity = '1';
    }
    if (errorEl) {
      if (errMsg) {
        errorEl.textContent = errMsg;
        errorEl.hidden = false;
      } else {
        errorEl.hidden = true;
      }
    }
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 100);
    }
  }

  function hideAuthModal() {
    document.documentElement.classList.remove('needs-auth');
    const overlay = document.getElementById('auth-overlay');
    if (!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.hidden = true;
    }, 350);
  }

  function triggerShake() {
    const card = document.getElementById('auth-card');
    if (!card) return;
    card.classList.remove('shake');
    // 强制 reflow 重启动画
    void card.offsetWidth;
    card.classList.add('shake');
  }

  // 4. 初始化事件绑定
  document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('auth-overlay');
    const form = document.getElementById('auth-form');
    const passwordInput = document.getElementById('auth-password');
    const errorMsg = document.getElementById('auth-error-msg');
    const submitBtn = document.getElementById('auth-submit');
    const lockBtn = document.getElementById('auth-lock-btn');

    // 检查初始状态 (通过 ping /api/auth/status 或校验 Cookie)
    fetch('/api/auth/status')
      .then(res => {
        if (!res.ok) {
          showAuthModal();
        }
      })
      .catch(() => {
        // 网络异常或未授权
        if (!localStorage.getItem(TOKEN_KEY)) {
          showAuthModal();
        }
      });

    // 登录表单提交
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = passwordInput?.value?.trim();
        if (!password) return;

        if (submitBtn) submitBtn.disabled = true;
        if (errorMsg) errorMsg.hidden = true;

        try {
          const res = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
          });

          const data = await res.json().catch(() => ({}));

          if (res.status === 200 && data.ok) {
            // 登录成功
            localStorage.setItem(TOKEN_KEY, data.token);
            hideAuthModal();
            if (window.AmToast) {
              window.AmToast('解锁成功');
            }
          } else if (res.status === 429) {
            // 连续输错 5 次被锁定 15 分钟
            triggerShake();
            if (errorMsg) {
              errorMsg.textContent = data.message || `尝试次数过多，请在 ${data.retryAfter || 900} 秒后再试`;
              errorMsg.hidden = false;
            }
          } else {
            // 密码错误 (401)
            triggerShake();
            if (errorMsg) {
              const remaining = data.remainingAttempts !== undefined ? `（剩余尝试次数：${data.remainingAttempts}）` : '';
              errorMsg.textContent = `${data.message || '访问密码错误'}${remaining}`;
              errorMsg.hidden = false;
            }
            passwordInput?.select();
          }
        } catch (err) {
          triggerShake();
          if (errorMsg) {
            errorMsg.textContent = '网络连接异常，请重试';
            errorMsg.hidden = false;
          }
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    // 退出锁定按钮点击
    if (lockBtn) {
      lockBtn.addEventListener('click', async () => {
        localStorage.removeItem(TOKEN_KEY);
        try {
          await fetch('/api/auth/logout', { method: 'POST' });
        } catch {}
        showAuthModal('已锁定访问');
      });
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

    // 监听视图切换以在渲染 home 页面时重新初始化选项卡片
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
