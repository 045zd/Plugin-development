/**
 * 学习通截止提醒 — service worker 入口。
 *
 * 职责：
 * - 定时扫描（chrome.alarms）；
 * - 消息路由（popup / options）；
 * - 通知与邮件提醒；
 * - 登录失效告警。
 */

import { ALARM_SCAN, ERR } from './config.js';
import {
  getConfig,
  saveConfig,
  getItems,
  setItems,
  getScanMeta,
  setScanMeta,
  getNotified,
  setNotified,
  getScanState,
  setScanState,
  clearItems,
} from './storage.js';
import { scanChaoxing, disposeProbeTab } from './chaoxing.js';
import { openUrlInTab } from './open-tab.js';
import { runReportCheck } from './report-check.js';
import { filterItemsBySchedule } from './course-filter.js';
import {
  computeAlerts,
  notifyBrowser,
  handleNotificationClick,
  sendMail,
  sendHeartbeat,
  healthCheck,
  buildDigestMail,
  buildAuthMail,
  humanRemain,
} from './notifier.js';

const SCAN_DEADLOCK_MS = 10 * 60 * 1000; // 扫描卡死判定
const AUTH_MAIL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 登录失效邮件节流
const AUTH_NOTIFY_INTERVAL_MS = 60 * 60 * 1000; // 登录失效通知节流
const INITIAL_SCAN_DELAY_MS = 8 * 1000;

/** 后台代码版本（用于前端检测后台是否真的更新了）。 */
const SW_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
})();

let scanning = false;
let lastProgress = null;
let reportChecking = false;
let lastReportSkipMessage = '';
let lastReportSkippedPast = 0;

const REPORT_CHECK_KEY = 'reportCheckState';
const REPORT_CHECK_STALE_MS = 10 * 60 * 1000;

async function getReportCheckState() {
  try {
    const data = await chrome.storage.local.get(REPORT_CHECK_KEY);
    const state = data[REPORT_CHECK_KEY];
    if (!state || typeof state !== 'object') return null;
    if (state.running && Date.now() - (state.startedAt || 0) > REPORT_CHECK_STALE_MS) {
      const next = { ...state, running: false, message: '检查超时', error: 'timeout' };
      await chrome.storage.local.set({ [REPORT_CHECK_KEY]: next });
      return next;
    }
    return state;
  } catch {
    return null;
  }
}

async function patchReportCheckState(patch) {
  const current = (await getReportCheckState()) || {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [REPORT_CHECK_KEY]: next });
  return next;
}

