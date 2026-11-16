/**
 * 提醒模块：截止判断、浏览器通知、邮件发送、心跳。
 */

import { PENDING_STATUSES, DONE_STATUSES } from './config.js';
import { openUrlInTab } from './open-tab.js';

const NOTIF_TARGETS_KEY = 'notifTargets';

/** 条目缺少具体链接时的兜底列表页，保证点击通知始终有页面可打开。 */
const WORK_LIST_URL = 'https://mooc1-api.chaoxing.com/work/stu-work';
const EXAM_LIST_URL = 'https://mooc1-api.chaoxing.com/exam-ans/exam/phone/examcode';

function itemTargetUrl(item) {
  if (item && typeof item.url === 'string' && item.url) return item.url;
  return item && item.type === 'exam' ? EXAM_LIST_URL : WORK_LIST_URL;
}

/* ------------------------------------------------------------------ */
/* 截止判断与提醒去重                                                   */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} DueAlert
 * @property {object} item
 * @property {'threshold'|'expired'} kind
 * @property {number} threshold 命中的阈值（小时）；expired 为 0
 * @property {number|null} hoursLeft
 */

export function isPendingItem(item) {
  if (!item) return false;
  const status = String(item.status || '').trim();
  if (DONE_STATUSES.has(status)) return false;
  return PENDING_STATUSES.has(status);
}

/**
 * 计算本次扫描需要提醒的条目，并返回更新后的去重表。
 * @param {Array} items
 * @param {object} config
 * @param {number} now epoch ms
 * @param {Record<string, number[]>} notified 已提醒表
 * @returns {{alerts: DueAlert[], notified: Record<string, number[]>}}
 */
export function computeAlerts(items, config, now, notified) {
  const next = {};
  // 只保留仍出现在本次结果里的 key，避免无限增长
  const currentKeys = new Set();
  for (const item of items || []) {
    if (item && item.key) currentKeys.add(item.key);
  }
  for (const [key, thresholds] of Object.entries(notified || {})) {
    if (currentKeys.has(key)) {
      next[key] = Array.isArray(thresholds) ? [...thresholds] : [];
    }
  }

  const thresholds = (config.reminderHours || [])
    .map(Number)
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b); // 升序 [1, 6, 24, 72]

  const alerts = [];
  for (const item of items || []) {
    if (!isPendingItem(item)) continue;
    if (item.deadline == null || !Number.isFinite(item.deadline)) continue;

    const hoursLeft = (item.deadline - now) / 3600000;
    const hit = next[item.key] || [];

    if (hoursLeft > 0) {
      const candidates = thresholds.filter(
        (h) => hoursLeft <= h && !hit.includes(h)
      );
      if (candidates.length) {
        const threshold = Math.min(...candidates);
        alerts.push({ item, kind: 'threshold', threshold, hoursLeft });
        // 比它更宽松的阈值已经错过，一并标记，避免重复提醒
        for (const h of thresholds) {
          if (h >= threshold && !hit.includes(h)) hit.push(h);
        }
      }
    } else if (config.expiredAlert && !hit.includes(0)) {
      alerts.push({ item, kind: 'expired', threshold: 0, hoursLeft });
      hit.push(0);
    }

    if (hit.length) next[item.key] = hit;
  }

  return { alerts, notified: next };
}

