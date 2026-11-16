/**
 * chrome.storage.local 封装与配置规范化。
 */

import { DEFAULT_CONFIG } from './config.js';
import { normalizeScheduleCourses } from './course-filter.js';

export const STORAGE_KEYS = {
  config: 'config',
  items: 'items',
  scanMeta: 'scanMeta',
  notified: 'notified',
  scanState: 'scanState',
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把任意配置对象规范化成合法配置。 */
export function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };
  const reminderHours = Array.isArray(cfg.reminderHours)
    ? cfg.reminderHours
        .map((h) => Number(h))
        .filter((h) => Number.isFinite(h) && h > 0 && h <= 720)
    : [];
  const unique = [...new Set(reminderHours)].sort((a, b) => b - a);
  return {
    scanIntervalMinutes: clampInt(cfg.scanIntervalMinutes, 15, 720, 60),
    checkAssignments: Boolean(cfg.checkAssignments),
    checkExams: Boolean(cfg.checkExams),
    reminderHours: unique.length ? unique : [...DEFAULT_CONFIG.reminderHours],
    expiredAlert: Boolean(cfg.expiredAlert),
    browserNotifications: Boolean(cfg.browserNotifications),
    emailEnabled: Boolean(cfg.emailEnabled),
    mailProxyUrl: String(cfg.mailProxyUrl || DEFAULT_CONFIG.mailProxyUrl).trim(),
    maxCourses: clampInt(cfg.maxCourses, 1, 50, 15),
    autoFillAccount: Boolean(cfg.autoFillAccount),
    rememberedAccount: String(cfg.rememberedAccount || '').trim().slice(0, 64),
    courseFilterEnabled: Boolean(cfg.courseFilterEnabled),
    scheduleCourses: normalizeScheduleCourses(cfg.scheduleCourses),
    dxAiChatAutoOpen: cfg.dxAiChatAutoOpen !== false,
    showExpiredItems: Boolean(cfg.showExpiredItems),
  };
}

export async function getConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.config);
  return normalizeConfig(data[STORAGE_KEYS.config]);
}

export async function saveConfig(patch) {
  const current = await getConfig();
  const next = normalizeConfig({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: next });
  return next;
}

export async function getItems() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.items);
  return Array.isArray(data[STORAGE_KEYS.items]) ? data[STORAGE_KEYS.items] : [];
}

export async function setItems(items) {
  await chrome.storage.local.set({ [STORAGE_KEYS.items]: items || [] });
}

export async function getScanMeta() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.scanMeta);
  return Object.assign(
    {
      lastScanAt: 0,
      lastScanOk: false,
      lastError: '',
      loggedIn: null,
      scannedCourses: 0,
      scannedItems: 0,
      source: 'auto',
    },
    data[STORAGE_KEYS.scanMeta] || {}
  );
}

export async function setScanMeta(patch) {
  const current = await getScanMeta();
  const next = { ...current, ...(patch || {}) };
  await chrome.storage.local.set({ [STORAGE_KEYS.scanMeta]: next });
  return next;
}

export async function getNotified() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.notified);
  const raw = data[STORAGE_KEYS.notified];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, thresholds] of Object.entries(raw)) {
    if (Array.isArray(thresholds)) {
      out[key] = thresholds
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t));
    }
  }
  return out;
}

export async function setNotified(map) {
  await chrome.storage.local.set({ notified: map || {} });
}

export async function getScanState() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.scanState);
  return data[STORAGE_KEYS.scanState] || null;
}

export async function setScanState(state) {
  if (state == null) {
    await chrome.storage.local.remove(STORAGE_KEYS.scanState);
  } else {
    await chrome.storage.local.set({ [STORAGE_KEYS.scanState]: state });
  }
}

/** 清空采集结果缓存（保留配置）。 */
export async function clearItems() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.items]: [],
    [STORAGE_KEYS.notified]: {},
    [STORAGE_KEYS.scanMeta]: {
      lastScanAt: 0,
      lastScanOk: false,
      lastError: '',
      loggedIn: null,
      scannedCourses: 0,
      scannedItems: 0,
      source: 'auto',
    },
  });
}
