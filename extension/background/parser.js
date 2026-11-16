/**
 * 解析模块。
 *
 * 分两部分：
 * 1. page* 函数：通过 chrome.scripting.executeScript 注入到学习通页面执行的
 *    自包含函数（序列化后运行，不能引用模块作用域变量）。
 * 2. 纯函数：在 service worker 中把页面提取的文本行转换成 Item，并解析截止时间。
 */

import { URLS } from './config.js';

/* ------------------------------------------------------------------ */
/* 一、页面内执行函数（必须自包含）                                      */
/* ------------------------------------------------------------------ */

/**
 * 在页面上下文里带 cookie 请求课程列表 JSON。
 * @returns {Promise<{ok:boolean, courses?:Array, error?:string, hint?:string}>}
 */
export function pageFetchCourses() {
  return (async () => {
    const url =
      'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1';
    try {
      const res = await fetch(url, { credentials: 'include' });
      const text = await res.text();
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) {
        let data;
        try {
          data = JSON.parse(trimmed);
        } catch (e) {
          return { ok: false, error: 'JSON_PARSE_FAILED' };
        }
        const courses = [];
        const channelList = data.channelList || [];
        for (const channel of channelList) {
          const content = channel && channel.content;
          if (!content) continue;
          const courseData = content.course && content.course.data;
          if (!Array.isArray(courseData)) continue;
          for (const c of courseData) {
            courses.push({
              courseId: String(c.id == null ? '' : c.id),
              classId: String(content.id == null ? '' : content.id),
              cpi: String(channel.cpi == null ? '' : channel.cpi),
              title: String(c.name == null ? '' : c.name),
            });
          }
        }
        return { ok: true, courses };
      }
      // 非 JSON：通常是登录页 HTML
      const notLoggedIn =
        trimmed.indexOf('passport2.chaoxing.com') !== -1 ||
        trimmed.indexOf('用户登录') !== -1 ||
        trimmed.indexOf('<!DOCTYPE') !== -1 ||
        trimmed.indexOf('<html') !== -1;
      return {
        ok: false,
        error: notLoggedIn ? 'NOT_LOGGED_IN' : 'UNEXPECTED_RESPONSE',
        hint: trimmed.slice(0, 160),
      };
    } catch (e) {
      return { ok: false, error: 'FETCH_FAILED', hint: String(e && e.message ? e.message : e) };
    }
  })();
}

/**
 * 在课程页点击「作业」/「考试」tab，返回 iframe 地址。
 * @param {string} tabName 例如 "作业" / "考试"
 */
export function pageClickTabAndGetIframe(tabName) {
  return (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tabs = document.querySelectorAll('a[data-url]');
    let target = null;
    for (const tab of tabs) {
      if ((tab.innerText || '').trim() === tabName) {
        target = tab;
        break;
      }
    }
    if (!target) return { ok: false, error: 'TAB_NOT_FOUND' };
    target.click();
    await sleep(2000);
    const iframe =
      document.getElementById('frame_content-hd') ||
      document.querySelector('iframe');
    if (!iframe) return { ok: false, error: 'IFRAME_NOT_FOUND' };
    return { ok: true, url: iframe.src || '' };
  })();
}

/**
 * 解析当前页面（作业列表页或考试列表页）的条目文本块。
 * @param {string} type "assignment" | "exam"
 * @returns {Promise<{ok:boolean, rows:Array<{text:string, link:string}>}>}
 */
export function pageParseListPage(type) {
  return (async () => {
    const isExam = type === 'exam';
    const items = [];
    // 作业列表常见结构：.ulDiv li；考试列表常为 .ulDiv li / ul > li
    const blocks = document.querySelectorAll(
      '.ulDiv li, .work-list-item, .exam-list-item, .listContent > div, ul > li'
    );
    const noiseRe = /^(全部|已完成|未完成|筛选|暂无|暂无作业|暂无考试|提交的作业将经过)/;
    for (const block of blocks) {
      const text = (block.innerText || '').trim();
      if (!text || text.length < 3) continue;
      if (noiseRe.test(text)) continue;
      const linkEl = block.querySelector('a[href]');
      items.push({
        text,
        link: linkEl ? linkEl.href : '',
      });
    }
    if (items.length === 0) {
      const body = document.body ? (document.body.innerText || '').trim() : '';
      const noData =
        body.indexOf('暂无作业') !== -1 ||
        body.indexOf('暂无考试') !== -1 ||
        body.indexOf('暂未发布') !== -1;
      return {
        ok: !noData,
        rows: [],
        empty: noData,
        title: document.title || '',
        bodyHint: body.slice(0, 300),
        isExam,
      };
    }
    return { ok: true, rows: items, empty: false, title: document.title || '', isExam };
  })();
}