async function startReportCheck(options = {}) {
  if (reportChecking || (await isScanBusy())) {
    return { ok: false, error: 'busy' };
  }
  reportChecking = true;
  lastReportSkipMessage = '';
  lastReportSkippedPast = 0;
  await chrome.storage.local.set({
    [REPORT_CHECK_KEY]: {
      running: true,
      startedAt: Date.now(),
      total: 0,
      done: 0,
      message: '准备检查…',
      results: [],
      error: '',
      includePastDeadline: options.includePastDeadline === true,
    },
  });

  (async () => {
    try {
      const [allItems, config] = await Promise.all([getItems(), getConfig()]);
      // 报告检查必须与主列表保持一致的课表过滤：
      // 否则历史学期（课表外）的课程也会被拉进来检查（用户反馈的"识别了课表以外的实验报告"）。
      const filtered = filterItemsBySchedule(allItems, config);
      const items = filtered.items;
      const results = await runReportCheck(
        items,
        (progress) => {
          if (progress && progress.noCandidate) {
            lastReportSkipMessage = progress.message || '';
          }
          if (progress && typeof progress.skippedPast === 'number') {
            lastReportSkippedPast = progress.skippedPast;
          }
          patchReportCheckState(progress).catch(() => {});
        },
        { includePastDeadline: options.includePastDeadline === true }
      );
      await patchReportCheckState({
        running: false,
        done: results.length,
        total: results.length,
        message:
          results.length === 0 && lastReportSkipMessage
            ? lastReportSkipMessage
            : '检查完成',
        results,
        finishedAt: Date.now(),
        error: '',
        skippedPast: lastReportSkippedPast || 0,
      });
    } catch (e) {
      await patchReportCheckState({
        running: false,
        message: '检查失败',
        error: String(e && e.message ? e.message : e),
      });
    } finally {
      reportChecking = false;
    }
  })();

  return { ok: true, started: true };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function log(...args) {
  console.log('[截止提醒]', ...args);
}

function warn(...args) {
  console.warn('[截止提醒]', ...args);
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function ensureAlarm(config) {
  const interval = config.scanIntervalMinutes;
  const existing = await chrome.alarms.get(ALARM_SCAN);
  if (!existing || existing.periodInMinutes !== interval) {
    await chrome.alarms.create(ALARM_SCAN, {
      periodInMinutes: interval,
      delayInMinutes: Math.min(1, interval),
    });
    log('已设置定时扫描：每', interval, '分钟');
  }
}

async function scheduleInitialScan() {
  await chrome.alarms.create('chaoxing-due-initial', {
    when: Date.now() + INITIAL_SCAN_DELAY_MS,
  });
}

async function onInstalled(details) {
  log('扩展安装/更新', details.reason);
  const config = await getConfig();
  await ensureAlarm(config);
  if (details.reason === 'install') {
    await scheduleInitialScan();
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      /* 忽略 */
    }
  } else {
    await scheduleInitialScan();
  }
}

async function onStartup() {
  log('浏览器启动');
  const config = await getConfig();
  await ensureAlarm(config);
  // 浏览器刚启动，稍后检查一次
  await scheduleInitialScan();
}

chrome.runtime.onInstalled.addListener((details) => {
  onInstalled(details).catch((e) => warn('onInstalled 失败', e));
});

chrome.runtime.onStartup.addListener(() => {
  onStartup().catch((e) => warn('onStartup 失败', e));
});

/* ------------------------------------------------------------------ */
/* 定时器                                                              */
/* ------------------------------------------------------------------ */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'chaoxing-due-initial') {
    chrome.alarms.clear('chaoxing-due-initial').catch(() => {});
    runScan('auto').catch((e) => warn('初始扫描失败', e));
    return;
  }
  if (alarm.name === ALARM_SCAN) {
    runScan('auto').catch((e) => warn('定时扫描失败', e));
  }
});

/* ------------------------------------------------------------------ */
/* 通知点击                                                            */
/* ------------------------------------------------------------------ */

chrome.notifications.onClicked.addListener((notificationId) => {
  getConfig()
    .then((config) =>
      handleNotificationClick(notificationId, {
        openAiChat: config.dxAiChatAutoOpen === true,
      })
    )
    .catch((e) => warn('处理通知点击失败', e));
});

/* ------------------------------------------------------------------ */
/* 扫描主流程                                                          */
/* ------------------------------------------------------------------ */

async function isScanBusy() {
  if (scanning) return true;
  try {
    const state = await getScanState();
    if (state && state.startedAt) {
      if (Date.now() - state.startedAt < SCAN_DEADLOCK_MS) return true;
      warn('发现残留扫描状态，已清理');
      await setScanState(null);
    }
  } catch {
    /* 忽略 */
  }
  return false;
}

/**
 * 执行一次扫描并处理提醒。
 * @param {'auto'|'manual'} source
 * @returns {Promise<{started:boolean, error?:string, result?:object}>}
 */
