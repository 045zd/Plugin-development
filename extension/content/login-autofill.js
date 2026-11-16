/**
 * 学习通登录页：账号自动填充。
 *
 * 合规说明：
 * - 只保存并填入**账号**（手机号/超星号），**不保存、不填写密码**；
 * - 密码由 Edge 内置密码管理器负责（用户在 Edge 设置中保存学习通密码后，浏览器会自动填充）；
 * - 不自动点击登录按钮、不提交表单。
 */

(() => {
  'use strict';

  const RETRY_INTERVAL_MS = 800;
  const MAX_ATTEMPTS = 15;

  const ACCOUNT_SELECTORS = [
    '#phone',
    'input[name="phone"]',
    'input[name="uname"]',
    'input[name="userName"]',
    'input[name="username"]',
    'input[type="tel"]',
    'input[placeholder*="手机"]',
    'input[placeholder*="账号"]',
    'input[placeholder*="超星"]',
    'input[placeholder*="邮箱"]',
  ];

  /** 使用原生 setter 赋值，兼容 React/Vue 的受控输入框。 */
  function setNativeValue(input, value) {
    try {
      const desc = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      );
      if (desc && desc.set) {
        desc.set.call(input, value);
      } else {
        input.value = value;
      }
    } catch {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findAccountInput() {
    for (const selector of ACCOUNT_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (!(node instanceof HTMLInputElement)) continue;
        if (node.type === 'password' || node.type === 'hidden') continue;
        if (node.disabled || node.readOnly) continue;
        if (!isVisible(node)) continue;
        return node;
      }
    }
    return null;
  }

  function alreadyFilled(input, account) {
    return input.value === account;
  }

  let hinted = false;

  function showHint(anchor) {
    if (hinted) return;
    hinted = true;
    try {
      const tip = document.createElement('div');
      tip.textContent = '已自动填入账号，密码请使用 Edge 保存的密码或手动输入';
      tip.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:28px',
        'transform:translateX(-50%)',
        'background:rgba(31,41,55,.92)',
        'color:#fff',
        'font-size:12px',
        'line-height:1.5',
        'padding:8px 14px',
        'border-radius:8px',
        'z-index:2147483647',
        'box-shadow:0 4px 16px rgba(0,0,0,.2)',
        'pointer-events:none',
        'transition:opacity .4s ease',
        'font-family:system-ui,"Microsoft YaHei",sans-serif',
      ].join(';');
      document.body.appendChild(tip);
      setTimeout(() => {
        tip.style.opacity = '0';
        setTimeout(() => tip.remove(), 500);
      }, 3200);
    } catch {
      /* 忽略提示失败 */
    }
  }

  function tryFillOnce(account) {
    const input = findAccountInput();
    if (!input) return false;
    if (alreadyFilled(input, account)) {
      // 已经填好（例如页面同页刷新），不再打扰
      return true;
    }
    setNativeValue(input, account);
    // 触发一次聚焦事件，方便 Edge 密码管理器关联该表单
    try {
      input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    } catch {
      /* 忽略 */
    }
    showHint(input);
    return true;
  }

  function start(account) {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      try {
        if (tryFillOnce(account)) {
          clearInterval(timer);
        }
      } catch {
        /* 忽略单次失败 */
      }
      if (attempts >= MAX_ATTEMPTS) clearInterval(timer);
    }, RETRY_INTERVAL_MS);
  }

  // 页面可能有 SPA 切换（验证码登录 / 密码登录），保持监听一段时间
  function watch(account) {
    start(account);
    try {
      const observer = new MutationObserver(() => {
        const input = findAccountInput();
        if (input && !alreadyFilled(input, account)) {
          try {
            setNativeValue(input, account);
          } catch {
            /* 忽略 */
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 60000);
    } catch {
      /* 忽略 */
    }
  }

  async function main() {
    let config;
    try {
      const data = await chrome.storage.local.get('config');
      config = data.config || {};
    } catch {
      return;
    }
    const enabled = config.autoFillAccount !== false;
    const account = String(config.rememberedAccount || '').trim();
    if (!enabled || !account) return;
    // 只在登录页生效，避免在已登录页面乱填
    if (!/login|passport/i.test(location.pathname + location.search)) return;
    if (document.readyState === 'loading') {
      await new Promise((resolve) =>
        document.addEventListener('DOMContentLoaded', resolve, { once: true })
      );
    }
    watch(account);
  }

  main().catch(() => {
    /* 静默失败，不影响登录页 */
  });
})();