/**
 * 解析移动版「我的作业」聚合页（ul.nav > li）。
 *
 * 学习通 H5 作业页真实结构（参考成熟油猴脚本的实测选择器）：
 *   li[data="作业链接"]
 *     └ div[role="option"]
 *         ├ p            标题
 *         ├ span(1)      状态文本（class 含 "status" 表示未交）
 *         ├ span(2)      课程名
 *         └ .fr          剩余时间
 */
export function pageParseAggregateWorks() {
  return (async () => {
    const out = {
      ok: true,
      rows: [],
      empty: false,
      hasContainer: false,
      url: location.href,
      title: document.title || '',
    };
    const bodyText = document.body ? document.body.innerText || '' : '';
    const onLoginHost = /^passport2\.chaoxing\.com$/i.test(location.hostname);
    const loginLike =
      /passport2\.chaoxing\.com|\/login|用户登录|请先登录/.test(location.href) ||
      /请先登录|登录后查看|用户登录/.test(bodyText);

    let container = document.querySelector('#chaoxing-assignment-wrapper ul.nav');
    if (!container) container = document.querySelector('ul.nav');
    let blocks = document.querySelectorAll('#chaoxing-assignment-wrapper ul.nav > li');
    if (!blocks.length) blocks = document.querySelectorAll('ul.nav > li');
    out.hasContainer = Boolean(container);

    // 被重定向到登录页：直接判定未登录，避免把登录页 DOM 误当成空数据
    if (onLoginHost || (loginLike && !out.hasContainer)) {
      return {
        ok: false,
        error: 'NOT_LOGGED_IN',
        url: location.href,
        title: document.title || '',
        snippet: bodyText.slice(0, 300),
      };
    }

    const seen = new Set();
    for (const li of blocks) {
      const optionEl = li.querySelector('div[role="option"]');
      // 既没有 option 结构、也没有 data 链接的 li 视为导航/筛选噪声
      if (!optionEl && !li.hasAttribute('data')) continue;
      const option = optionEl || li;

      let title = '';
      const p = option.querySelector('p');
      if (p) title = (p.textContent || '').trim();
      if (!title) {
        const lines = (option.innerText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (lines.length) title = lines[0];
      }
      if (!title || title.length < 2) continue;
      if (/^(全部|已完成|未完成|筛选|待提交|已提交|待办)$/.test(title)) continue;

      const spans = option.querySelectorAll('span');
      const statusSpan = spans.length ? spans[0] : null;
      let statusText = statusSpan ? (statusSpan.textContent || '').trim() : '';
      let statusClass = statusSpan ? String(statusSpan.className || '') : '';
      let hasStatusSpan = Boolean(statusSpan);

      // 状态候选：所有 span 文本（供 service worker 侧综合判断）
      const statusCandidates = [];
      for (const sp of spans) {
        const t = (sp.textContent || '').trim();
        if (t) statusCandidates.push({ text: t.slice(0, 40), cls: String(sp.className || '').slice(0, 60) });
      }
      // span 里没有文字状态时，退而查找 class/id 含 status/state 的元素
      if (!statusText) {
        const alt = option.querySelector('[class*="status"], [class*="state"]');
        if (alt) {
          statusText = (alt.textContent || '').trim();
          statusClass = String(alt.className || '');
          hasStatusSpan = Boolean(statusText) || Boolean(statusClass);
          if (statusText) {
            statusCandidates.push({ text: statusText.slice(0, 40), cls: statusClass.slice(0, 60) });
          }
        }
      }

      const itemText = (li.innerText || '').trim();

      let course = '';
      for (let i = 1; i < spans.length; i += 1) {
        const t = (spans[i].textContent || '').trim();
        if (t && t !== statusText && !/^剩余/.test(t) && !/^\d{4}/.test(t)) {
          course = t;
          break;
        }
      }

      const fr = option.querySelector('.fr');
      const leftTime = fr ? (fr.textContent || '').trim() : '';

      const raw = li.getAttribute('data') || '';
      let link = '';
      if (raw) {
        try {
          link = new URL(raw, location.href).href;
        } catch {
          link = raw;
        }
      }
      let stableId = '';
      if (link) {
        try {
          const u = new URL(link);
          const keys = [
            'taskrefId',
            'workId',
            'workid',
            'workRelationId',
            'workrelationid',
            'answerId',
            'id',
            'courseId',
            'clazzId',
            'courseid',
            'clazzid',
          ];
          for (const k of keys) {
            const v = u.searchParams.get(k);
            if (v) stableId += k + '=' + v + '&';
          }
          if (!stableId) stableId = u.pathname;
        } catch {
          stableId = '';
        }
      }
      const dedupKey = title + '|' + stableId;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      out.rows.push({
        title,
        statusText,
        statusClass,
        hasStatusSpan,
        // class 含 "status" 是页面标记的「未交」；class 为空时不作判断
        uncommitted: hasStatusSpan && statusClass ? /status/i.test(statusClass) : null,
        statusCandidates,
        itemText: itemText.slice(0, 300),
        course,
        leftTime,
        link,
        stableId,
        raw,
        debug: {
          liClass: String(li.className || '').slice(0, 120),
          hasOption: Boolean(optionEl),
          spanCount: spans.length,
        },
      });
    }

    out.empty = out.rows.length === 0;
    if (out.empty) out.snippet = bodyText.slice(0, 400);
    return out;
  })();
}

/**
 * 解析移动版「我的考试」聚合页（ul.ks_list > li）。
 *
 * 结构：
 *   li[data="考试链接"]
 *     ├ dl > dt      标题
 *     ├ dl > dd      剩余时间/考试时间
 *     ├ span.ks_state 状态
 *     └ div.ks_pic > img（src 含 ks_02 表示已过期）
 */
export function pageParseAggregateExams() {
  return (async () => {
    const out = {
      ok: true,
      rows: [],
      empty: false,
      hasContainer: false,
      url: location.href,
      title: document.title || '',
    };
    const bodyText = document.body ? document.body.innerText || '' : '';
    const onLoginHost = /^passport2\.chaoxing\.com$/i.test(location.hostname);
    const loginLike =
      /passport2\.chaoxing\.com|\/login|用户登录|请先登录/.test(location.href) ||
      /请先登录|登录后查看|用户登录/.test(bodyText);

    let container = document.querySelector('#chaoxing-assignment-wrapper ul.ks_list');
    if (!container) container = document.querySelector('ul.ks_list');
    let blocks = document.querySelectorAll('#chaoxing-assignment-wrapper ul.ks_list > li');
    if (!blocks.length) blocks = document.querySelectorAll('ul.ks_list > li');
    out.hasContainer = Boolean(container);

    // 被重定向到登录页：直接判定未登录
    if (onLoginHost || (loginLike && !out.hasContainer)) {
      return {
        ok: false,
        error: 'NOT_LOGGED_IN',
        url: location.href,
        title: document.title || '',
        snippet: bodyText.slice(0, 300),
      };
    }

    const seen = new Set();
    for (const li of blocks) {
      if (!li.hasAttribute('data') && !li.querySelector('dl')) continue;
      const dl = li.querySelector('dl');
      let title = '';
      let timeLeft = '';
      if (dl) {
        const dt = dl.querySelector('dt');
        const dd = dl.querySelector('dd');
        title = dt ? (dt.textContent || '').trim() : '';
        timeLeft = dd ? (dd.textContent || '').trim() : '';
      }
      if (!title) {
        const lines = (li.innerText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (lines.length) title = lines[0];
      }
      if (!title || title.length < 2) continue;

      const itemText = (li.innerText || '').trim();
      // 状态：优先 span.ks_state，其次 class 含 state/status 的元素
      let statusText = '';
      let statusClass = '';
      const stateEl = li.querySelector('span.ks_state');
      if (stateEl) {
        statusText = (stateEl.textContent || '').trim();
        statusClass = String(stateEl.className || '');
      }
      const spans = li.querySelectorAll('span');
      const statusCandidates = [];
      for (const sp of spans) {
        const t = (sp.textContent || '').trim();
        if (t) statusCandidates.push({ text: t.slice(0, 40), cls: String(sp.className || '').slice(0, 60) });
      }
      if (!statusText) {
        const alt = li.querySelector('[class*="state"], [class*="status"]');
        if (alt) {
          statusText = (alt.textContent || '').trim();
          statusClass = String(alt.className || '');
        }
      }

      const img = li.querySelector('div.ks_pic > img');
      const imgSrc = img ? String(img.getAttribute('src') || '') : '';
      const expired = imgSrc.includes('ks_02');

      const raw = li.getAttribute('data') || '';
      let link = '';
      if (raw) {
        try {
          link = new URL(raw, location.href).href;
        } catch {
          link = raw;
        }
      }
      let stableId = '';
      if (link) {
        try {
          const u = new URL(link);
          const keys = ['taskrefId', 'examId', 'examid', 'id', 'courseId', 'clazzId', 'courseid', 'clazzid'];
          for (const k of keys) {
            const v = u.searchParams.get(k);
            if (v) stableId += k + '=' + v + '&';
          }
          if (!stableId) stableId = u.pathname;
        } catch {
          stableId = '';
        }
      }
      const dedupKey = title + '|' + stableId;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      out.rows.push({
        title,
        timeLeft,
        statusText,
        statusClass,
        statusCandidates,
        itemText: itemText.slice(0, 300),
        expired,
        link,
        stableId,
        debug: {
          liClass: String(li.className || '').slice(0, 120),
          imgSrc: imgSrc.slice(0, 120),
          spanCount: spans.length,
        },
      });
    }

    out.empty = out.rows.length === 0;
    if (out.empty) out.snippet = bodyText.slice(0, 400);
    return out;
  })();
}

/* ------------------------------------------------------------------ */
/* 二、纯函数：文本 → Item，时间解析（service worker 使用）               */
/* ------------------------------------------------------------------ */

const NOISE_PREFIX = /^(全部|已完成|未完成|筛选|暂无|暂无作业|暂无考试|提交的作业将经过)/;
const DONE_SPLIT = /已完成|已批阅|已结束/;

/**
 * 把页面提取的文本行转换成 Item 列表。
 * @param {Array<{text:string, link?:string}>} rows
 * @param {{type:'assignment'|'exam', course:string, listUrl:string}} ctx
 * @param {number} now
 * @returns {Array<Item>}
 */
export function rowsToItems(rows, ctx, now) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const text = typeof row === 'string' ? row : row && row.text ? row.text : '';
    if (!text || text.length < 3) continue;
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    // 过滤整块噪声（例如表头）
    if (NOISE_PREFIX.test(lines[0]) && lines.length < 3) continue;
    // 标题：第一行，去掉多余空白
    let title = '';
    for (const line of lines) {
      if (NOISE_PREFIX.test(line)) continue;
      if (/^(已交|未交|已完成|已批阅|待批阅|进行中|未开始|已结束)$/.test(line)) continue;
      if (/^剩余/.test(line)) continue;
      if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(line)) continue;
      title = line.replace(/\s+/g, ' ').trim();
      break;
    }
    if (!title) continue;

    const status = parseStatus(text, ctx.type);
    const deadlineInfo = parseDeadline(text, now);
    const scoreMatch = text.match(/(\d+(?:\.\d+)?)\s*分(?!钟)/);
    const score = scoreMatch ? scoreMatch[1] : '';
    const link = row && row.link ? String(row.link) : '';

    // key 必须跨扫描稳定：
    // - 有绝对截止日期 → 用日期文本（稳定）；
    // - 否则用链接中的作业/考试 id；
    // - 再否则退回「课程+标题」。
    // 不能用相对剩余时间或计算出的 deadline（每次扫描都会漂移，会破坏提醒去重）。
    const absoluteDeadlineText =
      deadlineInfo.deadlineText && /^\d{4}[-/.]/.test(deadlineInfo.deadlineText)
        ? deadlineInfo.deadlineText
        : '';
    const stableId = absoluteDeadlineText || extractLinkId(link) || 'rel';
    const key =
      (ctx.type === 'exam' ? 'e' : 'a') +
      '|' +
      ctx.course +
      '|' +
      title +
      '|' +
      stableId;

    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      key,
      type: ctx.type,
      course: ctx.course,
      title,
      status,
      deadline: deadlineInfo.deadline,
      deadlineText: deadlineInfo.deadlineText,
      startText: deadlineInfo.startText,
      score,
      url: link || ctx.listUrl || URLS.interaction,
      extra: text.slice(0, 400),
    });
  }
  return out;
}

