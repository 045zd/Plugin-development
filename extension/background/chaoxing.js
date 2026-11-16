/**
 * 学习通数据采集驱动器。
 *
 * 设计要点：
 * - 学习通没有公开的"列出全部作业"接口，数据只能在已登录的浏览器会话里取；
 * - 因此用一个**后台隐藏标签页**（active:false）顺序导航：
 *   会话页 → 课程页 → 点击「作业 / 考试」tab 拿 iframe 地址 → 导航 iframe → 解析 DOM；
 * - 不操作、不导航用户自己的标签页；
 * - 全部页面内逻辑通过 chrome.scripting.executeScript 注入（MAIN world，带 cookie）。
 */

import { URLS, ERR } from './config.js';
import {
  pageFetchCourses,
  pageClickTabAndGetIframe,
  pageParseListPage,
  rowsToItems,
  pageParseAggregateWorks,
  pageParseAggregateExams,
  aggregateWorkToItems,
  aggregateExamToItems,
} from './parser.js';

const SESSION_PROBE_KEY = 'probeTabId';
const NAV_TIMEOUT = 35000;
const EXEC_TIMEOUT = 20000;

/** 采集错误（带错误码）。 */
export class ScanError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ScanError';
    this.code = code;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* 隐藏标签页管理                                                       */
/* ------------------------------------------------------------------ */

async function readProbeTabId() {
  try {
    const data = await chrome.storage.session.get(SESSION_PROBE_KEY);
    return data[SESSION_PROBE_KEY] || null;
  } catch {
    return null;
  }
}

async function writeProbeTabId(tabId) {
  try {
    if (tabId == null) {
      await chrome.storage.session.remove(SESSION_PROBE_KEY);
    } else {
      await chrome.storage.session.set({ [SESSION_PROBE_KEY]: tabId });
    }
  } catch {
    /* session storage 不可用时忽略 */
  }
}

/**
 * 获取（或创建）后台采集标签页。
 * @returns {Promise<{id:number, created:boolean}>}
 */
export async function getOrCreateProbeTab() {
  const saved = await readProbeTabId();
  if (saved != null) {
    try {
      const tab = await chrome.tabs.get(saved);
      if (tab && tab.id != null && !tab.discarded) {
        return { id: tab.id, created: false };
      }
    } catch {
      /* tab 已不存在，继续新建 */
    }
  }
  const tab = await chrome.tabs.create({ url: URLS.interaction, active: false });
  if (!tab || tab.id == null) {
    throw new ScanError(ERR.TAB_GONE, '无法创建采集标签页');
  }
  await writeProbeTabId(tab.id);
  return { id: tab.id, created: true };
}

