'use strict';

/**
 * 学习通截止提醒 — 设置页逻辑
 * 所有控件通过 addEventListener 绑定；所有动态文本用 textContent，禁止 innerHTML。
 */

(function () {
  const DEFAULT_CONFIG = {
    scanIntervalMinutes: 60,
    checkAssignments: true,
    checkExams: true,
    reminderHours: [72, 24, 6, 1],
    expiredAlert: true,
    browserNotifications: true,
    emailEnabled: false,
    mailProxyUrl: 'http://127.0.0.1:8765',
    maxCourses: 15,
    autoFillAccount: true,
    rememberedAccount: '',
    courseFilterEnabled: false,
    scheduleCourses: [],
    dxAiChatAutoOpen: true,
    showExpiredItems: false
  };

  const HOUR_CHOICES = [72, 24, 6, 1];

  /** 界面代码版本（从浏览器加载的 manifest 读取，而不是硬编码文本）。 */
  const UI_VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '';
    }
  })();
  const GET_TIMEOUT_MS = 15000;
  const SAVE_TIMEOUT_MS = 15000;
  const TEST_TIMEOUT_MS = 35000;
  const CLEAR_TIMEOUT_MS = 10000;
  const TOAST_DURATION_MS = 3200;
  const REPORT_CHECK_TIMEOUT_MS = 20000;
  const REPORT_CHECK_POLL_MS = 2500;

  const el = {};
  const state = {
    config: null,
    loaded: false,
    saving: false,
    requestSeq: 0,
    toastTimer: 0,
    scheduleCandidates: [],
    scheduleSelected: [],
    reportCheckTimer: 0,
    reportCheckPolling: false
  };

  const KNOWN_ERRORS = {
    timeout: '操作超时，请稍后重试',
    no_response: '扩展后台没有响应，请在扩展管理页重新加载扩展后再试',
    runtime_error: '无法连接扩展后台，请确认扩展已启用后重试',
    unknown_action: '扩展不支持该操作，请更新到最新版本',
    invalid_config: '设置内容无效，请检查后重试'
  };

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    el.form = $('settingsForm');
    el.toast = $('toast');
    el.loadBanner = $('loadBanner');
    el.loadBannerText = $('loadBannerText');
    el.reloadConfigBtn = $('reloadConfigBtn');

    el.scanInterval = $('scanIntervalMinutes');
    el.scanIntervalError = $('scanIntervalError');
    el.maxCourses = $('maxCourses');
    el.maxCoursesError = $('maxCoursesError');
    el.checkAssignments = $('checkAssignments');
    el.checkExams = $('checkExams');
    el.dxAiChatAutoOpen = $('dxAiChatAutoOpen');
    el.showExpiredItems = $('showExpiredItems');

    el.reminderHoursGroup = $('reminderHoursGroup');
    el.reminderHoursError = $('reminderHoursError');
    el.hourInputs = Array.prototype.slice.call(el.reminderHoursGroup.querySelectorAll('input[data-hour]'));

    el.expiredAlert = $('expiredAlert');
    el.browserNotifications = $('browserNotifications');

    el.emailEnabled = $('emailEnabled');
    el.mailProxyUrl = $('mailProxyUrl');
    el.mailProxyUrlError = $('mailProxyUrlError');
    el.testEmailBtn = $('testEmailBtn');
    el.mailResult = $('mailResult');

    el.autoFillAccount = $('autoFillAccount');
    el.rememberedAccount = $('rememberedAccount');
    el.rememberedAccountError = $('rememberedAccountError');

    el.clearItemsBtn = $('clearItemsBtn');
    el.resetDefaultsBtn = $('resetDefaultsBtn');
    el.copyDebugBtn = $('copyDebugBtn');
    el.debugResult = $('debugResult');

    el.checkReportsBtn = $('checkReportsBtn');
    el.reportCheckStatus = $('reportCheckStatus');
    el.reportCheckResults = $('reportCheckResults');
    el.reportCheckIncludePast = $('reportCheckIncludePast');

    el.courseFilterEnabled = $('courseFilterEnabled');
    el.scheduleFileInput = $('scheduleFileInput');
    el.scheduleUploadBtn = $('scheduleUploadBtn');
    el.scheduleCandidatesWrap = $('scheduleCandidatesWrap');
    el.scheduleCandidates = $('scheduleCandidates');
    el.scheduleParseHint = $('scheduleParseHint');
    el.scheduleSelectAllBtn = $('scheduleSelectAllBtn');
    el.scheduleSelectNoneBtn = $('scheduleSelectNoneBtn');
    el.scheduleManualInput = $('scheduleManualInput');
    el.scheduleAddManualBtn = $('scheduleAddManualBtn');
    el.scheduleSelectedList = $('scheduleSelectedList');
    el.scheduleCount = $('scheduleCount');
    el.scheduleEmptyHint = $('scheduleEmptyHint');
    el.scheduleClearBtn = $('scheduleClearBtn');
    el.scheduleError = $('scheduleError');

    el.saveBtn = $('saveBtn');
    el.saveHint = $('saveHint');
    el.uiVersion = $('uiVersion');
    el.footerVersion = $('footerVersion');
  }

  // ---------------------------------------------------------------------------
  // 消息封装（容错：超时、后台未响应、{ok:false}、直接返回业务对象）
  // ---------------------------------------------------------------------------

  function sendMessage(message, timeoutMs) {
    const limit = typeof timeoutMs === 'number' ? timeoutMs : GET_TIMEOUT_MS;
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
      const keyLower = keys[i].toLowerCase();
      if (lower === keyLower || lower.indexOf(keyLower + ':') === 0 || lower.indexOf(keyLower + ' ') === 0) {
        return KNOWN_ERRORS[keys[i]];
      }
    }

    if (/could not establish connection|receiving end does not exist/i.test(text)) {
      return '无法连接扩展后台，请确认扩展已启用后重试';
    }
    if (/timeout|timed\s*out/i.test(text)) {
      return KNOWN_ERRORS.timeout;
    }

    return /[\u4e00-\u9fa5]/.test(text) ? text : '扩展返回错误：' + text;
  }

  // ---------------------------------------------------------------------------
  // 配置读取 / 归一化
  // ---------------------------------------------------------------------------

  function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const int = Math.round(num);
    if (int < min) return min;
    if (int > max) return max;
    return int;
  }

  function mergeConfig(base, incoming) {
    const config = Object.assign({}, base);
    if (!incoming || typeof incoming !== 'object') return config;

    config.scanIntervalMinutes = clampInt(incoming.scanIntervalMinutes, 15, 720, base.scanIntervalMinutes);
    config.maxCourses = clampInt(incoming.maxCourses, 1, 50, base.maxCourses);

    const booleans = [
      'checkAssignments',
      'checkExams',
      'expiredAlert',
      'browserNotifications',
      'emailEnabled',
      'autoFillAccount',
      'courseFilterEnabled',
      'dxAiChatAutoOpen',
      'showExpiredItems'
    ];
    for (let i = 0; i < booleans.length; i += 1) {
      const key = booleans[i];
      if (typeof incoming[key] === 'boolean') config[key] = incoming[key];
    }

    if (Array.isArray(incoming.scheduleCourses)) {
      config.scheduleCourses = incoming.scheduleCourses
        .map(function (item) {
          return String(item == null ? '' : item).trim();
        })
        .filter(Boolean)
        .slice(0, 60);
    }

    if (Array.isArray(incoming.reminderHours)) {
      const selected = [];
      for (let i = 0; i < HOUR_CHOICES.length; i += 1) {
        if (incoming.reminderHours.map(Number).indexOf(HOUR_CHOICES[i]) !== -1) {
          selected.push(HOUR_CHOICES[i]);
        }
      }
      config.reminderHours = selected.length > 0 ? selected : base.reminderHours.slice();
    }

    if (typeof incoming.mailProxyUrl === 'string') config.mailProxyUrl = incoming.mailProxyUrl;
    if (typeof incoming.rememberedAccount === 'string') config.rememberedAccount = incoming.rememberedAccount;

    return config;
  }

  function readInt(input) {
    const raw = input.value.trim();
    if (raw === '') return NaN;
    const value = Number(raw);
    return Number.isInteger(value) ? value : NaN;
  }

  function readForm() {
    return {
      scanIntervalMinutes: readInt(el.scanInterval),
      maxCourses: readInt(el.maxCourses),
      checkAssignments: el.checkAssignments.checked,
      checkExams: el.checkExams.checked,
      reminderHours: HOUR_CHOICES.filter(function (hour) {
        return el.hourInputs.some(function (input) {
          return Number(input.dataset.hour) === hour && input.checked;
        });
      }),
      expiredAlert: el.expiredAlert.checked,
      browserNotifications: el.browserNotifications.checked,
      emailEnabled: el.emailEnabled.checked,
      mailProxyUrl: el.mailProxyUrl.value.trim(),
      autoFillAccount: el.autoFillAccount.checked,
      rememberedAccount: el.rememberedAccount.value.trim(),
      courseFilterEnabled: el.courseFilterEnabled.checked,
      scheduleCourses: state.scheduleSelected.slice(),
      dxAiChatAutoOpen: el.dxAiChatAutoOpen.checked,
      showExpiredItems: el.showExpiredItems.checked
    };
  }

  function fillForm(config) {
    el.scanInterval.value = String(config.scanIntervalMinutes);
    el.maxCourses.value = String(config.maxCourses);
    el.checkAssignments.checked = config.checkAssignments === true;
    el.checkExams.checked = config.checkExams === true;

    const selected = Array.isArray(config.reminderHours) ? config.reminderHours.map(Number) : [];
    for (let i = 0; i < el.hourInputs.length; i += 1) {
      const input = el.hourInputs[i];
      input.checked = selected.indexOf(Number(input.dataset.hour)) !== -1;
    }

    el.expiredAlert.checked = config.expiredAlert === true;
    el.browserNotifications.checked = config.browserNotifications === true;
    el.emailEnabled.checked = config.emailEnabled === true;
    el.mailProxyUrl.value = config.mailProxyUrl || '';
    el.autoFillAccount.checked = config.autoFillAccount === true;
    el.rememberedAccount.value = config.rememberedAccount || '';

    el.courseFilterEnabled.checked = config.courseFilterEnabled === true;
    el.dxAiChatAutoOpen.checked = config.dxAiChatAutoOpen !== false;
    el.showExpiredItems.checked = config.showExpiredItems === true;
    state.scheduleCandidates = [];
    state.scheduleSelected = Array.isArray(config.scheduleCourses)
      ? config.scheduleCourses.slice()
      : [];
    if (el.scheduleCandidatesWrap) el.scheduleCandidatesWrap.hidden = true;
    if (el.scheduleParseHint) el.scheduleParseHint.textContent = '';
    renderSchedule();

    clearAllErrors();
  }

  // ---------------------------------------------------------------------------
  // 校验与错误展示
  // ---------------------------------------------------------------------------

  function isLoopbackHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  function validateProxyUrl(raw, required) {
    const value = String(raw || '').trim();
    if (!value) return required ? '启用邮件通知时请填写代理地址' : '';

    let parsed;
    try {
      parsed = new URL(value);
    } catch (err) {
      return '请输入有效地址，例如 http://127.0.0.1:8765';
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '只支持 http:// 或 https:// 地址';
    }
    if (!isLoopbackHost(parsed.hostname)) {
      return '只允许本机地址（127.0.0.1、localhost 或 [::1]）';
    }
    return '';
  }

  function validateConfig(config) {
    const errors = {};

    if (
      !Number.isInteger(config.scanIntervalMinutes) ||
      config.scanIntervalMinutes < 15 ||
      config.scanIntervalMinutes > 720
    ) {
      errors.scanIntervalMinutes = '请输入 15 ~ 720 之间的整数（分钟）';
    }

    if (!Number.isInteger(config.maxCourses) || config.maxCourses < 1 || config.maxCourses > 50) {
      errors.maxCourses = '请输入 1 ~ 50 之间的整数（门）';
    }

    if (!Array.isArray(config.reminderHours) || config.reminderHours.length === 0) {
      errors.reminderHours = '请至少选择一个提醒阈值';
    }

    const proxyError = validateProxyUrl(config.mailProxyUrl, config.emailEnabled);
    if (proxyError) errors.mailProxyUrl = proxyError;

    if (typeof config.rememberedAccount === 'string' && config.rememberedAccount.length > 64) {
      errors.rememberedAccount = '账号长度不能超过 64 个字符';
    }

    if (
      config.courseFilterEnabled &&
      (!Array.isArray(config.scheduleCourses) || config.scheduleCourses.length === 0)
    ) {
      errors.scheduleCourses = '已开启课表过滤：请先上传课表或手动添加至少一门课程';
    }

    return errors;
  }

  function setFieldError(input, errorEl, message) {
    const hasError = !!message;
    if (errorEl) {
      errorEl.textContent = hasError ? message : '';
      errorEl.hidden = !hasError;
    }
    if (input) {
      input.classList.toggle('is-invalid', hasError);
      if (hasError) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function applyErrors(errors) {
    setFieldError(el.scanInterval, el.scanIntervalError, errors.scanIntervalMinutes);
    setFieldError(el.maxCourses, el.maxCoursesError, errors.maxCourses);
    setFieldError(el.mailProxyUrl, el.mailProxyUrlError, errors.mailProxyUrl);
    setFieldError(el.rememberedAccount, el.rememberedAccountError, errors.rememberedAccount);
    setFieldError(null, el.scheduleError, errors.scheduleCourses);

    const hoursMessage = errors.reminderHours || '';
    el.reminderHoursError.textContent = hoursMessage;
    el.reminderHoursError.hidden = !hoursMessage;
    el.reminderHoursGroup.classList.toggle('is-invalid', !!hoursMessage);
  }

  function clearAllErrors() {
    applyErrors({});
  }

  function focusFirstError() {
    const invalid = document.querySelector('.field input.is-invalid');
    if (invalid && typeof invalid.focus === 'function') invalid.focus();
    else if (el.reminderHoursGroup.classList.contains('is-invalid')) {
      const firstHour = el.hourInputs.length > 0 ? el.hourInputs[0] : null;
      if (firstHour) firstHour.focus();
    }
  }

  function handleFieldInput(event) {
    const target = event.target;
    if (!target || target.nodeType !== 1 || !target.matches('input')) return;

    const field = target.closest('.field');
    if (!field) return;

    const errorEl = field.querySelector('.field-error');
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
    if (target.classList.contains('is-invalid')) {
      target.classList.remove('is-invalid');
      target.removeAttribute('aria-invalid');
    }
    if (field.contains(el.reminderHoursGroup)) {
      el.reminderHoursGroup.classList.remove('is-invalid');
      el.reminderHoursError.hidden = true;
      el.reminderHoursError.textContent = '';
    }
  }

  // ---------------------------------------------------------------------------
  // 提示
  // ---------------------------------------------------------------------------

  function showToast(message, kind) {
    window.clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.className = 'toast toast-' + (kind || 'info');
    el.toast.hidden = false;
    state.toastTimer = window.setTimeout(function () {
      el.toast.hidden = true;
    }, TOAST_DURATION_MS);
  }

  function showLoadBanner(message) {
    el.loadBannerText.textContent = message;
    el.loadBanner.hidden = false;
  }

  function hideLoadBanner() {
    el.loadBanner.hidden = true;
    el.loadBannerText.textContent = '';
  }

  function formatClock(date) {
    const hours = date.getHours() < 10 ? '0' + date.getHours() : String(date.getHours());
    const minutes = date.getMinutes() < 10 ? '0' + date.getMinutes() : String(date.getMinutes());
    return hours + ':' + minutes;
  }

  function setSaveHint(message) {
    if (el.saveHint) el.saveHint.textContent = message;
  }

  /**
   * 显示界面版本，并检查后台（service worker）代码是否同步更新。
   * 旧版后台不会返回 runtimeVersion，借此提示用户重新加载扩展。
   */
  function fillVersions(swVersion) {
    if (el.uiVersion) el.uiVersion.textContent = UI_VERSION ? 'v' + UI_VERSION : '';
    if (el.footerVersion) {
      el.footerVersion.textContent = '学习通截止提醒' + (UI_VERSION ? ' · v' + UI_VERSION : '');
    }
    if (!state.loaded) return;
    if (!swVersion) {
      showLoadBanner(
        '检测到扩展后台代码未更新（后台没有返回版本信息）：请到 edge://extensions 点击本扩展卡片上的「重新加载」按钮，或重启 Edge。'
      );
    } else if (UI_VERSION && swVersion !== UI_VERSION) {
      showLoadBanner(
        '界面版本 v' +
          UI_VERSION +
          ' 与后台版本 v' +
          swVersion +
          ' 不一致：请重新加载扩展或重启 Edge。'
      );
    }
  }

  function setMailResult(message, kind) {
    el.mailResult.textContent = message;
    el.mailResult.className = 'mail-result is-' + (kind || 'pending');
    el.mailResult.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // 加载 / 保存
  // ---------------------------------------------------------------------------

  async function loadConfig() {
    const seq = state.requestSeq + 1;
    state.requestSeq = seq;
    el.reloadConfigBtn.disabled = true;

    const res = unwrapResponse(await sendMessage({ type: 'GET_STATE' }, GET_TIMEOUT_MS));
    if (seq !== state.requestSeq) return;
    el.reloadConfigBtn.disabled = false;

    if (!res.ok) {
      showLoadBanner('无法读取当前设置：' + describeError(res.error) + '。你仍可以修改并保存。');
      if (!state.config) {
        state.config = mergeConfig(DEFAULT_CONFIG, {});
        fillForm(state.config);
      }
      return;
    }

    const data = res.data;
    const incoming = data && typeof data === 'object' && data.config && typeof data.config === 'object' ? data.config : {};
    const config = mergeConfig(DEFAULT_CONFIG, incoming);

    state.config = config;
    state.loaded = true;
    fillForm(config);
    hideLoadBanner();
    fillVersions(data && data.runtimeVersion);
  }

  function setSaving(saving) {
    state.saving = saving;
    el.saveBtn.disabled = saving;
    el.saveBtn.textContent = saving ? '保存中…' : '保存设置';
  }

  function extractSavedConfig(data, fallback) {
    if (data && typeof data === 'object' && data.config && typeof data.config === 'object') {
      return mergeConfig(DEFAULT_CONFIG, data.config);
    }
    return mergeConfig(DEFAULT_CONFIG, fallback);
  }

  async function saveConfig(options) {
    const silent = !!(options && options.silent);
    if (state.saving) return false;

    // 输入框里还有没点「添加」的课程时，先自动添加，避免用户以为已添加但没生效
    const pendingInput = el.scheduleManualInput ? el.scheduleManualInput.value.trim() : '';
    if (pendingInput) addManualCourses(true);

    const config = readForm();
    const errors = validateConfig(config);
    if (Object.keys(errors).length > 0) {
      applyErrors(errors);
      focusFirstError();
      if (!silent) showToast('请先修正表单中的错误', 'error');
      return false;
    }

    clearAllErrors();
    setSaving(true);

    const res = unwrapResponse(await sendMessage({ type: 'SAVE_CONFIG', config: config }, SAVE_TIMEOUT_MS));
    setSaving(false);

    if (!res.ok) {
      showToast('保存失败：' + describeError(res.error), 'error');
      return false;
    }

    state.config = extractSavedConfig(res.data, config);
    state.loaded = true;
    // 用服务端返回的课程列表校准界面，确保保存真的生效（防止"以为保存了但没存上"）
    state.scheduleSelected = Array.isArray(state.config.scheduleCourses)
      ? state.config.scheduleCourses.slice()
      : [];
    renderSchedule();
    hideLoadBanner();
    setSaveHint('上次保存：' + formatClock(new Date()) + '，设置只保存在本机浏览器的扩展存储中。');
    if (!silent) {
      if (state.scheduleSelected.length > 0 && !el.courseFilterEnabled.checked) {
        showToast('已保存，但未开启「只监控课表内的课程」，历史课程仍会出现', 'info');
      } else {
        showToast('已保存', 'success');
      }
    }

    // 回读校验：确认后台真的保存了课表课程。
    // 若后台仍是旧代码，它不认识 scheduleCourses，会静默丢弃——这里能立刻发现。
    try {
      const verify = unwrapResponse(await sendMessage({ type: 'GET_STATE' }, GET_TIMEOUT_MS));
      const verifyData = verify.ok ? verify.data : null;
      if (!verifyData || !verifyData.runtimeVersion) {
        setSaveHint(
          '警告：扩展后台代码未更新，设置可能没有真正保存。请到 edge://extensions 重新加载扩展，或重启 Edge。'
        );
        if (!silent) showToast('后台未更新：课表可能没有保存', 'error');
      } else {
        fillVersions(verifyData.runtimeVersion);
        const serverCourses = Array.isArray(verifyData.config && verifyData.config.scheduleCourses)
          ? verifyData.config.scheduleCourses
          : [];
        const want = Array.isArray(config.scheduleCourses) ? config.scheduleCourses.length : 0;
        if (serverCourses.length !== want) {
          setSaveHint('警告：后台没有保存课表课程，请重新加载扩展或重启 Edge 后重试。');
          if (!silent) showToast('课表课程未保存：请重新加载扩展', 'error');
        }
      }
    } catch {
      /* 回读失败不影响主流程 */
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 测试邮件
  // ---------------------------------------------------------------------------

  function mailOutcome(res) {
    if (!res.ok) return { ok: false, error: res.error };
    const data = res.data;
    if (data && typeof data === 'object') {
      if (data.ok === false) return { ok: false, error: data.error };
      if (data.sent === false) return { ok: false, error: data.error || '' };
    }
    return { ok: true, error: '' };
  }

  function mailErrorText(code) {
    const text = errorTextOf(code).trim();
    if (!text) return '测试邮件发送失败，请检查本地邮件代理与 SMTP 配置。';

    if (/not[_\s-]?configured|no[_\s-]?config|config[_\s-]?missing|mail[_\s-]?not[_\s-]?configured/i.test(text)) {
      return '邮件代理尚未配置 SMTP：请在 mail-proxy 目录创建 config.json（参考 config.example.json），填写邮箱信息并重启 start.bat。';
    }
    if (/refused|unreachable|econn|network|failed to fetch|connect|timeout|timed out/i.test(text)) {
      return '无法连接本地邮件代理：请确认已双击 mail-proxy/start.bat 启动代理，地址为 http://127.0.0.1:8765。';
    }
    if (/auth|535|login|password|credentials/i.test(text)) {
      return 'SMTP 登录失败：请检查 config.json 中的 smtp_user / smtp_pass，多数邮箱需要使用授权码。';
    }
    if (/[\u4e00-\u9fa5]/.test(text)) return '测试邮件发送失败：' + text;
    return '测试邮件发送失败：' + text + '（请检查代理日志 proxy.log）';
  }

  async function testEmail() {
    if (el.testEmailBtn.disabled) return;

    const currentUrl = el.mailProxyUrl.value.trim();
    const urlError = validateProxyUrl(currentUrl, true);
    if (urlError) {
      setFieldError(el.mailProxyUrl, el.mailProxyUrlError, urlError);
      el.mailProxyUrl.focus();
      return;
    }

    el.testEmailBtn.disabled = true;
    el.testEmailBtn.textContent = '发送中…';
    setMailResult('正在通过本地邮件代理发送测试邮件，请稍候…', 'pending');

    const res = unwrapResponse(await sendMessage({ type: 'TEST_EMAIL' }, TEST_TIMEOUT_MS));

    el.testEmailBtn.disabled = false;
    el.testEmailBtn.textContent = '发送测试邮件';

    const outcome = mailOutcome(res);
    if (!outcome.ok) {
      setMailResult(mailErrorText(outcome.error), 'error');
      return;
    }

    const savedUrl = state.config && typeof state.config.mailProxyUrl === 'string' ? state.config.mailProxyUrl : '';
    let message = '测试邮件已发送，请检查收件箱（也看一下垃圾邮件）。';
    if (savedUrl && currentUrl && savedUrl !== currentUrl) {
      message += ' 注意：本次使用的是已保存的地址 ' + savedUrl + '，修改后的地址需点击「保存设置」后生效。';
    }
    setMailResult(message, 'success');
  }

  // ---------------------------------------------------------------------------
  // 数据管理
  // ---------------------------------------------------------------------------

  async function clearItems() {
    if (el.clearItemsBtn.disabled) return;
    const confirmed = window.confirm('确定清空已缓存的作业/考试列表吗？已提醒记录也会一并清空，设置不受影响。');
    if (!confirmed) return;

    el.clearItemsBtn.disabled = true;
    const res = unwrapResponse(await sendMessage({ type: 'CLEAR_ITEMS' }, CLEAR_TIMEOUT_MS));
    el.clearItemsBtn.disabled = false;

    if (res.ok) showToast('已清空缓存数据', 'success');
    else showToast('清空失败：' + describeError(res.error), 'error');
  }

  async function resetDefaults() {
    const confirmed = window.confirm('确定把所有设置恢复为默认值吗？该操作会立即保存。');
    if (!confirmed) return;

    fillForm(DEFAULT_CONFIG);
    clearAllErrors();

    const saved = await saveConfig({ silent: true });
    if (saved) showToast('已恢复默认设置', 'success');
  }

  // ---------------------------------------------------------------------------
  // 课表课程过滤
  // ---------------------------------------------------------------------------

  function scheduleKey(name) {
    return String(name || '')
      .replace(/[（(【\[].*?[)）】\]]/g, '')
      .replace(/\s+/g, '')
      .trim()
      .toLowerCase();
  }

  function isScheduleSelected(name) {
    const key = scheduleKey(name);
    return state.scheduleSelected.some(function (item) {
      return scheduleKey(item) === key;
    });
  }

  function renderScheduleCandidates() {
    if (!el.scheduleCandidates) return;
    el.scheduleCandidates.textContent = '';
    for (const cand of state.scheduleCandidates) {
      const label = document.createElement('label');
      label.className = 'check-pill';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.course = cand.name;
      input.checked = isScheduleSelected(cand.name);
      const span = document.createElement('span');
      span.textContent = cand.name + (cand.count > 1 ? ' ×' + cand.count : '');
      label.appendChild(input);
      label.appendChild(span);
      el.scheduleCandidates.appendChild(label);
    }
    if (el.scheduleCandidatesWrap) {
      el.scheduleCandidatesWrap.hidden = state.scheduleCandidates.length === 0;
    }
  }

  function renderScheduleSelected() {
    if (!el.scheduleSelectedList) return;
    el.scheduleSelectedList.textContent = '';
    for (const name of state.scheduleSelected) {
      const chip = document.createElement('span');
      chip.className = 'schedule-chip';
      const text = document.createElement('span');
      text.textContent = name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '移除 ' + name;
      remove.setAttribute('aria-label', '移除 ' + name);
      remove.addEventListener('click', function () {
        removeScheduleCourse(name);
      });
      chip.appendChild(text);
      chip.appendChild(remove);
      el.scheduleSelectedList.appendChild(chip);
    }
    if (el.scheduleCount) el.scheduleCount.textContent = String(state.scheduleSelected.length);
    if (el.scheduleEmptyHint) el.scheduleEmptyHint.hidden = state.scheduleSelected.length > 0;
  }

  function renderSchedule() {
    renderScheduleCandidates();
    renderScheduleSelected();
  }

  function addScheduleCourse(name) {
    const value = String(name || '').trim();
    if (!value) return;
    const key = scheduleKey(value);
    if (!key) return;
    if (state.scheduleSelected.some(function (item) {
      return scheduleKey(item) === key;
    })) {
      return;
    }
    if (state.scheduleSelected.length >= 60) {
      if (el.scheduleError) {
        el.scheduleError.textContent = '课程数量已达上限（60 门）';
        el.scheduleError.hidden = false;
      }
      return;
    }
    state.scheduleSelected.push(value.slice(0, 40));
    renderScheduleSelected();
    renderScheduleCandidates();
  }

  function removeScheduleCourse(name) {
    const key = scheduleKey(name);
    state.scheduleSelected = state.scheduleSelected.filter(function (item) {
      return scheduleKey(item) !== key;
    });
    renderScheduleSelected();
    renderScheduleCandidates();
  }

  function addManualCourses(silent) {
    const raw = el.scheduleManualInput ? el.scheduleManualInput.value : '';
    const parts = raw
      .split(/[,，、;；\s]+/)
      .map(function (item) {
        return item.trim();
      })
      .filter(Boolean);
    if (!parts.length) return;
    for (const part of parts) addScheduleCourse(part);
    if (el.scheduleManualInput) el.scheduleManualInput.value = '';
    if (el.scheduleError) {
      el.scheduleError.hidden = true;
      el.scheduleError.textContent = '';
    }
    if (!silent) showToast('已添加课程', 'success');
  }

  async function onScheduleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (el.scheduleParseHint) el.scheduleParseHint.textContent = '正在解析课表…';
    try {
      const buffer = await file.arrayBuffer();
      const parser = window.CXSchedule;
      if (!parser) throw new Error('课表解析模块未加载，请重新加载扩展');
      const result = await parser.parseFile({ name: file.name, buffer: buffer });
      state.scheduleCandidates = result.candidates.slice(0, 100);
      // 自动勾选识别到的课程（用户可手动取消）
      state.scheduleSelected = result.candidates
        .map(function (cand) {
          return cand.name;
        })
        .slice(0, 60);
      // 上传课表后自动开启课表过滤（用户可关闭）
      if (state.scheduleSelected.length > 0 && el.courseFilterEnabled) {
        el.courseFilterEnabled.checked = true;
      }
      if (el.scheduleCandidatesWrap) el.scheduleCandidatesWrap.hidden = false;
      if (el.scheduleParseHint) {
        el.scheduleParseHint.textContent =
          result.candidates.length > 0
            ? '共识别到 ' +
              result.candidates.length +
              ' 门课程，已自动勾选并开启课表过滤；点「保存设置」后生效。'
            : '没有识别到课程名，请换一个文件，或在下方手动添加课程。';
      }
      renderSchedule();
      showToast('课表解析完成，已自动勾选 ' + state.scheduleSelected.length + ' 门课程', 'success');
    } catch (e) {
      if (el.scheduleParseHint) {
        el.scheduleParseHint.textContent =
          '解析失败：' + (e && e.message ? e.message : e);
      }
      showToast('课表解析失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (el.scheduleFileInput) el.scheduleFileInput.value = '';
    }
  }

  function handleScheduleCandidateClick(event) {
    const input = event.target;
    if (!input || input.nodeType !== 1 || input.type !== 'checkbox' || !input.dataset.course) return;
    if (input.checked) addScheduleCourse(input.dataset.course);
    else removeScheduleCourse(input.dataset.course);
  }

  function selectAllCandidates() {
    for (const cand of state.scheduleCandidates) addScheduleCourse(cand.name);
    renderScheduleCandidates();
  }

  function selectNoneCandidates() {
    const keys = state.scheduleCandidates.map(function (cand) {
      return scheduleKey(cand.name);
    });
    state.scheduleSelected = state.scheduleSelected.filter(function (item) {
      return keys.indexOf(scheduleKey(item)) === -1;
    });
    renderScheduleSelected();
    renderScheduleCandidates();
  }

  function clearScheduleCourses() {
    if (state.scheduleSelected.length === 0) return;
    if (!window.confirm('确定清空已选择的课程吗？')) return;
    state.scheduleSelected = [];
    renderScheduleSelected();
    renderScheduleCandidates();
  }

  // ---------------------------------------------------------------------------
  // 诊断数据
  // ---------------------------------------------------------------------------

  async function copyDebugData() {
    if (!el.copyDebugBtn || el.copyDebugBtn.disabled) return;
    el.copyDebugBtn.disabled = true;
    el.copyDebugBtn.textContent = '读取中…';
    try {
      const [data, scanStateData] = await Promise.all([
        chrome.storage.local.get('debugRaw'),
        chrome.storage.local.get('scanState')
      ]);
      const raw = data && data.debugRaw;
      if (!raw) {
        const scanningNow = Boolean(scanStateData && scanStateData.scanState);
        if (el.debugResult) {
          el.debugResult.hidden = false;
          el.debugResult.textContent = scanningNow
            ? '正在检查中，请等这次检查完成后再复制诊断数据。'
            : '还没有诊断数据：请先在扩展弹窗里点一次「立即检查」，等检查完成后再回来复制。';
        }
        return;
      }
      const text = JSON.stringify(raw, null, 2);
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
      if (el.debugResult) {
        el.debugResult.hidden = false;
        el.debugResult.textContent = '';
        if (copied) {
          el.debugResult.textContent =
            '已复制到剪贴板（' + text.length + ' 字符）。直接粘贴发给开发者即可。';
        } else {
          const hint = document.createElement('span');
          hint.textContent = '自动复制失败，请手动复制下面的内容：';
          const area = document.createElement('textarea');
          area.value = text;
          area.readOnly = true;
          area.style.cssText =
            'width:100%;height:180px;margin-top:8px;font-family:Consolas,monospace;font-size:12px;';
          el.debugResult.appendChild(hint);
          el.debugResult.appendChild(area);
          area.focus();
          area.select();
        }
      } else if (copied) {
        showToast('诊断数据已复制', 'info');
      }
    } catch (e) {
      showToast('读取诊断数据失败：' + describeError(e), 'error');
    } finally {
      el.copyDebugBtn.disabled = false;
      el.copyDebugBtn.textContent = '复制诊断数据';
    }
  }

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 实验报告检查
  // ---------------------------------------------------------------------------

  function stopReportCheckPolling() {
    state.reportCheckPolling = false;
    if (state.reportCheckTimer) {
      window.clearTimeout(state.reportCheckTimer);
      state.reportCheckTimer = 0;
    }
  }

  function formatBytes(n) {
    const value = Number(n) || 0;
    if (value <= 0) return '';
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / 1024 / 1024).toFixed(1) + ' MB';
  }

  function verdictOf(result) {
    if (result && result.level === 'bad') return { text: '疑似有问题', cls: 'bad' };
    if (result && result.level === 'warn') return { text: '需人工确认', cls: 'warn' };
    if (result && result.level === 'ok') return { text: '正常', cls: 'ok' };
    return { text: '无法判断', cls: 'unknown' };
  }

  /**
   * 打开报告检查结果对应的实验报告页面。
   * 优先用检查时实际访问过的电脑版详情页（viewUrl）——它已通过 courseId 校验，
   * 能确保打开的就是这门课的这个作业，不会被作业 id 串号带到别的课程；
   * 没有 viewUrl 时退回条目原始链接（会走手机详情页 → 电脑版作答页的解析流程）。
   * 注意：设置页不关闭，与弹窗里的 openItem 不同。
   */
  async function openReportTarget(result) {
    const url = (result && (result.viewUrl || result.url)) || '';
    if (!url) {
      showToast('该报告没有可打开的链接', 'warn');
      return;
    }
    showToast('正在打开实验报告页…', 'info');

    const res = unwrapResponse(await sendMessage({ type: 'OPEN_URL', url: url }, 15000));
    if (res.ok) return;
    // 后台仍在解析时标签页已经可见，不要再开一个
    if (res.error === 'timeout') return;

    try {
      if (chrome.tabs && typeof chrome.tabs.create === 'function') {
        const created = chrome.tabs.create({ url: url, active: true });
        if (created && typeof created.then === 'function') await created;
        return;
      }
    } catch (err) {
      // 继续尝试 window.open
    }

    try {
      const opened = window.open(url, '_blank', 'noopener');
      if (opened) {
        opened.opener = null;
        return;
      }
      showToast('无法打开页面：' + describeError(res.error), 'bad');
    } catch (err) {
      showToast('无法打开页面：' + describeError(res.error), 'bad');
    }
  }

  function renderReportCheck(data) {
    const value = data && typeof data === 'object' ? data : {};
    const running = value.running === true;
    el.checkReportsBtn.disabled = running;
    el.checkReportsBtn.textContent = running ? '检查中…' : '开始检查';

    const total = Number(value.total) || 0;
    const done = Number(value.done) || 0;
    const parts = [];
    if (value.message) parts.push(value.message);
    if (running && total > 0) parts.push(done + '/' + total);
    if (value.error) parts.push('错误：' + describeError(value.error));
    el.reportCheckStatus.textContent = parts.join(' · ');

    el.reportCheckResults.replaceChildren();
    const results = Array.isArray(value.results) ? value.results : [];
    for (const result of results) {
      const verdict = verdictOf(result);
      const li = document.createElement('li');
      li.className = 'report-item report-item--' + verdict.cls;

      const head = document.createElement('div');
      head.className = 'report-item-head';
      const title = document.createElement('span');
      title.className = 'report-item-title';
      title.textContent =
        (result.course ? result.course + ' · ' : '') + (result.title || '（无标题）');
      const badge = document.createElement('span');
      badge.className = 'report-verdict report-verdict--' + verdict.cls;
      badge.textContent = verdict.text;
      head.appendChild(title);
      head.appendChild(badge);

      // v1.2.20：整个头部可点击跳转到该实验报告的提交/详情页，
      // 便于人工核对「报告内容 vs 作业标题」是否对得上。
      const targetUrl = result.viewUrl || result.url || '';
      if (targetUrl) {
        head.classList.add('report-item-head--link');
        head.setAttribute('role', 'button');
        head.setAttribute('tabindex', '0');
        head.title = '在浏览器中打开该实验报告页面';
        const go = (event) => {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          openReportTarget(result);
        };
        head.addEventListener('click', go);
        head.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') go(event);
        });
        const openIcon = document.createElement('span');
        openIcon.className = 'report-item-open';
        openIcon.textContent = '打开 ↗';
        head.appendChild(openIcon);
      }
      li.appendChild(head);

      const meta = document.createElement('p');
      meta.className = 'report-item-meta';
      const metaParts = [];
      if (result.status) metaParts.push('状态：' + result.status);
      if (Array.isArray(result.attachments) && result.attachments.length) {
        // 只列出你提交的附件；题目区的教师材料单独说明，避免看起来像"交了模板"
        const mine = result.attachments.filter((a) => a.zone !== 'question');
        const teachers = result.attachments.filter((a) => a.zone === 'question');
        if (mine.length) {
          metaParts.push(
            '附件：' +
              mine
                .map((a) => {
                  const size = formatBytes(a.size);
                  const kind = a.kind ? a.kind.toUpperCase() : a.type ? a.type.toUpperCase() : '';
                  const textInfo =
                    typeof a.textLen === 'number' && a.textLen > 0
                      ? '，正文 ' + a.textLen + ' 字'
                      : '';
                  return (
                    (a.name || '未命名') +
                    (kind
                      ? '（' + kind + (size ? ' ' + size : '') + textInfo + '）'
                      : size
                        ? '（' + size + '）'
                        : '')
                  );
                })
                .join('；')
          );
        }
        if (teachers.length) {
          metaParts.push(
            '题目区材料（不检查）：' + teachers.map((a) => a.name || '未命名').join('、')
          );
        }
        if (!mine.length && !teachers.length) metaParts.push('附件：无');
      } else {
        metaParts.push('附件：无');
      }
      if (typeof result.textAnswerLen === 'number') {
        metaParts.push('文本答案：' + result.textAnswerLen + ' 字');
      }
      if (result.analysis && typeof result.analysis.textLen === 'number') {
        metaParts.push('文档文本：' + result.analysis.textLen + ' 字');
      }
      // v1.2.20：把报告里写的实验名称也列出来，不点开页面就能先对比标题
      if (result.analysis && result.analysis.reportTitle) {
        metaParts.push('报告实验名称：' + result.analysis.reportTitle);
      }
      // v1.2.24：模板核对结果。模板是判断"交对没有"的可靠依据，
      // 把"对上了几栏"直接摆出来，比只看标题相似度让人放心。
      if (result.analysis && result.analysis.template && result.analysis.template.usable) {
        const t = result.analysis.template;
        metaParts.push(`模板核对：${t.covered}/${t.total} 栏`);
      } else if (result.templateSkeleton && Array.isArray(result.templateSkeleton.headings)) {
        metaParts.push('教师模板：已找到但未识别栏目');
      }
      meta.textContent = metaParts.join(' · ');
      li.appendChild(meta);

      // 模板骨架详情（默认收起）：既能看到模板长什么样，也能核对栏目差异
      if (result.templateSkeleton && Array.isArray(result.templateSkeleton.headings) && result.templateSkeleton.headings.length) {
        const tpl = document.createElement('details');
        tpl.className = 'report-item-diag';
        const tplSummary = document.createElement('summary');
        const preset = result.templateSkeleton.presetTitle;
        tplSummary.textContent =
          '教师模板栏目（' + result.templateSkeleton.headings.length + '）' + (preset ? ' · 预填标题：' + preset : '');
        tpl.appendChild(tplSummary);
        const tplList = document.createElement('ul');
        tplList.className = 'report-item-reasons';
        const tplMatch = result.analysis && result.analysis.template;
        const missing = new Set((tplMatch && Array.isArray(tplMatch.missing) ? tplMatch.missing : []));
        for (const h of result.templateSkeleton.headings) {
          const item = document.createElement('li');
          // 标出你报告里缺的那几栏，一眼看出结构差异在哪
          item.textContent = h + (missing.has(h) ? '（你的报告里没找到）' : '');
          tplList.appendChild(item);
        }
        tpl.appendChild(tplList);
        li.appendChild(tpl);
      }

      if (Array.isArray(result.reasons) && result.reasons.length) {
        const ul = document.createElement('ul');
        ul.className = 'report-item-reasons';
        for (const reason of result.reasons) {
          const entry = document.createElement('li');
          entry.textContent = reason;
          ul.appendChild(entry);
        }
        li.appendChild(ul);
      }

      // 附件解析失败的技术细节（便于排查，默认收起在 hint 里）
      if (result.hint) {
        const hint = document.createElement('p');
        hint.className = 'report-item-hint';
        hint.textContent = result.hint;
        li.appendChild(hint);
      }
      if (Array.isArray(result.diagnostics) && result.diagnostics.length) {
        const diag = document.createElement('details');
        diag.className = 'report-item-diag';
        const summary = document.createElement('summary');
        summary.textContent = '技术细节（' + result.diagnostics.length + '）';
        diag.appendChild(summary);
        for (const d of result.diagnostics) {
          const p = document.createElement('p');
          p.textContent = [d.step, d.objectid || '', d.url || '', d.error || '']
            .filter(Boolean)
            .join(' | ');
          diag.appendChild(p);
        }
        li.appendChild(diag);
      }

      // 页面结构诊断（v1.2.22）
      //
      // 当"没找到你提交的附件"时，需要知道页面到底长什么样：
      // 作答区是不是在 iframe 里、选择器有没有命中。
      // 这段信息只用于排查，默认收起。
      if (result.pageDebug && typeof result.pageDebug === 'object') {
        const dbg = result.pageDebug;
        const box = document.createElement('details');
        box.className = 'report-item-diag';
        const summary = document.createElement('summary');
        summary.textContent = '页面结构诊断';
        box.appendChild(summary);

        const add = (text) => {
          if (!text) return;
          const p = document.createElement('p');
          p.textContent = text;
          box.appendChild(p);
        };

        const scan = dbg.iframeScan;
        if (scan && typeof scan === 'object') {
          add(
            `iframe：共 ${Number(scan.total) || 0} 个，同源 ${Number(scan.sameOrigin) || 0}，` +
              `跨域 ${Number(scan.crossOrigin) || 0}，从中补采到 ${Number(scan.found) || 0} 个附件`
          );
        } else if (Number(dbg.totalIframes)) {
          add(`iframe：共 ${Number(dbg.totalIframes)} 个`);
        }

        if (dbg.answerSels && typeof dbg.answerSels === 'object') {
          const PARTS = [
            ['markAnswer', '.mark_answer'],
            ['stuAnswerContent', 'dd.stuAnswerContent'],
            ['textwrap', 'dd.textwrap'],
            ['markItem', '.mark_item'],
            ['TiMu', '.TiMu'],
            ['ansAttachOnline', '.ans-attach-online'],
          ];
          const line = PARTS.map(([k, label]) => `${label}×${Number(dbg.answerSels[k]) || 0}`).join(
            '，'
          );
          add('作答区选择器：' + line);
        }

        if (Array.isArray(dbg.iframeSrcs) && dbg.iframeSrcs.length) {
          for (const src of dbg.iframeSrcs.slice(0, 5)) {
            add('iframe 地址：' + String(src).slice(0, 100));
          }
        }

        li.appendChild(box);
      }
      el.reportCheckResults.appendChild(li);
    }
  }

  async function loadReportCheckState() {
    stopReportCheckPolling();
    const res = unwrapResponse(await sendMessage({ type: 'GET_REPORT_CHECK' }, GET_TIMEOUT_MS));
    if (!res.ok) {
      el.reportCheckStatus.textContent = '无法读取检查状态：' + describeError(res.error);
      return;
    }
    const data = res.data || {};
    renderReportCheck(data);
    if (data.running) {
      state.reportCheckPolling = true;
      state.reportCheckTimer = window.setTimeout(pollReportCheck, REPORT_CHECK_POLL_MS);
    }
  }

  async function pollReportCheck() {
    state.reportCheckTimer = 0;
    if (!state.reportCheckPolling) return;
    const res = unwrapResponse(await sendMessage({ type: 'GET_REPORT_CHECK' }, GET_TIMEOUT_MS));
    if (!res.ok) {
      stopReportCheckPolling();
      el.reportCheckStatus.textContent = '读取检查进度失败：' + describeError(res.error);
      el.checkReportsBtn.disabled = false;
      el.checkReportsBtn.textContent = '开始检查';
      return;
    }
    const data = res.data || {};
    renderReportCheck(data);
    if (data.running) {
      state.reportCheckTimer = window.setTimeout(pollReportCheck, REPORT_CHECK_POLL_MS);
    } else {
      stopReportCheckPolling();
    }
  }

  async function startReportCheck() {
    if (state.reportCheckPolling) return;
    el.checkReportsBtn.disabled = true;
    el.checkReportsBtn.textContent = '检查中…';
    el.reportCheckStatus.textContent = '正在启动检查…';

    const res = unwrapResponse(
      await sendMessage(
        {
          type: 'CHECK_REPORTS',
          options: {
            includePastDeadline: Boolean(el.reportCheckIncludePast && el.reportCheckIncludePast.checked)
          }
        },
        REPORT_CHECK_TIMEOUT_MS
      )
    );
    if (!res.ok) {
      el.checkReportsBtn.disabled = false;
      el.checkReportsBtn.textContent = '开始检查';
      el.reportCheckStatus.textContent = '无法开始检查：' + describeError(res.error);
      return;
    }
    state.reportCheckPolling = true;
    state.reportCheckTimer = window.setTimeout(pollReportCheck, 800);
  }

  function bindEvents() {
    el.form.addEventListener('submit', function (event) {
      event.preventDefault();
      saveConfig({ silent: false });
    });

    el.testEmailBtn.addEventListener('click', testEmail);
    el.clearItemsBtn.addEventListener('click', clearItems);
    el.resetDefaultsBtn.addEventListener('click', resetDefaults);
    el.copyDebugBtn.addEventListener('click', copyDebugData);
    el.checkReportsBtn.addEventListener('click', startReportCheck);
    el.reloadConfigBtn.addEventListener('click', loadConfig);

    el.scheduleUploadBtn.addEventListener('click', function () {
      if (el.scheduleFileInput) el.scheduleFileInput.click();
    });
    el.scheduleFileInput.addEventListener('change', onScheduleFileChange);
    el.scheduleCandidates.addEventListener('click', handleScheduleCandidateClick);
    el.scheduleSelectAllBtn.addEventListener('click', selectAllCandidates);
    el.scheduleSelectNoneBtn.addEventListener('click', selectNoneCandidates);
    el.scheduleAddManualBtn.addEventListener('click', addManualCourses);
    el.scheduleManualInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        addManualCourses();
      }
    });
    // 输入框失焦时自动添加，避免"输入了但没点添加就保存"导致课程丢失
    el.scheduleManualInput.addEventListener('blur', function () {
      if (el.scheduleManualInput.value.trim()) addManualCourses(true);
    });
    el.scheduleClearBtn.addEventListener('click', clearScheduleCourses);

    el.form.addEventListener('input', handleFieldInput);
    el.form.addEventListener('change', handleFieldInput);

    window.addEventListener('pagehide', function () {
      window.clearTimeout(state.toastTimer);
      stopReportCheckPolling();
    });
  }

  function init() {
    cacheElements();
    bindEvents();
    state.config = mergeConfig(DEFAULT_CONFIG, {});
    fillForm(state.config);
    fillVersions(null);
    loadConfig();
    loadReportCheckState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