/**
 * 解析状态。
 * @param {string} text
 * @param {'assignment'|'exam'} type
 */
export function parseStatus(text, type) {
  if (type === 'exam') {
    const m = text.match(/(未开始|进行中|已结束|已完成|未交|待批阅)/);
    if (m) return m[1];
    if (/剩余/.test(text)) return '进行中';
    return '未知';
  }
  const m = text.match(
    /(待互评|未互评|互评中|已互评|未交|待批阅|已完成|已批阅|未完成|已交)/
  );
  if (m) {
    if (m[1] === '已交' || m[1] === '已互评') return '已完成';
    if (m[1] === '未完成') return '未交';
    if (/待互评|未互评|互评中/.test(m[1])) return '待互评';
    return m[1];
  }
  return '未知';
}

/**
 * 解析截止时间。
 * 返回 { deadline: number|null, deadlineText: string, startText: string }。
 * 规则：
 * 1) 有明确日期字符串：取最后一个日期（作业/考试的截止时间通常在后）；
 * 2) 有“剩余 X 天 Y 小时”等相对时间：deadline ≈ now + 剩余时长；
 * 3) 两者都有时优先绝对日期。
 * @param {string} text
 * @param {number} now epoch ms
 */
export function parseDeadline(text, now) {
  const results = { deadline: null, deadlineText: '', startText: '' };

  const dates = extractDates(text);
  if (dates.length >= 2) {
    results.startText = dates[0].text;
    results.deadlineText = dates[dates.length - 1].text;
    results.deadline = dates[dates.length - 1].at;
  } else if (dates.length === 1) {
    // 只有一个日期：若上下文有“截止/结束”，当作截止；否则也按截止处理（作业列表常见）
    const isEnd = /(截止|结束|至)/.test(text);
    if (isEnd) {
      results.deadlineText = dates[0].text;
      results.deadline = dates[0].at;
    } else {
      results.deadlineText = dates[0].text;
      results.deadline = dates[0].at;
    }
  }

  // 相对剩余时间（"剩余 2 天 3 小时" / "剩余23小时5分钟" / "剩余 5 分钟"）
  const remain = parseRemaining(text);
  if (remain != null) {
    const remainingText = '剩余' + formatDuration(remain);
    if (results.deadline == null) {
      results.deadline = now + remain;
      results.deadlineText = remainingText;
    }
  }

  return results;
}