/** 剩余时间的可读文本。 */
export function humanRemain(hoursLeft) {
  if (hoursLeft == null) return '';
  if (hoursLeft <= 0) return '已过期';
  const totalMinutes = Math.round(hoursLeft * 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天${hours > 0 ? hours + '小时' : ''}`;
  if (hours > 0) return `${hours}小时${minutes > 0 ? minutes + '分钟' : ''}`;
  return `${Math.max(1, minutes)}分钟`;
}

/** 条目的简短描述（通知/邮件共用）。 */
export function itemSummary(item) {
  const typeLabel = item.type === 'exam' ? '考试' : '作业';
  const status = item.status && item.status !== '未知' ? `（${item.status}）` : '';
  return `${item.course} · ${item.title}${status}`;
}

/* ------------------------------------------------------------------ */
/* 浏览器通知                                                          */
/* ------------------------------------------------------------------ */

/** 生成短通知 id（避免过长）。 */
function notificationIdFor(alert, index) {
  const item = alert.item || {};
  const base = `${item.type || 'x'}:${item.course || ''}:${item.title || ''}`;
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) {
    hash = (hash * 31 + base.charCodeAt(i)) | 0;
  }
  return `due_${alert.threshold}_${Math.abs(hash)}_${index}`;
}

/**
 * 发送一条浏览器通知，并记录点击目标。
 * @returns {Promise<boolean>}
 */
export async function notifyBrowser(alert) {
  const item = alert.item;
  const typeLabel = item.type === 'exam' ? '考试' : '作业';
  const remain = alert.kind === 'expired' ? '已过期' : humanRemain(alert.hoursLeft);
  const title =
    alert.kind === 'expired'
      ? `【已过期】${typeLabel}：${item.title}`
      : `【还剩${remain}】${typeLabel}即将截止`;
  const message = [
    itemSummary(item),
    item.deadlineText ? `截止：${item.deadlineText}` : '',
    '点此打开学习通查看',
  ]
    .filter(Boolean)
    .join('\n');

  const id = notificationIdFor(alert, Date.now() % 1000);

  try {
    const targets = await chrome.storage.session.get(NOTIF_TARGETS_KEY);
    const map = Object.assign({}, targets[NOTIF_TARGETS_KEY] || {});
    map[id] = itemTargetUrl(item);
    await chrome.storage.session.set({ [NOTIF_TARGETS_KEY]: map });
  } catch {
    /* 忽略 */
  }

  const iconUrl = chrome.runtime.getURL
    ? chrome.runtime.getURL('assets/icons/icon128.png')
    : 'assets/icons/icon128.png';

  return new Promise((resolve) => {
    try {
      chrome.notifications.create(
        id,
        {
          type: 'basic',
          iconUrl,
          title,
          message,
          priority: 2,
          requireInteraction: false,
        },
        (createdId) => {
          resolve(Boolean(createdId));
        }
      );
    } catch (e) {
      console.warn('[截止提醒] 通知创建失败', e);
      resolve(false);
    }
  });
}

/**
 * 通知点击时打开对应页面。
 * @param {string} notificationId
 * @param {{openAiChat?:boolean}} [options]
 */
export async function handleNotificationClick(notificationId, options = {}) {
  let url = '';
  try {
    const targets = await chrome.storage.session.get(NOTIF_TARGETS_KEY);
    url = (targets[NOTIF_TARGETS_KEY] || {})[notificationId] || '';
  } catch {
    /* 忽略 */
  }
  if (url) {
    try {
      await openUrlInTab(url, options);
    } catch (e) {
      console.warn('[截止提醒] 打开页面失败', e);
    }
  }
  try {
    await chrome.notifications.clear(notificationId);
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 邮件（经本地 SMTP 代理）                                            */
/* ------------------------------------------------------------------ */

const MAIL_TIMEOUT = 12000;

function trimTrailingSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 调用本地邮件代理。
 * @param {object} config
 * @param {'/send'|'/heartbeat'|'/health'} path
 * @param {object|null} body
 */
async function callProxy(config, path, body) {
  const base = trimTrailingSlash(config.mailProxyUrl);
  if (!base) return { ok: false, error: 'proxy_not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT);
  try {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        error: (data && data.error) || `http_${res.status}`,
      };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'bad_response' };
    }
    return data.ok === false
      ? { ok: false, error: data.error || 'proxy_error' }
      : { ok: true, data };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? 'proxy_timeout' : 'proxy_unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 发送一封邮件。 */
export async function sendMail(config, subject, text, html) {
  return callProxy(config, '/send', { subject, text, html });
}

/** 发送扩展心跳（供代理判断插件是否还在运行）。 */
export async function sendHeartbeat(config, payload) {
  return callProxy(config, '/heartbeat', payload);
}

/** 测试代理连通性与邮件配置。 */
export async function healthCheck(config) {
  return callProxy(config, '/health', null);
}

/** 生成汇总邮件（HTML + 纯文本）。 */
export function buildDigestMail(alerts, now) {
  const items = alerts.map((a) => a.item);
  const typeCount = (t) => items.filter((i) => i.type === t).length;
  const subject =
    `【学习通提醒】${items.length} 项作业/考试即将截止` +
    (typeCount('assignment') ? `（作业${typeCount('assignment')}）` : '') +
    (typeCount('exam') ? `（考试${typeCount('exam')}）` : '');

  const rowsHtml = alerts
    .map((a) => {
      const item = a.item;
      const typeLabel = item.type === 'exam' ? '考试' : '作业';
      const remain = a.kind === 'expired' ? '已过期' : humanRemain(a.hoursLeft);
      const color = a.kind === 'expired' ? '#e5484d' : '#d97706';
      const safe = (s) =>
        String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      return `<tr>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;">${safe(item.course)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;">${typeLabel}：${safe(item.title)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;color:${color};font-weight:600;">${safe(remain)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#666;">${safe(item.deadlineText)}</td>
</tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><body style="margin:0;padding:24px;background:#f5f7fb;font-family:system-ui,'Microsoft YaHei',sans-serif;color:#1f2937;">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#3b6cf6;color:#fff;padding:18px 22px;font-size:18px;font-weight:700;">学习通截止提醒</div>
    <div style="padding:20px 22px;">
      <p style="margin:0 0 14px;">以下 ${items.length} 项作业/考试即将截止，请及时处理（此邮件由你的本机代理发送，仅提醒，不自动答题）：</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead><tr style="background:#f3f4f6;text-align:left;">
          <th style="padding:8px 10px;">课程</th><th style="padding:8px 10px;">项目</th>
          <th style="padding:8px 10px;">剩余</th><th style="padding:8px 10px;">截止时间</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p style="margin:18px 0 0;color:#6b7280;font-size:13px;">生成时间：${new Date(now).toLocaleString('zh-CN')}</p>
    </div>
  </div>
</body></html>`;

  const text = alerts
    .map((a) => {
      const item = a.item;
      const typeLabel = item.type === 'exam' ? '考试' : '作业';
      const remain = a.kind === 'expired' ? '已过期' : humanRemain(a.hoursLeft);
      return `- [${typeLabel}] ${item.course} · ${item.title} | 剩余：${remain} | 截止：${item.deadlineText}`;
    })
    .join('\n');

  return { subject, text: '学习通截止提醒\n\n' + text, html };
}

/** 生成登录失效提醒邮件。 */
export function buildAuthMail(detail) {
  const subject = '【学习通提醒】登录状态已失效，请重新登录';
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><body style="margin:0;padding:24px;background:#f5f7fb;font-family:system-ui,'Microsoft YaHei',sans-serif;color:#1f2937;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:22px;border:1px solid #e5e7eb;">
    <h2 style="margin:0 0 12px;font-size:18px;color:#e5484d;">学习通登录已失效</h2>
    <p style="margin:0 0 10px;">截止提醒扩展检测到你的学习通网页会话已失效，暂时无法检查作业与考试截止时间。</p>
    <p style="margin:0 0 10px;">请打开 Edge 重新登录学习通网页版：</p>
    <p style="margin:0 0 14px;"><a href="https://passport2.chaoxing.com/login" style="color:#3b6cf6;">https://passport2.chaoxing.com/login</a></p>
    ${detail ? `<p style="margin:0;color:#6b7280;font-size:13px;">详情：${String(detail).replace(/</g, '&lt;')}</p>` : ''}
  </div>
</body></html>`;
  return {
    subject,
    text:
      '学习通登录已失效，请打开 Edge 重新登录：https://passport2.chaoxing.com/login\n' +
      (detail ? '详情：' + detail + '\n' : ''),
    html,
  };
}
