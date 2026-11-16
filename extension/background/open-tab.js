/**
 * 打开学习通条目页面。
 *
 * 背景：作业/考试列表里的链接是「详情页」（如 android/mtaskmsgspecial、
 * work/phone/task-work、exam/phone/task-exam）。这些页面上的「开始答题/考试」
 * 按钮依赖学习通 App 的 JS Bridge，在桌面浏览器里点击没有反应。
 *
 * 打开顺序（v1.2.6）：
 * 1. 作业优先走电脑版：课程页 → 「作业」标签 → 电脑版列表 → 条目链接 →
 *    mooc-ans/mooc2/work/task（302 到 mooc-ans/mooc2/work/dowork）。
 *    电脑版页面才能被「大学搜题酱」等第三方插件适配。
 * 2. 考试优先走电脑版 examnotes。
 * 3. 电脑版解析失败时，回退到详情页里的手机版作答地址：
 *    作业 /work/phone/doHomeWork，考试 /exam-ans/exam/phone/doExam。
 * 4. 仍失败则停留在详情页。
 */

import { waitForTabComplete, execInTab, sleep } from './chaoxing.js';

const RESOLVE_TIMEOUT = 20000;
const COURSE_ENTRY =
  'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid={courseId}&clazzid={classId}&cpi={cpi}&ismooc2=1&v=2';
const DESKTOP_CACHE_TTL = 10 * 60 * 1000;

/** 同一课程/条目 10 分钟内复用已解析的电脑版地址，避免每次点击都走一遍课程页。 */
const desktopCache = new Map();

/** 清空电脑版地址缓存（报告检查前调用，避免拿到旧的“未提交”状态）。 */
export function clearDesktopCache() {
  desktopCache.clear();
}

/** 是否为作业/考试的详情页（需要二次解析）。 */
export function isDetailPageUrl(url) {
  return (
    /^https:\/\/([a-z0-9-]+\.)*chaoxing\.com\//i.test(String(url || '')) &&
    (/\/mooc-ans\/(?:android\/mtaskmsgspecial|work\/phone\/task-work|work\/phone\/eval-list)\?/i.test(
      url
    ) ||
      /\/exam-ans\/exam\/phone\/task-exam\?/i.test(url))
  );
}

/**
 * 在页面上下文执行：从详情页 HTML / 全局函数中提取作答地址。
 * 必须自包含（会被序列化注入页面），不能引用模块作用域变量。
 */