/** 提取文本中的日期时间，返回 [{text, at}]。 */
export function extractDates(text) {
  const re =
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = m[4] == null ? 23 : Number(m[4]);
    const minute = m[5] == null ? 59 : Number(m[5]);
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    const at = d.getTime();
    if (!Number.isNaN(at)) {
      out.push({ text: m[0].replace(/\s+/g, ' ').trim(), at });
    }
  }
  return out;
}

/**
 * 解析“剩余 X 天 Y 小时”“剩余 X 小时 Y 分钟”等，返回剩余毫秒或 null。
 * @param {string} text
 */
export function parseRemaining(text) {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  let total = 0;
  let found = false;

  // 剩余 X 天 Y 小时
  let m = text.match(/剩余\s*(\d+)\s*天(?:\s*(\d+)\s*小时)?/);
  if (m) {
    total += Number(m[1]) * DAY + (m[2] ? Number(m[2]) * HOUR : 0);
    found = true;
    // 可能有“X 分钟”
    const mm = text.match(/剩余[^，。;；\n]*?(\d+)\s*分钟/);
    if (mm) total += Number(mm[1]) * MIN;
    return found ? total : null;
  }
  // 剩余 X 小时 Y 分钟
  m = text.match(/剩余\s*(\d+)\s*小时(?:\s*(\d+)\s*分钟)?/);
  if (m) {
    total += Number(m[1]) * HOUR + (m[2] ? Number(m[2]) * MIN : 0);
    return total;
  }
  // 剩余 X 分钟
  m = text.match(/剩余\s*(\d+)\s*分钟/);
  if (m) return Number(m[1]) * MIN;
  // 剩余 X 秒（极少见）
  m = text.match(/剩余\s*(\d+)\s*秒/);
  if (m) return Number(m[1]) * 1000;
  return null;
}