async function runScan(source) {
  if (await isScanBusy()) {
    log('扫描进行中，跳过本次');
    return { started: false, error: 'already_scanning' };
  }
  if (reportChecking) {
    log('报告检查进行中，跳过本次扫描');
    return { started: false, error: 'report_check_running' };
  }
  scanning = true;
  lastProgress = null;
  const startedAt = Date.now();
  try {
    await setScanState({ startedAt, source, phase: 'starting', message: '开始检查…' });
    const config = await getConfig();

    const progressHandler = (progress) => {
      lastProgress = progress;
      setScanState({ startedAt, source, phase: progress.phase, message: progress.message })
        .catch(() => {});
    };

    log('开始扫描', source);
    const result = await scanChaoxing(config, progressHandler);
    const now = Date.now();

    // 保存最近一次采集的原始解析数据，供设置页「复制诊断数据」排查问题
    if (result.debug) {
      try {
        await chrome.storage.local.set({ debugRaw: result.debug });
      } catch {
        /* 忽略 */
      }
    }

    if (result.loggedIn === false || result.error === ERR.AUTH_REQUIRED) {
      await setScanMeta({
        lastScanAt: now,
        lastScanOk: false,
        lastError: ERR.AUTH_REQUIRED,
        loggedIn: false,
        source,
      });
      await handleAuthFailure(config);
      return { started: true, result: { ok: false, loggedIn: false, error: ERR.AUTH_REQUIRED } };
    }

    if (!result.ok) {
      // 网络/解析失败：保留上一次结果，不清空
      await setScanMeta({
        lastScanAt: now,
        lastScanOk: false,
        lastError: result.error || ERR.UNKNOWN,
        loggedIn: result.loggedIn,
        source,
      });
      log('扫描失败', result.error);
      return { started: true, result: { ok: false, error: result.error } };
    }

    const rawItems = Array.isArray(result.items) ? result.items : [];
    // 课表过滤：只保留课表里出现过的课程的作业/考试
    const filtered = filterItemsBySchedule(rawItems, config);
    const items = filtered.items;
    const notified = await getNotified();
    const { alerts, notified: nextNotified } = computeAlerts(items, config, now, notified);

    await setItems(items);
    await setNotified(nextNotified);
    await setScanMeta({
      lastScanAt: now,
      lastScanOk: true,
      lastError: '',
      loggedIn: true,
      scannedCourses: result.courses,
      scannedItems: items.length,
      rawItems: rawItems.length,
      filteredItems: filtered.filteredCount,
      failedCourses: result.failedCourses || 0,
      scanMode: result.source || '',
      source,
    });

    // 浏览器通知
    if (config.browserNotifications) {
      for (const alert of alerts) {
        await notifyBrowser(alert);
      }
    }

    // 汇总邮件
    if (config.emailEnabled && alerts.length) {
      const mail = buildDigestMail(alerts, now);
      const res = await sendMail(config, mail.subject, mail.text, mail.html);
      if (!res.ok) {
        warn('提醒邮件发送失败', res.error);
        await setScanMeta({ lastEmailError: res.error });
      } else {
        await setScanMeta({ lastEmailError: '' });
      }
    }

    // 心跳
    if (config.emailEnabled) {
      await sendHeartbeat(config, {
        source: 'extension',
        loggedIn: true,
        pending: alerts.length,
        items: items.length,
      });
    }

    log(
      '扫描完成：课程',
      result.courses,
      '条目',
      items.length,
      filtered.filteredCount ? `（课表过滤掉 ${filtered.filteredCount} 条）` : '',
      '提醒',
      alerts.length,
      result.failedCourses ? `部分失败 ${result.failedCourses}` : ''
    );
    return {
      started: true,
      result: { ok: true, items: items.length, alerts: alerts.length },
    };
  } catch (e) {
    warn('扫描异常', e);
    try {
      await setScanMeta({
        lastScanAt: Date.now(),
        lastScanOk: false,
        lastError: String(e && e.message ? e.message : e),
        source,
      });
    } catch {
      /* ignore */
    }
    return { started: true, result: { ok: false, error: ERR.UNKNOWN } };
  } finally {
    scanning = false;
    await setScanState(null).catch(() => {});
    // 关闭后台采集标签页，避免在用户标签栏留下一个"学习通"标签
    await disposeProbeTab().catch(() => {});
  }
}