/** 关闭采集标签页并清理记录。 */
export async function disposeProbeTab() {
  const saved = await readProbeTabId();
  await writeProbeTabId(null);
  if (saved != null) {
    try {
      await chrome.tabs.remove(saved);
    } catch {
      /* 已关闭 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 标签页等待 / 导航 / 注入                                             */
/* ------------------------------------------------------------------ */

/** 等待标签页加载完成。 */
export function waitForTabComplete(tabId, timeoutMs = NAV_TIMEOUT) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish({ ok: false, error: ERR.TIMEOUT });
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(result);
    }

    function onUpdated(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        finish({ ok: true });
      }
    }
    function onRemoved(id) {
      if (id === tabId) finish({ ok: false, error: ERR.TAB_GONE });
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/** 导航并等待加载完成。 */
export async function navigateAndWait(tabId, url, timeoutMs = NAV_TIMEOUT) {
  const wait = waitForTabComplete(tabId, timeoutMs);
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    return { ok: false, error: ERR.TAB_GONE, message: String(e) };
  }
  return wait;
}

/**
 * 在标签页 MAIN world 执行函数并返回结果。
 * @param {number} tabId
 * @param {Function} func 自包含函数（会被序列化）
 * @param {Array} args
 */
export async function execInTab(tabId, func, args = []) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: ERR.TIMEOUT }), EXEC_TIMEOUT);
  });
  const task = (async () => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
        world: 'MAIN',
      });
      const first = Array.isArray(results) && results.length ? results[0] : null;
      return first ? first.result : { ok: false, error: 'EMPTY_RESULT' };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const code = /No tab with id|Cannot access contents/i.test(msg)
        ? ERR.TAB_GONE
        : ERR.UNKNOWN;
      return { ok: false, error: code, message: msg };
    }
  })();
  const result = await Promise.race([task, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/* ------------------------------------------------------------------ */
/* 聚合页采集（快速路径）                                               */
/* ------------------------------------------------------------------ */

/**
 * 加载一个聚合页并解析，最多等待约 4 秒（页面可能还在渲染）。
 * @param {number} tabId
 * @param {string} url
 * @param {Function} parserFn 页面内解析函数（pageParseAggregateWorks / pageParseAggregateExams）
 */
async function collectAggregatePage(tabId, url, parserFn) {
  const nav = await navigateAndWait(tabId, url, NAV_TIMEOUT);
  if (!nav.ok) return { ok: false, error: nav.error, rows: [] };

  let lastParsed = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(attempt === 0 ? 1300 : 1400);
    const parsed = await execInTab(tabId, parserFn, []);
    if (!parsed) return { ok: false, error: 'NO_RESULT', rows: [] };
    if (parsed.error === 'NOT_LOGGED_IN') {
      return { ok: false, error: 'NOT_LOGGED_IN', rows: [] };
    }
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.error || 'PARSE_FAILED',
        hint: parsed.snippet || '',
        rows: [],
      };
    }
    lastParsed = parsed;
    if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
      return { ok: true, rows: parsed.rows, empty: false };
    }
    if (!parsed.hasContainer) {
      return {
        ok: false,
        error: 'STRUCTURE_MISMATCH',
        hint: parsed.snippet || '',
        rows: [],
      };
    }
    // 容器存在但暂无条目：再等一轮确认（可能是渲染延迟）
  }
  return { ok: true, rows: [], empty: lastParsed ? lastParsed.empty === true : true };
}

/**
 * 依次采集「我的作业」「我的考试」聚合页。
 * @returns {Promise<{works:object, exams:object, authRequired:boolean, usable:boolean}>}
 */
async function collectViaAggregate(tabId, config) {
  const works = config.checkAssignments
    ? await collectAggregatePage(tabId, URLS.aggregateWorks, pageParseAggregateWorks)
    : { ok: false, error: 'SKIPPED', rows: [] };
  await sleep(400);
  const exams = config.checkExams
    ? await collectAggregatePage(tabId, URLS.aggregateExams, pageParseAggregateExams)
    : { ok: false, error: 'SKIPPED', rows: [] };
  const usable = works.ok || exams.ok;
  const authRequired =
    !usable && (works.error === 'NOT_LOGGED_IN' || exams.error === 'NOT_LOGGED_IN');
  return { works, exams, authRequired, usable };
}