export function pageExtractAnswerUrl() {
  const absolute = (raw) => {
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.charAt(0) !== '/') return '';
    if (raw.indexOf('/mooc-ans/') === 0 || raw.indexOf('/exam-ans/') === 0) {
      return location.origin + raw;
    }
    return location.origin + '/mooc-ans' + raw;
  };

  const patterns = [
    /\/work\/phone\/doHomeWork\?[^'"\\\n]+/,
    /\/work\/doHomeWorkNew\?[^'"\\\n]+/,
    /\/exam-ans\/exam\/phone\/doExam\?[^'"\\\n]+/,
    /\/exam\/phone\/doExam\?[^'"\\\n]+/,
    /\/exam-ans\/exam\/test\/start[^'"\\\n]*/,
    /\/exam\/test\/start[^'"\\\n]*/,
  ];

  const html = document.documentElement ? document.documentElement.innerHTML : '';
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const url = absolute(m[0].replace(/&amp;/g, '&'));
      if (url) return { ok: true, url };
    }
  }

  // 兜底：从全局 jump / startExam 函数源码里找地址
  for (const name of ['jump', 'startExam', 'doExam']) {
    try {
      const fn = window[name];
      if (typeof fn === 'function') {
        const src = String(fn);
        const m = src.match(
          /['"]((?:\/mooc-ans)?\/(?:work\/(?:phone\/doHomeWork|doHomeWorkNew)|exam[^'"]*(?:doExam|start))[^'"]*)['"]/
        );
        if (m) {
          const url = absolute(m[1].replace(/&amp;/g, '&'));
          if (url) return { ok: true, url };
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  return { ok: false };
}

/**
 * 在电脑版课程页点击「作业 / 考试」标签，返回内容 iframe 的列表地址。
 * 必须自包含（注入页面执行）。
 * @param {string} tabName "作业" | "考试"
 */
export function pageClickTabAndGetListUrl(tabName) {
  return (async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const clean = (el) => (el.textContent || '').replace(/\s+/g, '').replace(/NEW$/i, '');
    const tabs = [...document.querySelectorAll('a[data-url]')];
    const tab = tabs.find((a) => clean(a) === tabName) || tabs.find((a) => clean(a).startsWith(tabName));
    if (!tab) return { ok: false, error: 'TAB_NOT_FOUND' };
    const preferredId = tabName === '考试' ? 'frame_content-ks' : 'frame_content-zy';
    const before = new Map(
      [...document.querySelectorAll('iframe')].map((f) => [f.id, f.src || ''])
    );
    tab.click();

    for (let i = 0; i < 15; i += 1) {
      await nap(400);
      const preferred = document.getElementById(preferredId);
      if (preferred && preferred.src && preferred.src !== before.get(preferredId)) {
        return { ok: true, url: preferred.src };
      }
      const frames = [...document.querySelectorAll('iframe[id^="frame_content"]')];
      const changed = frames.find(
        (f) => f.src && f.src !== before.get(f.id) && f.src.indexOf('chaoxing.com') !== -1
      );
      if (changed) return { ok: true, url: changed.src };
    }
    return { ok: false, error: 'IFRAME_NOT_FOUND' };
  })();
}

/**
 * 在电脑版作业/考试列表里按 id 找到条目链接。
 * 必须自包含（注入页面执行）。
 *
 * 关键：聚合页给的 id 常在 `taskrefId` 里，而电脑版列表的链接用 `workId`
 * ——两者数值相同但参数名不同，所以必须同时按 taskrefId / workId 匹配。
 * @param {string} id workId 或 examId（也接受 taskrefId）
 * @param {'work'|'exam'|'peer'} kind
 */
export function pageFindTaskUrl(id, kind) {
  return (() => {
    const wanted = String(id || '').trim();
    if (!wanted) return { ok: false, error: 'NO_ID' };

    const workKeys = ['workId=', 'workid=', 'taskrefId=', 'workRelationId='];
    const examKeys = ['examId=', 'examid=', 'taskrefId='];
    const keys = kind === 'exam' ? examKeys : workKeys;

    // 精确到“参数值完全相等”，避免 workId=123 匹配到 workId=1234
    const matchValue = (data) => {
      for (const k of keys) {
        const idx = data.indexOf(k);
        if (idx < 0) continue;
        const rest = data.slice(idx + k.length);
        const val = rest.split(/[&#"'\s]/)[0];
        if (val === wanted) return true;
      }
      return false;
    };

    const found = [];
    for (const li of document.querySelectorAll('li[data]')) {
      const data = li.getAttribute('data') || '';
      if (!data || !matchValue(data)) continue;
      try {
        found.push(new URL(data, location.href).href);
      } catch {
        found.push(data);
      }
    }

    // 兜底：从页面 HTML 里直接捞链接（列表结构改版时也能命中）
    if (!found.length) {
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const hrefRe = /(?:https?:\/\/[^"'\s<>]+)?\/mooc-ans\/mooc2\/work\/[^"'\s<>]+/g;
      let m;
      while ((m = hrefRe.exec(html)) !== null) {
        const raw = m[0].replace(/&amp;/g, '&');
        if (!matchValue(raw)) continue;
        try {
          found.push(new URL(raw, location.href).href);
        } catch {
          /* 忽略 */
        }
      }
    }

    if (!found.length) return { ok: false, error: 'NOT_FOUND' };

    if (kind === 'peer') {
      const evalUrl = found.find((u) => /\/mooc2\/work\/eval-list\?/i.test(u));
      return { ok: true, url: evalUrl || found[0] };
    }
    if (kind === 'work') {
      // 已提交的作业：优先 view（只读详情）；未提交则 dowork
      const view = found.find((u) => /\/mooc2\/work\/view\?/i.test(u));
      if (view) return { ok: true, url: view };
      const task = found.find((u) => /\/mooc2\/work\/task\?/i.test(u));
      if (task) return { ok: true, url: task };
      const dowork = found.find((u) => /\/mooc2\/work\/dowork\?/i.test(u));
      return { ok: true, url: dowork || found[0] };
    }
    return { ok: true, url: found[0] };
  })();
}

/**
 * 在考试说明页里找「开始考试」地址（reVersionTestStartNew）。
 * 必须自包含（注入页面执行）。
 */
export function pageExtractExamStartUrl() {
  const html = document.documentElement ? document.documentElement.innerHTML : '';
  const absolute = (raw) => {
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.charAt(0) === '/') return location.origin + raw;
    return '';
  };
  const re =
    /(?:(?:https?:\/\/[^'"\s<>]+)?\/exam-ans\/exam\/test\/reVersionTestStartNew\?[^'"\s<>\\]+)/i;
  const m = html.match(re);
  if (m) {
    const url = absolute(m[0].replace(/&amp;/g, '&'));
    if (url) return { ok: true, url };
  }
  return { ok: false };
}

/** 页面可用性检查（注入页面执行）：排除 403/无权限等错误页。 */
export function pageCheckPageUsable() {
  const text = document.body ? String(document.body.innerText || '') : '';
  if (/无权限|无效的|不存在|参数错误|页面已过期|请求失败/.test(text.slice(0, 800))) {
    return { ok: false };
  }
  return { ok: true };
}

/** 电脑版考试入口（examnotes 会自动带出考试信息 / 开始考试入口）。 */
function buildDesktopExamUrl(params) {
  const courseId = params.courseId || '';
  const classId = params.classId || params.clazzId || '';
  const cpi = params.cpi || '';
  const examId = params.examId || params.taskrefId || '';
  if (!courseId || !classId || !cpi || !examId) return '';
  return (
    'https://mooc1.chaoxing.com/mooc-ans/exam/test/examcode/examnotes?courseId=' +
    encodeURIComponent(courseId) +
    '&classId=' +
    encodeURIComponent(classId) +
    '&examId=' +
    encodeURIComponent(examId) +
    '&cpi=' +
    encodeURIComponent(cpi)
  );
}

/** 从多个 URL 中汇总参数（详情页、重定向后的详情页、手机作答页）。 */
function collectParams(...urls) {
  const out = {};
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      for (const [k, v] of u.searchParams) {
        if (!out[k]) out[k] = v;
      }
    } catch {
      /* 忽略 */
    }
  }
  return out;
}

/** 从条目 URL 解析出课程/班级/作业 id（不打开任何页面）。 */
export function paramsFromItemUrl(url, isExam) {
  const params = collectParams(url);
  if (isExam) params.examId = params.examId || params.taskrefId;
  else params.workId = params.workId || params.taskrefId || params.workRelationId;
  return params;
}

/**
 * 直接请求课程列表接口拿 cpi（扩展有 chaoxing host 权限，可带 cookie）。
 * 拿不到时返回空字符串，调用方回退到打开详情页的老流程。
 */
export async function fetchCourseCpi(courseId, classId) {
  if (!courseId) return '';
  try {
    const res = await fetch(
      'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',
      { credentials: 'include', cache: 'no-store' }
    );
    if (!res.ok) return '';
    const text = (await res.text()).trim();
    if (!text.startsWith('{')) return '';
    const data = JSON.parse(text);
    for (const channel of data.channelList || []) {
      const content = channel && channel.content;
      const courseData = content && content.course && content.course.data;
      if (!Array.isArray(courseData)) continue;
      for (const c of courseData) {
        if (
          String(c.id) === String(courseId) &&
          (!classId || String(content.id) === String(classId))
        ) {
          return String(channel.cpi || '');
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  return '';
}

/** 电脑版考试入口：只需 courseId / classId / examId / cpi。 */
async function resolveDesktopExam(tabId, params) {
  const url = buildDesktopExamUrl(params);
  if (!url) return '';
  try {
    const wait = waitForTabComplete(tabId, RESOLVE_TIMEOUT);
    await chrome.tabs.update(tabId, { url });
    if (!(await wait).ok) return '';

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    let finalUrl = tab && tab.url ? tab.url : '';
    if (!finalUrl || !/\/exam[^?#]*\/test\//i.test(finalUrl)) return '';

    const check = await execInTab(tabId, pageCheckPageUsable, []);
    if (!check || !check.ok) return '';
    if (/reVersionTestStartNew/i.test(finalUrl)) return finalUrl;

    // 考试说明页上的「开始考试」入口（进行中的考试）
    const start = await execInTab(tabId, pageExtractExamStartUrl, []);
    if (start && start.ok && start.url) {
      const nextWait = waitForTabComplete(tabId, RESOLVE_TIMEOUT);
      await chrome.tabs.update(tabId, { url: start.url });
      if (!(await nextWait).ok) return '';
      const nextTab = await chrome.tabs.get(tabId).catch(() => null);
      finalUrl = nextTab && nextTab.url ? nextTab.url : '';
    }
    return finalUrl;
  } catch {
    return '';
  }
}

/**
 * 走电脑版流程：课程页 → 点「作业」→ 列表页 → 条目链接 → 作答页。
 * 这样得到的是 mooc1.chaoxing.com 的电脑版页面，第三方搜题插件可正常适配。
 * @returns {Promise<string>} 成功返回最终 URL，失败返回空字符串
 */
export async function resolveDesktopTask(tabId, params, kind) {
  const courseId = params.courseId || '';
  const classId = params.classId || params.clazzId || '';
  const cpi = params.cpi || '';
  const id =
    kind === 'exam'
      ? params.examId || params.taskrefId
      : params.workId || params.taskrefId || params.workRelationId;
  if (!courseId || !classId || !cpi || !id) return '';
  if (kind === 'exam') return resolveDesktopExam(tabId, params);

  const cacheKey = kind + '|' + courseId + '|' + id;
  const cached = desktopCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DESKTOP_CACHE_TTL) return cached.url;

  try {
    const entry = COURSE_ENTRY.replace('{courseId}', encodeURIComponent(courseId))
      .replace('{classId}', encodeURIComponent(classId))
      .replace('{cpi}', encodeURIComponent(cpi));

    let wait = waitForTabComplete(tabId, RESOLVE_TIMEOUT);
    await chrome.tabs.update(tabId, { url: entry });
    if (!(await wait).ok) return '';
    await sleep(900);

    // 点「作业/考试」标签，拿到电脑版列表 iframe 地址
    const tabRes = await execInTab(tabId, pageClickTabAndGetListUrl, [
      kind === 'exam' ? '考试' : '作业',
    ]);
    if (!tabRes || !tabRes.ok || !tabRes.url) return '';

    wait = waitForTabComplete(tabId, RESOLVE_TIMEOUT);
    await chrome.tabs.update(tabId, { url: tabRes.url });
    if (!(await wait).ok) return '';
    await sleep(700);

    const found = await execInTab(tabId, pageFindTaskUrl, [String(id), kind]);
    if (!found || !found.ok || !found.url) return '';

    // 电脑版条目链接会重定向到 doWork / 考试作答页
    wait = waitForTabComplete(tabId, RESOLVE_TIMEOUT);
    await chrome.tabs.update(tabId, { url: found.url });
    if (!(await wait).ok) return '';

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const finalUrl = tab && tab.url ? tab.url : '';
    if (!finalUrl) return '';
    if (kind === 'peer') {
      // 电脑版互评列表
      if (!/\/mooc-ans\/mooc2\/work\/(?:eval-list|view)\b/i.test(finalUrl)) return '';
    } else {
      // dowork = 可作答（未提交）；view = 已提交后的只读详情。
      // 报告检查会用 view 读已提交内容；两者都可接受，交给调用方再判断。
      if (!/\/mooc-ans\/mooc2\/work\/(?:dowork|view)\b/i.test(finalUrl)) return '';
    }
    desktopCache.set(cacheKey, { url: finalUrl, at: Date.now() });
    return finalUrl;
  } catch {
    return '';
  }
}

/**
 * 在页面上下文执行：点击「大学搜题酱」的「AI 会话」按钮。
 * 该插件的 UI 位于 #dx-sibebar-container 的 open shadow root 内，
 * 按钮为 .chat-btn，点击后等价于用户手动点击。
 * 必须自包含（注入页面执行）。
 */
export function pageOpenDxAiChat() {
  return (async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 25; i += 1) {
      const host = document.getElementById('dx-sibebar-container');
      const root = host && host.shadowRoot;
      if (root) {
        const btn =
          root.querySelector('.chat-btn') ||
          [...root.querySelectorAll('div')].find(
            (el) => (el.textContent || '').trim() === 'AI 会话'
          );
        if (btn) {
          btn.click();
          return { ok: true, clicked: true };
        }
      }
      await nap(400);
    }
    return { ok: false };
  })();
}

/** 若启用联动，尝试在作答页打开大学搜题酱 AI 会话；未安装时静默跳过。 */
async function maybeOpenDxAiChat(tabId, options) {
  if (!options || options.openAiChat !== true) return;
  try {
    await execInTab(tabId, pageOpenDxAiChat, []);
  } catch {
    /* 第三方插件未安装或页面已关闭，忽略 */
  }
}

/**
 * 打开 URL：
 * 1. 普通链接直接打开；
 * 2. 作业/考试详情页先解析出作答地址；
 * 3. 作业优先走电脑版作答页（兼容第三方搜题插件），失败回退手机作答页；
 * 4. 全部失败则保留详情页。
 * @param {string} url
 * @param {{openAiChat?:boolean}} [options]
 * @returns {Promise<{ok:boolean, url:string, resolved:boolean, desktop?:boolean, error?:string}>}
 */
export async function openUrlInTab(url, options = {}) {
  if (!isDetailPageUrl(url)) {
    await chrome.tabs.create({ url, active: true });
    return { ok: true, url, resolved: false };
  }

  try {
    // 立即激活标签页：即使后台解析失败/被回收，用户也能看到有效页面
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    if (!tab || tab.id == null) throw new Error('无法创建标签页');

    const isExam = /\/exam-ans\/exam\/phone\/task-exam\?/i.test(url);
    const isPeer = /\/mooc-ans\/work\/phone\/eval-list\?/i.test(url);
    const desktopKind = isExam ? 'exam' : isPeer ? 'peer' : 'work';
    const params = paramsFromItemUrl(url, isExam);

    // 先用课程列表接口补 cpi；成功的话直接走电脑版，不经过手机详情页
    if (!params.cpi) {
      params.cpi = await fetchCourseCpi(params.courseId, params.classId || params.clazzId);
    }

    let desktopTried = false;
    if (params.cpi) {
      desktopTried = true;
      const desktopUrl = await resolveDesktopTask(tab.id, params, desktopKind);
      if (desktopUrl) {
        await maybeOpenDxAiChat(tab.id, options);
        return { ok: true, url: desktopUrl, resolved: true, desktop: true };
      }
    }

    // 互评任务：电脑版解析失败时直接打开手机版互评列表，不做“提取作答地址”
    if (isPeer) {
      const mobileWait = waitForTabComplete(tab.id, RESOLVE_TIMEOUT);
      await chrome.tabs.update(tab.id, { url });
      await mobileWait;
      return { ok: true, url, resolved: false };
    }

    // 回退：打开手机详情页，提取手机版作答地址（同时补全 cpi 等参数）
    const wait = waitForTabComplete(tab.id, RESOLVE_TIMEOUT);
    await chrome.tabs.update(tab.id, { url });
    const nav = await wait;
    if (!nav || !nav.ok) {
      return { ok: true, url, resolved: false };
    }

    const parsed = await execInTab(tab.id, pageExtractAnswerUrl, []);
    const mobileAnswerUrl = parsed && parsed.ok && parsed.url ? parsed.url : '';
    const tabInfo = await chrome.tabs.get(tab.id).catch(() => null);
    const detailParams = collectParams(url, tabInfo && tabInfo.url, mobileAnswerUrl);
    if (isExam) detailParams.examId = detailParams.examId || detailParams.taskrefId;
    else {
      detailParams.workId =
        detailParams.workId || detailParams.taskrefId || detailParams.workRelationId;
    }
    if (!params.cpi && detailParams.cpi) params.cpi = detailParams.cpi;

    // 之前没拿到 cpi、现在从详情页拿到了：再试一次电脑版
    if (!desktopTried && params.cpi) {
      desktopTried = true;
      const desktopUrl = await resolveDesktopTask(tab.id, params, desktopKind);
      if (desktopUrl) {
        await maybeOpenDxAiChat(tab.id, options);
        return { ok: true, url: desktopUrl, resolved: true, desktop: true };
      }
    }

    // 回退：手机版作答页（doHomeWork / doExam）
    if (mobileAnswerUrl) {
      const nextWait = waitForTabComplete(tab.id, RESOLVE_TIMEOUT);
      await chrome.tabs.update(tab.id, { url: mobileAnswerUrl });
      await nextWait;
      await maybeOpenDxAiChat(tab.id, options);
      return { ok: true, url: mobileAnswerUrl, resolved: true, desktop: false };
    }

    // 两个作答页都没解析出来：回到详情页，保证用户看到的是有效页面
    await chrome.tabs.update(tab.id, { url }).catch(() => {});
    return { ok: true, url, resolved: false };
  } catch (e) {
    return { ok: false, url, resolved: false, error: String(e && e.message ? e.message : e) };
  }
}