/** 登录失效处理：通知 + 节流邮件。 */
async function handleAuthFailure(config) {
  const now = Date.now();
  try {
    const data = await chrome.storage.local.get(['authNotifyAt', 'authMailAt']);
    const lastNotify = data.authNotifyAt || 0;
    const lastMail = data.authMailAt || 0;

    if (config.browserNotifications && now - lastNotify > AUTH_NOTIFY_INTERVAL_MS) {
      await chrome.storage.local.set({ authNotifyAt: now });
      try {
        await chrome.notifications.create('chaoxing-auth-required', {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
          title: '学习通登录已失效',
          message: '截止提醒暂时无法检查作业/考试，请打开学习通网页版重新登录。',
          priority: 2,
        });
      } catch (e) {
        warn('登录失效通知失败', e);
      }
    }

    if (config.emailEnabled && now - lastMail > AUTH_MAIL_INTERVAL_MS) {
      const mail = buildAuthMail('扩展检测到网页会话已失效');
      const res = await sendMail(config, mail.subject, mail.text, mail.html);
      if (res.ok) {
        await chrome.storage.local.set({ authMailAt: now });
        await setScanMeta({ lastEmailError: '' });
      } else {
        warn('登录失效邮件发送失败', res.error);
        await setScanMeta({ lastEmailError: res.error });
      }
    }
  } catch (e) {
    warn('登录失效处理异常', e);
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

async function buildState() {
  const [config, items, scanMeta] = await Promise.all([
    getConfig(),
    getItems(),
    getScanMeta(),
  ]);
  const busy = scanning || (await isScanBusy());
  let progress = lastProgress;
  if (busy) {
    try {
      const state = await getScanState();
      if (state && state.message) {
        progress = { phase: state.phase, message: state.message };
      }
    } catch {
      /* 忽略 */
    }
  }
  return { config, items, scanMeta, scanning: busy, progress, runtimeVersion: SW_VERSION };
}

async function testEmail() {
  const config = await getConfig();
  const health = await healthCheck(config);
  if (!health.ok) {
    return { ok: false, error: health.error || 'proxy_unreachable' };
  }
  if (health.data && health.data.mailConfigured === false) {
    return { ok: false, error: 'mail_not_configured' };
  }
  const now = Date.now();
  const subject = '【测试】学习通截止提醒邮件配置成功';
  const text =
    '这是一封测试邮件。\n\n收到它说明扩展已经能通过本地代理发送邮件。\n生成时间：' +
    new Date(now).toLocaleString('zh-CN');
  const html = `<!DOCTYPE html><html lang="zh-CN"><body style="font-family:system-ui,'Microsoft YaHei',sans-serif;padding:24px;">
  <h2 style="color:#3b6cf6;margin:0 0 12px;">邮件配置成功</h2>
  <p>这是一封测试邮件。收到它说明「学习通截止提醒」扩展已经能通过本地代理发送邮件。</p>
  <p style="color:#6b7280;font-size:13px;">生成时间：${new Date(now).toLocaleString('zh-CN')}</p>
</body></html>`;
  const res = await sendMail(config, subject, text, html);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

async function handleMessage(message) {
  const type = message && message.type;
  switch (type) {
    case 'GET_STATE':
      return await buildState();
    case 'SAVE_CONFIG': {
      const saved = await saveConfig(message.config || {});
      await ensureAlarm(saved);
      return { ok: true, config: saved };
    }
    case 'SCAN_NOW': {
      // 不等待扫描完成，立即返回
      runScan('manual').catch((e) => warn('手动扫描失败', e));
      await new Promise((r) => setTimeout(r, 50));
      const busyNow = await isScanBusy();
      return { started: busyNow, error: busyNow ? undefined : 'scan_not_started' };
    }
    case 'OPEN_URL': {
      // 由后台创建标签页：弹窗在点击后可能立即关闭，交给后台更可靠
      let parsed = null;
      try {
        parsed = new URL(String(message.url || ''));
      } catch {
        return { ok: false, error: 'invalid_url' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'invalid_url' };
      }
      // 等待解析完成再回应，保证 service worker 不会被提前回收
      const config = await getConfig();
      const opened = await openUrlInTab(parsed.href, {
        openAiChat: config.dxAiChatAutoOpen === true,
      });
      return opened.ok ? { ok: true } : { ok: false, error: opened.error || 'open_failed' };
    }
    case 'CHECK_REPORTS':
      return await startReportCheck(message.options || {});
    case 'GET_REPORT_CHECK': {
      const state = await getReportCheckState();
      return state || { running: false, results: [], message: '', error: '' };
    }
    case 'TEST_EMAIL':
      return await testEmail();
    case 'CLEAR_ITEMS':
      await clearItems();
      return { ok: true };
    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, error: 'unknown_message_type: ' + String(type) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((data) => {
      // 统一包一层：data 可能是 {ok:...} 也可能是数据对象
      if (data && typeof data === 'object' && 'ok' in data) {
        sendResponse(data);
      } else {
        sendResponse({ ok: true, data });
      }
    })
    .catch((e) => {
      warn('消息处理失败', message && message.type, e);
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    });
  return true;
});

/* ------------------------------------------------------------------ */
/* 启动自检                                                            */
/* ------------------------------------------------------------------ */

(async () => {
  try {
    const config = await getConfig();
    await ensureAlarm(config);
    // 记录后台版本，便于排查"前台已更新但后台仍是旧代码"的情况
    try {
      await chrome.storage.local.set({
        swInfo: { version: SW_VERSION, startedAt: Date.now() },
      });
    } catch {
      /* 忽略 */
    }
  } catch (e) {
    warn('初始化失败', e);
  }
})();

export { runScan };