/** 把解析行压缩成可导出的诊断数据（不含账号/密码/cookie）。 */
function buildDebugRows(rows) {
  return (rows || []).slice(0, 30).map((r) => ({
    title: String(r.title || '').slice(0, 80),
    statusText: String(r.statusText || '').slice(0, 40),
    statusClass: String(r.statusClass || '').slice(0, 60),
    hasStatusSpan: Boolean(r.hasStatusSpan),
    uncommitted: typeof r.uncommitted === 'boolean' ? r.uncommitted : null,
    candidates: (r.statusCandidates || []).slice(0, 5).map((c) => {
      if (c && typeof c === 'object') {
        return (
          String(c.text || '').slice(0, 30) +
          (c.cls ? ' [' + String(c.cls).slice(0, 30) + ']' : '')
        );
      }
      return String(c || '').slice(0, 30);
    }),
    itemText: String(r.itemText || '').slice(0, 220),
    leftTime: String(r.leftTime || r.timeLeft || '').slice(0, 60),
    liClass: r.debug ? String(r.debug.liClass || '').slice(0, 80) : '',
    spanCount: r.debug ? r.debug.spanCount : undefined,
    imgSrc: r.debug ? String(r.debug.imgSrc || '').slice(0, 100) : '',
    link: String(r.link || '').slice(0, 160),
  }));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 扫描全部课程作业与考试。
 * @param {object} config 规范化后的配置
 * @param {(progress:{phase:string, message:string, done:number, total:number}) => void} [onProgress]
 * @returns {Promise<{ok:boolean, loggedIn:boolean|null, items:Array, courses:number, failedCourses:number, error:string}>}
 */
export async function scanChaoxing(config, onProgress = () => {}) {
  const result = {
    ok: false,
    loggedIn: null,
    items: [],
    courses: 0,
    failedCourses: 0,
    source: '',
    debug: null,
    error: '',
  };

  let probe = null;
  try {
    onProgress({ phase: 'tab', message: '准备采集标签页…', done: 0, total: 0 });
    probe = await getOrCreateProbeTab();

    // 0. 快速路径：移动版「我的作业 / 我的考试」聚合页。
    //    每门课的作业/考试都汇总在同一页，状态来自页面专门的状态元素，
    //    比逐课程解析 DOM 更准确，也快得多（2 次页面加载 vs 每门课 3 次导航）。
    onProgress({ phase: 'aggregate', message: '读取「我的作业/考试」聚合页…', done: 0, total: 0 });
    const agg = await collectViaAggregate(probe.id, config);
    if (agg.authRequired) {
      result.loggedIn = false;
      result.error = ERR.AUTH_REQUIRED;
      result.debug = {
        mode: 'auth',
        savedAt: Date.now(),
        errors: { works: agg.works.error || '', exams: agg.exams.error || '' },
      };
      return result;
    }
    if (agg.usable) {
      const nowAgg = Date.now();
      result.debug = {
        mode: 'aggregate',
        savedAt: nowAgg,
        works: buildDebugRows(agg.works.rows),
        exams: buildDebugRows(agg.exams.rows),
        errors: { works: agg.works.error || '', exams: agg.exams.error || '' },
      };
      if (agg.works.ok) {
        result.items.push(...aggregateWorkToItems(agg.works.rows, nowAgg, URLS.aggregateWorks));
      }
      if (agg.exams.ok) {
        result.items.push(...aggregateExamToItems(agg.exams.rows, nowAgg, URLS.aggregateExams));
      }
      result.loggedIn = true;
      result.source = 'aggregate';
      if (config.checkAssignments && !agg.works.ok) result.failedCourses += 1;
      if (config.checkExams && !agg.exams.ok) result.failedCourses += 1;
      result.ok = true;
      return result;
    }
    // 聚合页不可用（改版 / 网络问题）→ 回退到逐课程采集
    result.source = 'per-course';
    result.debug = {
      mode: 'fallback',
      savedAt: Date.now(),
      errors: {
        works: agg.works.error || '',
        exams: agg.exams.error || '',
        hintWorks: String(agg.works.hint || '').slice(0, 300),
        hintExams: String(agg.exams.hint || '').slice(0, 300),
      },
    };
    onProgress({ phase: 'session', message: '聚合页不可用，改用逐课程采集…', done: 0, total: 0 });

    // 1. 建立会话
    onProgress({ phase: 'session', message: '建立学习通会话…', done: 0, total: 0 });
    let nav = await navigateAndWait(probe.id, URLS.interaction, NAV_TIMEOUT);
    if (!nav.ok) {
      throw new ScanError(nav.error, '会话页加载失败：' + nav.error);
    }
    await sleep(800);

    // 2. 获取课程列表
    onProgress({ phase: 'courses', message: '获取课程列表…', done: 0, total: 0 });
    const courseRes = await execInTab(probe.id, pageFetchCourses, []);
    if (!courseRes || !courseRes.ok) {
      const code = courseRes && courseRes.error;
      if (code === 'NOT_LOGGED_IN') {
        result.loggedIn = false;
        result.error = ERR.AUTH_REQUIRED;
        return result;
      }
      throw new ScanError(code || ERR.FETCH_FAILED, '课程列表获取失败：' + (code || ''));
    }
    result.loggedIn = true;

    const allCourses = Array.isArray(courseRes.courses) ? courseRes.courses : [];
    const courses = allCourses
      .filter((c) => c && c.courseId && c.classId)
      .slice(0, config.maxCourses);
    result.courses = courses.length;

    if (!courses.length) {
      result.ok = true;
      return result;
    }

    // 3. 逐课程采集
    const kinds = [];
    if (config.checkAssignments) kinds.push('assignment');
    if (config.checkExams) kinds.push('exam');
    const totalSteps = courses.length * kinds.length;
    let done = 0;

    for (const course of courses) {
      for (const kind of kinds) {
        done += 1;
        const label = kind === 'assignment' ? '作业' : '考试';
        onProgress({
          phase: 'collect',
          message: `采集「${course.title}」${label}（${done}/${totalSteps}）…`,
          done,
          total: totalSteps,
        });
        try {
          const collected = await collectOne(probe.id, course, kind);
          if (collected.items && collected.items.length) {
            result.items.push(...collected.items);
          }
          if (collected.error && collected.error !== 'EMPTY') {
            result.failedCourses += 1;
          }
        } catch (e) {
          result.failedCourses += 1;
          console.warn('[截止提醒] 课程采集失败', course.title, kind, e);
        }
        await sleep(600);
      }
    }

    result.ok = true;
    return result;
  } catch (e) {
    if (e instanceof ScanError) {
      result.error = e.code;
    } else {
      result.error = ERR.UNKNOWN;
      console.warn('[截止提醒] 采集异常', e);
    }
    return result;
  } finally {
    onProgress({ phase: 'done', message: '采集结束', done: 0, total: 0 });
  }
}

/**
 * 采集单门课的作业或考试。
 * @param {number} tabId
 * @param {{courseId:string,classId:string,cpi:string,title:string}} course
 * @param {'assignment'|'exam'} kind
 */
async function collectOne(tabId, course, kind) {
  const tabName = kind === 'assignment' ? '作业' : '考试';
  const entryUrl = URLS.courseEntry
    .replace('{courseId}', encodeURIComponent(course.courseId))
    .replace('{classId}', encodeURIComponent(course.classId))
    .replace('{cpi}', encodeURIComponent(course.cpi || ''));

  const nav = await navigateAndWait(tabId, entryUrl, NAV_TIMEOUT);
  if (!nav.ok) return { items: [], error: nav.error };

  await sleep(1000);

  // 点击 tab 拿 iframe 地址（TAB_NOT_FOUND 时重试一次，页面可能还在渲染）
  let tabRes = await execInTab(tabId, pageClickTabAndGetIframe, [tabName]);
  if (!tabRes || !tabRes.ok) {
    await sleep(1500);
    tabRes = await execInTab(tabId, pageClickTabAndGetIframe, [tabName]);
  }
  if (!tabRes || !tabRes.ok || !tabRes.url) {
    return { items: [], error: (tabRes && tabRes.error) || 'NO_IFRAME' };
  }

  const iframeUrl = tabRes.url;
  const nav2 = await navigateAndWait(tabId, iframeUrl, NAV_TIMEOUT);
  if (!nav2.ok) return { items: [], error: nav2.error };

  await sleep(1000);
  const parsed = await execInTab(tabId, pageParseListPage, [kind]);
  if (!parsed || !parsed.ok) {
    return { items: [], error: (parsed && parsed.error) || 'PARSE_FAILED' };
  }
  if (parsed.empty || !Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    return { items: [], error: 'EMPTY' };
  }

  const items = rowsToItems(
    parsed.rows,
    { type: kind, course: course.title, listUrl: iframeUrl },
    Date.now()
  );
  return { items };
}