/** 提取链接中的稳定 id（作业/考试 id），作为条目 key 的一部分。 */
export function extractLinkId(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const keys = [
      'workId',
      'workid',
      'work_id',
      'workRelationId',
      'workrelationid',
      'taskrefId',
      'answerId',
      'examId',
      'examid',
      'testId',
      'testid',
      'id',
      'taskId',
      'taskid',
    ];
    for (const k of keys) {
      const v = u.searchParams.get(k);
      if (v) return k + '=' + v;
    }
    return u.pathname || '';
  } catch {
    return '';
  }
}

/** 格式化剩余毫秒为“X天X小时”/“X小时X分钟”。 */
export function formatDuration(ms) {
  if (ms == null || ms <= 0) return '';
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MIN);
  if (days > 0) return days + '天' + (hours > 0 ? hours + '小时' : '');
  if (hours > 0) return hours + '小时' + (minutes > 0 ? minutes + '分钟' : '');
  return Math.max(1, minutes) + '分钟';
}

/* ------------------------------------------------------------------ */
/* 三、聚合作业/考试页 → Item                                          */
/* ------------------------------------------------------------------ */

/** 已提交/已完成类状态词（优先判定，避免被“未”字误伤）。 */
const WORK_DONE_RE =
  /(已完成|已批阅|已交|已提交|已答|待批阅|批阅中|未批阅|已评分|已通过)/;
