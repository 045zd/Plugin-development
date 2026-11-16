'use strict';

/**
 * 学习通截止提醒 — popup 逻辑
 * 只通过 chrome.runtime.sendMessage 与 background 通信；
 * 所有来自后台的文本一律用 textContent / DOM 节点写入，禁止 innerHTML 拼接。
 */

(function () {
  const LOGIN_URL = 'https://passport2.chaoxing.com/login';
  // 条目没有具体链接时的兜底列表页（旧版缓存数据可能缺少 url）
  const WORK_LIST_URL = 'https://mooc1-api.chaoxing.com/work/stu-work';
  const EXAM_LIST_URL = 'https://mooc1-api.chaoxing.com/exam-ans/exam/phone/examcode';
  const POLL_INTERVAL_MS = 2000;
  const STATE_TIMEOUT_MS = 15000;
  const ACTION_TIMEOUT_MS = 15000;

  // 与 design.md 一致：这些状态视为已处理，折叠展示，不参与待办排序
  const DONE_STATUSES = ['已完成', '已批阅', '已结束', '待批阅'];

  const el = {};
  const state = {
    data: null,
    loading: true,
    error: '',
    polling: false,
    pollTimer: 0,
    requestSeq: 0,
    pendingScan: false,
    userScan: false,
    doneOpen: false,
    expiredOpen: false,
    toastTimer: 0,
    pendingOpen: false
  };

  const KNOWN_ERRORS = {
    timeout: '扩展后台响应超时，请稍后重试',
    no_response: '扩展后台没有响应，请重新打开弹窗或重新加载扩展',
    runtime_error: '无法连接扩展后台，请确认扩展已启用后重试',
    AUTH_REQUIRED: '学习通登录已失效，请重新登录后再检查',
    AUTH_REQUIRED_EXPIRED: '学习通登录已失效，请重新登录后再检查',
    network: '网络请求失败，请检查网络后重试',
    network_error: '网络请求失败，请检查网络后重试',
    parse_empty: '学习通页面解析为空，可能页面已改版',
    scan_in_progress: '已有检查正在进行中',
    scan_not_started: '检查未能启动，请稍后再试',
    fetch_failed: '请求学习通失败，请稍后重试'
  };

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    el.loginBadge = $('loginBadge');
    el.loginBadgeText = $('loginBadgeText');
    el.loginLink = $('loginLink');
    el.lastCheck = $('lastCheck');
    el.scanMetaLine = $('scanMetaLine');
    el.scanBtn = $('scanBtn');
    el.scanBtnText = $('scanBtnText');
    el.optionsBtn = $('optionsBtn');
    el.scanWarning = $('scanWarning');
    el.scanWarningText = $('scanWarningText');
    el.loadingView = $('loadingView');
    el.errorView = $('errorView');
    el.errorText = $('errorText');
    el.retryBtn = $('retryBtn');
    el.errorOptionsBtn = $('errorOptionsBtn');
    el.emptyView = $('emptyView');
    el.emptyTitle = $('emptyTitle');
    el.emptyDesc = $('emptyDesc');
    el.emptyScanBtn = $('emptyScanBtn');
    el.emptyLoginLink = $('emptyLoginLink');
    el.listView = $('listView');
    el.todoCount = $('todoCount');
    el.todoList = $('todoList');
    el.todoEmpty = $('todoEmpty');
    el.expiredSection = $('expiredSection');
    el.expiredToggle = $('expiredToggle');
    el.expiredTitle = $('expiredTitle');
    el.expiredList = $('expiredList');
    el.doneSection = $('doneSection');
    el.doneToggle = $('doneToggle');
    el.doneTitle = $('doneTitle');
    el.doneList = $('doneList');
    el.toast = $('toast');
  }

  // ---------------------------------------------------------------------------
  // 消息封装
  // ---------------------------------------------------------------------------

  function sendMessage(message, timeoutMs) {
    const limit = typeof timeoutMs === 'number' ? timeoutMs : ACTION_TIMEOUT_MS;
    return new Promise(function (resolve) {
      let settled = false;
      let timer = 0;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        resolve(result);
      }

      timer = window.setTimeout(function () {
        finish({ ok: false, error: 'timeout' });
      }, limit);

      try {
        chrome.runtime.sendMessage(message, function (response) {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            finish({ ok: false, error: lastError.message || 'runtime_error' });
            return;
          }
          if (response === undefined || response === null) {
            finish({ ok: false, error: 'no_response' });
            return;
          }
          finish(response);
        });
      } catch (err) {
        finish({ ok: false, error: err && err.message ? err.message : 'runtime_error' });
      }
    });
  }

  /**
   * 兼容两种后台响应：
   * 1) 约定格式 { ok, data, error }
   * 2) 直接返回业务对象（如 SCAN_NOW 的 { started: true }）
   */
  function unwrapResponse(response) {
    if (!response || typeof response !== 'object') {
      return { ok: false, error: 'no_response' };
    }
    if (response.ok === false) {
      return { ok: false, error: response.error !== undefined ? response.error : 'unknown_error' };
    }
    return {
      ok: true,
      data: response.data !== undefined && response.data !== null ? response.data : response
    };
  }

  function errorTextOf(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      if (typeof value.message === 'string') return value.message;
      if (typeof value.error === 'string') return value.error;
      try {
        return JSON.stringify(value);
      } catch (err) {
        return '未知错误';
      }
    }
    return String(value);
  }

  function describeError(code) {
    const text = errorTextOf(code).trim();
    if (!text) return '未知错误';

    if (Object.prototype.hasOwnProperty.call(KNOWN_ERRORS, text)) {
      return KNOWN_ERRORS[text];
    }

    const lower = text.toLowerCase();
    const keys = Object.keys(KNOWN_ERRORS);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const keyLower = key.toLowerCase();
      if (lower === keyLower || lower.indexOf(keyLower + ':') === 0 || lower.indexOf(keyLower + ' ') === 0) {
        return KNOWN_ERRORS[key];
      }
    }

    if (/auth[_\s-]?required|not\s*logged\s*in|login\s*required/i.test(text)) {
      return KNOWN_ERRORS.AUTH_REQUIRED;
    }
    if (/timeout|timed\s*out/i.test(text)) {
      return KNOWN_ERRORS.timeout;
    }
    if (/could not establish connection|receiving end does not exist/i.test(text)) {
      return '无法连接扩展后台，请确认扩展已启用后重试';
    }
    if (/failed to fetch|network|net::/i.test(text)) {
      return KNOWN_ERRORS.network;
    }

    // 含中文的错误直接展示（一般已是友好文案）
    return /[\u4e00-\u9fa5]/.test(text) ? text : '扩展返回错误：' + text;
  }

  function isScanning() {
    if (!state.data) return false;
    if (state.data.scanning === true) return true;
    if (state.data.scanState && typeof state.data.scanState === 'object') return true;
    return false;
  }

  function getLoggedIn(data) {
    if (!data || !data.scanMeta || typeof data.scanMeta !== 'object') return null;
    const value = data.scanMeta.loggedIn;
    if (value === true) return true;
    if (value === false) return false;
    return null;
  }

  function itemsOf(data) {
    if (!data || !Array.isArray(data.items)) return [];
    return data.items;
  }

  // ---------------------------------------------------------------------------
  // 格式化
  // ---------------------------------------------------------------------------

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function formatAbsolute(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return (
      date.getFullYear() +
      '-' +
      pad2(date.getMonth() + 1) +
      '-' +
      pad2(date.getDate()) +
      ' ' +
      pad2(date.getHours()) +
      ':' +
      pad2(date.getMinutes())
    );
  }

  function formatRelative(timestamp, now) {
    const diff = now - timestamp;
    if (diff < 0) return '刚刚';
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    return formatDateTime(timestamp);
  }

  /** 返回 { level, text }，level 用于颜色分级 */
  function remainingInfo(deadline, now) {
    const diff = deadline - now;
    if (diff <= 0) {
      return { level: 'overdue', text: '已过期' };
    }
    const hours = diff / 3600000;
    let level = 'normal';
    if (hours <= 6) level = 'critical';
    else if (hours <= 24) level = 'urgent';
    else if (hours <= 72) level = 'soon';

    let text;
    if (hours < 1) {
      text = '剩余 ' + Math.max(1, Math.ceil(diff / 60000)) + ' 分钟';
    } else {
      const days = Math.floor(hours / 24);
      const restHours = Math.floor(hours % 24);
      text = days > 0 ? '剩余 ' + days + ' 天 ' + restHours + ' 小时' : '剩余 ' + restHours + ' 小时';
    }
    return { level: level, text: text };
  }

  function normalizeDeadline(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    return null;
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      key: typeof raw.key === 'string' ? raw.key : '',
      type: raw.type === 'exam' ? 'exam' : 'assignment',
      course: typeof raw.course === 'string' ? raw.course : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      status: typeof raw.status === 'string' ? raw.status : '',
      deadline: normalizeDeadline(raw.deadline),
      deadlineText: typeof raw.deadlineText === 'string' ? raw.deadlineText : '',
      score: typeof raw.score === 'string' ? raw.score : '',
      url: typeof raw.url === 'string' ? raw.url : ''
    };
  }

  function safeHttpUrl(raw) {
    if (typeof raw !== 'string' || raw === '') return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
      return '';
    } catch (err) {
      return '';
    }
  }

  /** 条目跳转地址：优先具体作业/考试链接，缺失时退回对应列表页。 */
  function itemUrl(item) {
    return safeHttpUrl(item.url) || (item.type === 'exam' ? EXAM_LIST_URL : WORK_LIST_URL);
  }

  /**
   * 打开条目的学习通页面。
   * 交给后台创建标签页（弹窗可能立即关闭），失败再依次退回 chrome.tabs / window.open。
   */
  async function openItem(item, event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (state.pendingOpen) return;

    const url = itemUrl(item);
    if (!url) {
      showToast('该条目没有可打开的链接', 'warn');
      return;
    }

    state.pendingOpen = true;
    showToast('正在打开作答页…', 'info');

    try {
      const res = unwrapResponse(await sendMessage({ type: 'OPEN_URL', url: url }, 15000));
      if (res.ok) {
        window.close();
        return;
      }
      if (res.error === 'timeout') {
        // 后台仍在解析，标签页已经可见；不要重复新开标签
        window.close();
        return;
      }

      try {
        if (chrome.tabs && typeof chrome.tabs.create === 'function') {
          const created = chrome.tabs.create({ url: url, active: true });
          if (created && typeof created.then === 'function') await created;
          window.close();
          return;
        }
      } catch (err) {
        // 继续尝试 window.open
      }

      try {
        const opened = window.open(url, '_blank', 'noopener');
        if (opened) {
          window.close();
          return;
        }
      } catch (err) {
        // 继续进入错误提示
      }

      showToast('无法打开页面：' + describeError(res.error), 'error');
    } finally {
      state.pendingOpen = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function render() {
    const data = state.data;
    const scanning = isScanning();

    renderBadge(data);
    renderHeaderMeta(data, scanning);
    renderScanButton(scanning);
    renderScanWarning(data);

    const hasItems = itemsOf(data).length > 0;
    const showList = !state.loading && !state.error && hasItems;

    el.loadingView.hidden = !state.loading;
    el.errorView.hidden = state.loading || !state.error;
    el.emptyView.hidden = state.loading || !!state.error || showList;
    el.listView.hidden = !showList;

    if (state.error) {
      el.errorText.textContent = state.error;
    }
    if (showList) {
      renderList(data);
    } else if (!state.loading && !state.error) {
      renderEmpty(data, scanning);
    }
  }

  function renderBadge(data) {
    const loggedIn = getLoggedIn(data);
    if (loggedIn === true) {
      el.loginBadge.className = 'badge badge-ok';
      el.loginBadgeText.textContent = '已登录';
    } else if (loggedIn === false) {
      el.loginBadge.className = 'badge badge-bad';
      el.loginBadgeText.textContent = '未登录';
    } else {
      el.loginBadge.className = 'badge badge-unknown';
      el.loginBadgeText.textContent = '状态未知';
    }
    el.loginLink.hidden = loggedIn !== false;
  }

  function renderHeaderMeta(data, scanning) {
    const meta = data && data.scanMeta && typeof data.scanMeta === 'object' ? data.scanMeta : null;
    const now = Date.now();

    if (!meta) {
      el.lastCheck.textContent = '上次检查：—';
      el.lastCheck.removeAttribute('title');
      el.scanMetaLine.textContent = '';
      return;
    }

    const lastScanAt = typeof meta.lastScanAt === 'number' && meta.lastScanAt > 0 ? meta.lastScanAt : 0;

    if (scanning) {
      el.lastCheck.textContent = '正在检查…';
      el.lastCheck.removeAttribute('title');
    } else if (lastScanAt) {
      el.lastCheck.textContent = '上次检查：' + formatRelative(lastScanAt, now);
      el.lastCheck.title = formatAbsolute(lastScanAt);
    } else {
      el.lastCheck.textContent = '上次检查：从未检查';
      el.lastCheck.removeAttribute('title');
    }

    const parts = [];
    if (scanning && data.progress && typeof data.progress.message === 'string' && data.progress.message) {
      parts.push(data.progress.message);
    }
    if (typeof meta.scannedCourses === 'number' && meta.scannedCourses > 0) {
      parts.push(meta.scannedCourses + ' 门课程');
    }
    if (meta.source === 'manual') parts.push('手动检查');
    else if (meta.source === 'auto') parts.push('自动检查');
    if (!scanning && meta.lastScanOk === false) parts.push('上次检查失败');
    el.scanMetaLine.textContent = parts.join(' · ');
  }

  function renderScanButton(scanning) {
    const busy = scanning || state.pendingScan;
    el.scanBtn.disabled = busy;
    el.scanBtn.classList.toggle('is-busy', busy);
    el.scanBtnText.textContent = busy ? '检查中…' : '立即检查';

    el.emptyScanBtn.disabled = busy;
    el.emptyScanBtn.textContent = busy ? '检查中…' : '立即检查';
  }

  function renderScanWarning(data) {
    const meta = data && data.scanMeta && typeof data.scanMeta === 'object' ? data.scanMeta : null;
    if (!meta || meta.lastScanOk !== false || !meta.lastError) {
      el.scanWarning.hidden = true;
      el.scanWarningText.textContent = '';
      return;
    }
    el.scanWarning.hidden = false;
    el.scanWarningText.textContent = '上次检查未成功：' + describeError(meta.lastError);
  }

  function renderEmpty(data, scanning) {
    const loggedIn = getLoggedIn(data);

    el.emptyScanBtn.hidden = false;
    el.emptyLoginLink.hidden = loggedIn !== false;

    if (scanning) {
      el.emptyTitle.textContent = '正在检查课程…';
      el.emptyDesc.textContent = '正在读取学习通课程与截止时间，请稍候。';
      el.emptyScanBtn.hidden = true;
      el.emptyLoginLink.hidden = true;
      return;
    }

    if (loggedIn === false) {
      el.emptyTitle.textContent = '请先登录学习通';
      el.emptyDesc.textContent = '请先在 Edge 中登录学习通网页版，然后点击「立即检查」。';
      return;
    }

    if (loggedIn === null) {
      el.emptyTitle.textContent = '还没有数据';
      el.emptyDesc.textContent = '暂时无法确认登录状态。请先登录学习通网页版，再点击「立即检查」。';
      return;
    }

    el.emptyTitle.textContent = '暂无作业或考试';
    el.emptyDesc.textContent = '没有发现待办项。你可以点击「立即检查」重新扫描一次。';
  }

  function compareDeadlineAsc(a, b) {
    if (a.deadline === b.deadline) return a.title.localeCompare(b.title, 'zh-Hans-CN');
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline - b.deadline;
  }

  function compareDeadlineDesc(a, b) {
    if (a.deadline === b.deadline) return a.title.localeCompare(b.title, 'zh-Hans-CN');
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return b.deadline - a.deadline;
  }

  function renderList(data) {
    const now = Date.now();
    const normalized = itemsOf(data).map(normalizeItem).filter(Boolean);
    const todo = [];
    const expired = [];
    const done = [];

    for (let i = 0; i < normalized.length; i += 1) {
      const item = normalized[i];
      if (DONE_STATUSES.indexOf(item.status) !== -1) done.push(item);
      // 已截止且未提交：不再占用主待办；若作业重新开放，下一次扫描会把它作为普通待办扫出来。
      // 聚合页对已过期作业通常不再显示“剩余时间”，解析出来 deadline 为 null 的“未交”条目
      // 也一并归到这里，避免它永远挂在主待办。
      else if (
        (item.deadline !== null && item.deadline <= now) ||
        (item.deadline === null &&
          (item.status === '未交' || item.status === '待互评'))
      ) {
        expired.push(item);
      } else {
        todo.push(item);
      }
    }

    todo.sort(compareDeadlineAsc);
    expired.sort(compareDeadlineDesc);
    done.sort(compareDeadlineDesc);

    el.todoCount.textContent = String(todo.length);
    el.todoList.replaceChildren.apply(el.todoList, todo.map(function (item) {
      return createItemNode(item, now, false);
    }));
    el.todoList.hidden = todo.length === 0;
    el.todoEmpty.hidden = todo.length !== 0;
    if (todo.length === 0) {
      if (done.length > 0) el.todoEmpty.textContent = '没有待办项，全部已完成。';
      else if (expired.length > 0) el.todoEmpty.textContent = '没有进行中的待办项。';
      else el.todoEmpty.textContent = '没有待办项。';
    }

    const showExpired =
      Boolean(data && data.config && data.config.showExpiredItems === true);
    el.expiredSection.hidden = !showExpired || expired.length === 0;
    el.expiredTitle.textContent = '已截止/时间未知的未交项 ' + expired.length + ' 项';
    el.expiredList.replaceChildren.apply(el.expiredList, expired.map(function (item) {
      return createItemNode(item, now, false);
    }));
    el.expiredList.hidden = !state.expiredOpen;
    el.expiredToggle.setAttribute('aria-expanded', state.expiredOpen ? 'true' : 'false');

    el.doneSection.hidden = done.length === 0;
    el.doneTitle.textContent = '已完成的 ' + done.length + ' 项';
    el.doneList.replaceChildren.apply(el.doneList, done.map(function (item) {
      return createItemNode(item, now, true);
    }));
    el.doneList.hidden = !state.doneOpen;
    el.doneToggle.setAttribute('aria-expanded', state.doneOpen ? 'true' : 'false');
  }

  function createItemNode(item, now, isDone) {
    const li = document.createElement('li');
    const level = item.deadline === null ? 'nodate' : remainingInfo(item.deadline, now).level;
    li.className = 'item item--' + level + (isDone ? ' item--done' : '');

    // 整张卡片可点击跳转（「打开」文字链接仍然保留）
    const url = itemUrl(item);
    if (url) {
      li.classList.add('item--clickable');
      li.tabIndex = 0;
      li.setAttribute('role', 'link');
      li.setAttribute('aria-label', '在学习通中打开：' + (item.title || '条目'));
      li.addEventListener('click', function (event) {
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('.item-open')) return;
        openItem(item, event);
      });
      li.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          openItem(item, event);
        }
      });
    }

    li.appendChild(createItemHead(item));
    li.appendChild(createItemTitle(item));
    li.appendChild(createItemMeta(item, now, isDone));

    return li;
  }

  function createItemHead(item) {
    const head = document.createElement('div');
    head.className = 'item-head';

    const typeBadge = document.createElement('span');
    typeBadge.className = 'type-badge ' + (item.type === 'exam' ? 'type-exam' : 'type-assignment');
    typeBadge.textContent = item.type === 'exam' ? '考试' : '作业';
    head.appendChild(typeBadge);

    const course = document.createElement('span');
    course.className = 'item-course';
    course.textContent = item.course || '未知课程';
    course.title = item.course || '未知课程';
    head.appendChild(course);

    if (item.status) {
      const status = document.createElement('span');
      status.className = 'item-status';
      status.textContent = item.status;
      status.title = '状态：' + item.status;
      head.appendChild(status);
    }

    return head;
  }

  function createItemTitle(item) {
    const title = document.createElement('p');
    title.className = 'item-title';
    title.textContent = item.title || '（无标题）';
    title.title = item.title || '（无标题）';
    return title;
  }

  function createItemMeta(item, now, isDone) {
    const meta = document.createElement('div');
    meta.className = 'item-meta';

    const deadline = document.createElement('span');
    deadline.className = 'item-deadline';
    if (item.deadline !== null) {
      deadline.textContent = '截止 ' + formatDateTime(item.deadline);
      deadline.title = '截止时间：' + formatAbsolute(item.deadline);
      if (Number.isFinite(item.deadline) && item.deadline < now) {
        deadline.classList.add('is-overdue-time');
      }
    } else {
      deadline.textContent = item.deadlineText || '截止时间未知';
      deadline.classList.add('is-unknown');
      deadline.title = item.deadlineText || '截止时间未知';
    }
    meta.appendChild(deadline);

    // 已完成条目不再展示剩余时间，避免误导；待办展示彩色剩余时间
    if (!isDone && item.deadline !== null) {
      const info = remainingInfo(item.deadline, now);
      const remaining = document.createElement('span');
      remaining.className = 'remaining remaining--' + info.level;
      remaining.textContent = info.text;
      if (info.level === 'overdue') remaining.setAttribute('aria-label', '已过期');
      meta.appendChild(remaining);
    }

    if (isDone && item.score) {
      const score = document.createElement('span');
      score.className = 'item-score';
      score.textContent = '成绩 ' + item.score;
      meta.appendChild(score);
    }

    const url = itemUrl(item);
    if (url) {
      const open = document.createElement('a');
      open.className = 'item-open';
      open.href = url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = '打开';
      open.title = '在学习通中打开：' + url;
      open.addEventListener('click', function (event) {
        openItem(item, event);
      });
      meta.appendChild(open);
    }

    return meta;
  }

  // ---------------------------------------------------------------------------
  // 交互
  // ---------------------------------------------------------------------------

  function showToast(message, kind) {
    window.clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.className = 'toast toast-' + (kind || 'info');
    el.toast.hidden = false;
    state.toastTimer = window.setTimeout(function () {
      el.toast.hidden = true;
    }, 4500);
  }

  function clearPollTimer() {
    if (state.pollTimer) {
      window.clearTimeout(state.pollTimer);
      state.pollTimer = 0;
    }
  }

  function stopPolling() {
    state.polling = false;
    clearPollTimer();
  }

  function startPolling() {
    clearPollTimer();
    state.polling = true;
    render();
    state.pollTimer = window.setTimeout(pollTick, POLL_INTERVAL_MS);
  }

  async function loadState() {
    stopPolling();
    state.loading = true;
    state.error = '';
    render();

    const seq = state.requestSeq + 1;
    state.requestSeq = seq;

    const res = unwrapResponse(await sendMessage({ type: 'GET_STATE' }, STATE_TIMEOUT_MS));
    if (seq !== state.requestSeq) return;

    state.loading = false;

    if (!res.ok) {
      state.data = null;
      state.error = '无法读取监控状态：' + describeError(res.error);
      render();
      return;
    }

    if (!res.data || typeof res.data !== 'object') {
      state.data = null;
      state.error = '扩展返回的数据格式不正确，请重新加载扩展后再试。';
      render();
      return;
    }

    state.data = res.data;
    state.error = '';
    render();
    checkRuntimeVersion(state.data);

    if (isScanning() && !state.polling) {
      startPolling();
    }
  }

  async function pollTick() {
    state.pollTimer = 0;
    if (!state.polling) return;

    const seq = state.requestSeq + 1;
    state.requestSeq = seq;

    const res = unwrapResponse(await sendMessage({ type: 'GET_STATE' }, STATE_TIMEOUT_MS));
    if (seq !== state.requestSeq) return;
    if (!state.polling) return;

    if (!res.ok) {
      stopPolling();
      render();
      showToast('刷新状态失败：' + describeError(res.error), 'error');
      return;
    }

    if (!res.data || typeof res.data !== 'object') {
      stopPolling();
      render();
      showToast('扩展返回的数据格式不正确，请重新加载扩展', 'error');
      return;
    }

    state.data = res.data;
    state.loading = false;
    state.error = '';
    render();

    if (isScanning()) {
      state.pollTimer = window.setTimeout(pollTick, POLL_INTERVAL_MS);
      return;
    }

    stopPolling();
    render();

    if (state.userScan) {
      state.userScan = false;
      const meta = state.data && state.data.scanMeta && typeof state.data.scanMeta === 'object' ? state.data.scanMeta : null;
      if (meta && meta.lastScanOk === false) {
        showToast('检查未成功：' + describeError(meta.lastError), 'error');
      } else {
        showToast('检查完成', 'success');
      }
    }
  }

  async function scanNow() {
    if (state.pendingScan || isScanning()) return;

    state.pendingScan = true;
    state.userScan = true;
    render();

    const res = unwrapResponse(await sendMessage({ type: 'SCAN_NOW' }, ACTION_TIMEOUT_MS));
    state.pendingScan = false;

    if (!res.ok) {
      state.userScan = false;
      render();
      showToast('无法开始检查：' + describeError(res.error), 'error');
      return;
    }

    const payload = res.data && typeof res.data === 'object' ? res.data : {};
    if (payload.started === false) {
      // 没有真正开始扫描，不显示“检查完成”之类的总结提示
      state.userScan = false;
      if (payload.error) {
        showToast('无法开始检查：' + describeError(payload.error), 'warn');
      }
      // 无 error 时可能扫描瞬间完成，静默轮询刷新即可
    }

    startPolling();
  }

  async function openOptions() {
    const res = unwrapResponse(await sendMessage({ type: 'OPEN_OPTIONS' }, 5000));
    if (res.ok) {
      window.close();
      return;
    }

    try {
      if (chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') {
        chrome.runtime.openOptionsPage();
        window.close();
        return;
      }
    } catch (err) {
      // 继续走提示分支
    }

    showToast('无法打开设置页，请在扩展菜单中选择「选项」', 'error');
  }

  function toggleDone() {
    state.doneOpen = !state.doneOpen;
    el.doneList.hidden = !state.doneOpen;
    el.doneToggle.setAttribute('aria-expanded', state.doneOpen ? 'true' : 'false');
  }

  function toggleExpired() {
    state.expiredOpen = !state.expiredOpen;
    el.expiredList.hidden = !state.expiredOpen;
    el.expiredToggle.setAttribute('aria-expanded', state.expiredOpen ? 'true' : 'false');
  }

  function bindEvents() {
    el.loginLink.href = LOGIN_URL;
    el.emptyLoginLink.href = LOGIN_URL;

    el.scanBtn.addEventListener('click', function () {
      scanNow();
    });
    el.emptyScanBtn.addEventListener('click', function () {
      scanNow();
    });
    el.optionsBtn.addEventListener('click', function () {
      openOptions();
    });
    el.errorOptionsBtn.addEventListener('click', function () {
      openOptions();
    });
    el.retryBtn.addEventListener('click', function () {
      loadState();
    });
    el.doneToggle.addEventListener('click', toggleDone);
    el.expiredToggle.addEventListener('click', toggleExpired);

    window.addEventListener('pagehide', function () {
      stopPolling();
      window.clearTimeout(state.toastTimer);
    });
  }

  function fillVersion() {
    try {
      const versionEl = document.getElementById('popupVersion');
      const version = chrome.runtime.getManifest().version;
      if (versionEl && version) versionEl.textContent = 'v' + version;
    } catch {
      /* 忽略 */
    }
  }

  /** 检查后台 service worker 的版本是否与界面一致（旧版后台会静默丢新字段）。 */
  function checkRuntimeVersion(data) {
    try {
      const uiVersion = chrome.runtime.getManifest().version;
      const swVersion = data && data.runtimeVersion;
      if (!swVersion) {
        showToast('扩展后台代码未更新，请到扩展页重新加载扩展或重启 Edge', 'error');
      } else if (uiVersion && swVersion !== uiVersion) {
        showToast('界面与后台版本不一致，请重新加载扩展或重启 Edge', 'error');
      }
    } catch {
      /* 忽略 */
    }
  }

  function init() {
    cacheElements();
    fillVersion();
    bindEvents();
    loadState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