/** 未提交/待完成类状态词。 */
const WORK_PENDING_RE = /(未交|未提交|未完成|待完成|待提交|去完成|立即完成|待作答|未作答)/;
/** 互评：待互评/未互评/互评中 是学生还需要操作的任务，不能算完成。 */
const WORK_PEER_PENDING_RE = /(待互评|未互评|互评中)/;
/** 互评：已互评才算完成。 */
const WORK_PEER_DONE_RE = /(已互评|互评完成)/;

/** 考试已交卷类状态词。 */
const EXAM_DONE_RE = /(已完成|已批阅|已交|已提交|待批阅|未批阅)/;

/** 取状态候选的文本。 */
function candidateText(cand) {
  if (cand == null) return '';
  if (typeof cand === 'string') return cand.trim();
  if (typeof cand === 'object' && typeof cand.text === 'string') return cand.text.trim();
  return '';
}

/**
 * 作业状态映射。
 * 判定顺序：状态文本 → 所有状态候选 → 整条文本 → 页面 class 标记 → li class 线索。
 * @param {string} statusText
 * @param {boolean|null} uncommitted
 * @param {boolean} hasStatusSpan
 * @param {string} [fallbackText] 整条条目文本
 * @param {Array} [candidates] 状态候选（[{text, cls}] 或字符串）
 * @param {string} [liClass] 条目 li 的 class
 * @returns {string} 已完成 / 未交 / 待互评 / 未知
 */
export function mapWorkStatus(statusText, uncommitted, hasStatusSpan, fallbackText, candidates, liClass) {
  const t = String(statusText || '').trim();
  const apply = (s) => {
    if (!s) return '';
    if (WORK_PEER_PENDING_RE.test(s)) return '待互评';
    if (WORK_PEER_DONE_RE.test(s)) return '已完成';
    if (WORK_DONE_RE.test(s)) return '已完成';
    if (WORK_PENDING_RE.test(s)) return '未交';
    return '';
  };

  const direct = apply(t);
  if (direct) return direct;

  for (const cand of candidates || []) {
    const ct = candidateText(cand);
    if (!ct || ct === t) continue;
    const got = apply(ct);
    if (got) return got;
  }

  const ft = String(fallbackText || '');
  if (ft && ft !== t) {
    const got = apply(ft);
    if (got) return got;
  }

  if (hasStatusSpan) {
    if (uncommitted === true) return '未交';
    if (uncommitted === false) return '已完成';
  }

  // li 的 class 线索（如 work-done / is-finished）
  if (liClass && /(done|finish|complete|success)/i.test(liClass)) return '已完成';

  return '未知';
}

/**
 * 考试状态映射。
 * 判定顺序：状态文本 → 状态候选 → 整条文本。
 * @param {string} statusText
 * @param {boolean} expired 图片/文本标记已过期
 * @param {string} [fallbackText]
 * @param {Array} [candidates]
 * @returns {string} 已完成 / 已结束 / 进行中 / 未开始 / 未知
 */
export function mapExamStatus(statusText, expired, fallbackText, candidates) {
  const apply = (s) => {
    if (!s) return '';
    if (EXAM_DONE_RE.test(s)) return '已完成';
    if (/已结束/.test(s)) return '已结束';
    if (/进行中|开始作答|去考试/.test(s)) return '进行中';
    if (/未开始/.test(s)) return '未开始';
    if (/剩余/.test(s)) return '进行中';
    return '';
  };
  const t = String(statusText || '').trim();
  const direct = apply(t);
  if (direct) return direct;
  if (expired) return '已结束';

  for (const cand of candidates || []) {
    const ct = candidateText(cand);
    if (!ct || ct === t) continue;
    const got = apply(ct);
    if (got) return got;
  }

  const got = apply(String(fallbackText || ''));
  return got || '未知';
}

/**
 * 聚合页作业行 → Item。
 * @param {Array} rows pageParseAggregateWorks 的 rows
 * @param {number} now
 * @param {string} fallbackUrl
 */
export function aggregateWorkToItems(rows, now, fallbackUrl) {
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.title) continue;
    const status = mapWorkStatus(
      r.statusText,
      r.uncommitted,
      r.hasStatusSpan,
      r.itemText,
      r.statusCandidates,
      r.debug && r.debug.liClass
    );
    // 剩余时间文本里可能有绝对日期，也可能只有“剩余 X 天”；没有时用整条文本兜底
    const deadlineSource =
      r.leftTime || (/截止|剩余/.test(r.itemText || '') ? r.itemText : '');
    const deadlineInfo = parseDeadline(deadlineSource, now);
    const candSummary = (r.statusCandidates || [])
      .map((c) => candidateText(c))
      .filter((t) => t && t !== r.statusText)
      .slice(0, 3)
      .join(' / ');
    out.push({
      key: 'a|' + (r.course || '') + '|' + r.title + '|' + (r.stableId || 'x'),
      type: 'assignment',
      course: r.course || '',
      title: r.title,
      status,
      deadline: deadlineInfo.deadline,
      deadlineText: deadlineInfo.deadlineText,
      startText: '',
      score: '',
      url: r.link || fallbackUrl,
      extra: [r.leftTime || '', r.statusText || '', candSummary]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 200),
    });
  }
  return out;
}

/**
 * 聚合页考试行 → Item。
 * @param {Array} rows pageParseAggregateExams 的 rows
 * @param {number} now
 * @param {string} fallbackUrl
 * @param {Record<string,string>} [courseNameById] courseId → 课程名（可选）
 */
export function aggregateExamToItems(rows, now, fallbackUrl, courseNameById) {
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.title) continue;
    const status = mapExamStatus(r.statusText, r.expired, r.itemText, r.statusCandidates);
    const deadlineSource =
      r.timeLeft || (/截止|剩余|考试时间/.test(r.itemText || '') ? r.itemText : '');
    const deadlineInfo = parseDeadline(deadlineSource, now);
    let course = '';
    if (courseNameById && r.link) {
      try {
        const u = new URL(r.link);
        const courseId = u.searchParams.get('courseId') || u.searchParams.get('courseid') || '';
        if (courseId && courseNameById[courseId]) course = courseNameById[courseId];
      } catch {
        /* 忽略 */
      }
    }
    out.push({
      key: 'e|' + (course || '') + '|' + r.title + '|' + (r.stableId || 'x'),
      type: 'exam',
      course,
      title: r.title,
      status,
      deadline: deadlineInfo.deadline,
      deadlineText: deadlineInfo.deadlineText,
      startText: deadlineInfo.startText,
      score: '',
      url: r.link || fallbackUrl,
      extra: (r.timeLeft || '') + ' | ' + (r.statusText || '') + (r.expired ? ' | 已过期' : ''),
    });
  }
  return out;
}
