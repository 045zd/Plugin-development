/**
 * 已交实验报告检查。
 *
 * 目的：检查「实验」类作业的已提交报告是否：
 * 1. 真的提交了内容（附件/文本答案不为空）；
 * 2. 报告的「实验内容和步骤」「实验结果及分析」等栏目是否为空（空白模板）；
 * 3. 报告里填写的课程名称是否与条目所属课程一致。
 *
 * 实现：用一个隐藏标签页按「课程页 → 作业列表 → 作业详情(view)」打开已提交的
 * 电脑版只读页面，提取附件元数据；对 docx 附件下载后解压 word/document.xml
 * 读取文本，再在 service worker 里做结构分析。
 */

import { execInTab, waitForTabComplete } from './chaoxing.js';
import { pageFetchCourses } from './parser.js';
import {
  resolveDesktopTask,
  paramsFromItemUrl,
  fetchCourseCpi,
  clearDesktopCache,
} from './open-tab.js';
import { normalizeCourseName } from './course-filter.js';
import { extractAttachmentText } from './doc-text.js';

/**
 * 下载附件二进制的兜底路径（在 service worker 内）。
 *
 * 主路径是页面内下载（见 pageInspectReport）：签名链接常指向 `d0.cldisk.com`，
 * 页面内请求自带站点上下文最可靠。这里作为兜底保留——已把该域名加入
 * host_permissions，且强制升级 https（http 的 cldisk 链接会被 CDN 直接 403）。
 */
async function fetchAttachmentBytes(download) {
  const url = String(download || '').replace(/^http:/, 'https:');
  if (!url) return { ok: false, buffer: null, error: '没有下载地址' };
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { ok: false, buffer: null, error: '下载失败：HTTP ' + res.status };
    const buffer = await res.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      return { ok: false, buffer: null, error: '下载到的文件为空' };
    }
    return { ok: true, buffer, error: '' };
  } catch (e) {
    return { ok: false, buffer: null, error: '下载失败：' + String(e && e.message ? e.message : e) };
  }
}

const PENDING_STATUSES = new Set(['未交', '待互评', '进行中', '未开始', '未知', '']);

/**
 * 是否是「实验」类且**已提交**的作业。
 *
 * v1.2.13 起额外排除「已截止且未提交」的条目 —— 那类作业没有可检查的报告，
 * 之前会把它们也拉进检查列表，结果是一堆「尚未提交或无法读取已提交内容」。
 */
export function isLabReportItem(item) {
  if (!item || item.type !== 'assignment') return false;
  if (!/实验/i.test(String(item.title || ''))) return false;
  const status = String(item.status || '').trim();
  if (PENDING_STATUSES.has(status)) return false;
  return true;
}

/**
 * 条目是否已进入「互评阶段」。
 *
 * 为什么要单独判断：互评阶段聚合页仍会显示一个「剩余 X 天」，
 * 但它是**互评截止时间**，不是作业提交截止时间。作业提交早已结束
 * （能进入互评就说明提交窗口关了），此时没有「还没交的报告」可言，
 * 检查它只会得到「找不到你提交的附件」这类无意义的结论。
 *
 * 判定依据越界越多越稳：
 *  1) 状态是「已互评 / 待互评 / 互评中」；
 *  2) 条目的 extra（原始整行文本）里出现「已互评 / 待互评 / 互评」；
 *  3) deadlineText 前有「互评」字样。
 */
export function isPeerReviewItem(item) {
  if (!item) return false;
  const status = String(item.status || '').trim();
  if (/互评/.test(status)) return true;
  const extra = String(item.extra || '');
  if (/已互评|待互评|互评中|未互评/.test(extra)) return true;
  const deadlineText = String(item.deadlineText || '');
  if (/互评/.test(deadlineText)) return true;
  return false;
}

/**
 * 判断条目是否**已过截止时间或无法确认截止时间**（用于从检查列表中剔除）。
 *
 * 关键：聚合页对已过期的作业不再显示「剩余时间」，解析出来 `deadline` 就是 `null`。
 * 因此 `deadline === null` 不能当作"未截止"——它恰恰是已过期作业的典型特征。
 * 默认保守跳过，避免把历史学期/已截止的实验报告也拉进来检查。
 *
 * @param {object} item
 * @param {number} now
 * @param {{treatUnknownAsExpired?:boolean}} [options]
 */
export function isPastDeadline(item, now, options = {}) {
  if (!item) return false;
  const treatUnknownAsExpired = options.treatUnknownAsExpired !== false;
  const deadline = item.deadline;
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) {
    return treatUnknownAsExpired;
  }
  return deadline <= now;
}

// 只列「顶层栏目」。实验原理/实验环境等常作为「实验内容和步骤」的子标题，
// 不能当作边界，否则会把正文误切到子标题里。
const SECTION_HEADINGS = [
  '实验名称',
  '实验目的',
  '实验内容和步骤',
  '实验内容及步骤',
  '实验内容',
  '实验步骤',
  '实验过程',
  '实验结果及分析',
  '实验结果与分析',
  '实验结果',
  '实验分析',
  '实验总结',
  '心得体会',
  '结论',
  '成绩和评语',
  '指导教师',
  '审阅日期',
];

const CONTENT_HEADINGS = new Set([
  '实验内容和步骤',
  '实验内容及步骤',
  '实验内容',
  '实验步骤',
  '实验过程',
  '实验结果及分析',
  '实验结果与分析',
  '实验结果',
  '实验分析',
  '实验总结',
  '心得体会',
  '结论',
]);

function countContent(text) {
  return String(text || '').replace(/[\s:：,，。;；、]/g, '').length;
}

/**
 * 章节标题的正则（标题在正文里通常紧跟全角冒号，或者独占一行）。
 * 用正则而不是 indexOf，避免正文里出现的同名词（如"实验内容如下"）被当成标题。
 */
const HEADING_PATTERNS = SECTION_HEADINGS.map((h) => ({
  heading: h,
  re: new RegExp(escapeRe(h) + '(?=[:：\\s]|$)', 'g'),
}));

/**
 * 宽松版：标题后面可以是任意字符（v1.2.24）。
 *
 * 为什么需要：实验报告模板是**表格**，栏目名和内容在不同单元格里，
 * 提取成纯文本后会直接相接——`学号：姓名：实验名称聚类算法实现实验目的1.掌握…`。
 * 严格正则要求标题后是冒号/空白，这种拼接文本一个都匹配不到，
 * 模板骨架就只剩带冒号的那两栏，失去意义。
 *
 * 宽松版只用于**读取模板骨架**和**判断某栏目是否存在**，
 * 不参与报告正文的栏目切分（那仍用严格版，避免正文误切）。
 */
const HEADING_PATTERNS_LOOSE = SECTION_HEADINGS.map((h) => ({
  heading: h,
  re: new RegExp(escapeRe(h), 'g'),
}));

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 找到文本里所有章节标题（长标题优先，避免“实验内容”吃掉“实验内容和步骤”）。 */
function findHeadings(text, patterns = HEADING_PATTERNS) {
  const hits = [];
  for (const { heading, re } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ heading, idx: m.index });
      if (m.index >= re.lastIndex) re.lastIndex = m.index + 1;
    }
  }
  hits.sort((a, b) => a.idx - b.idx || b.heading.length - a.heading.length);
  const merged = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.idx < last.idx + last.heading.length) {
      if (hit.idx === last.idx && hit.heading.length > last.heading.length) {
        merged[merged.length - 1] = hit;
      }
      continue;
    }
    merged.push(hit);
  }
  return merged;
}

/** 宽松地判断文本里是否出现某个栏目标题（用于模板比对的存在性检查）。 */
export function hasHeadingLoose(text, heading) {
  const squashed = String(text || '').replace(/\s+/g, '').replace(/　/g, '');
  return squashed.includes(heading);
}

/** 去掉栏目内容里的“占位符/空白痕迹”，用于判断是否真的为空。 */
function stripPlaceholders(text) {
  return String(text || '')
    // 表格边框、下划线、点线、空格占位
    .replace(/[_＿]{2,}/g, '')
    .replace(/[.．·]{3,}/g, '')
    .replace(/[─—－-]{2,}/g, '')
    .replace(/[（(]\s*(?:空|无|略|待填|此处填写)[^）)]*[)）]/g, '')
    .replace(/^\s*(?:无|暂无|略|空)\s*$/g, '')
    .trim();
}

/**
 * 参与「骨架比对」的栏目标题（v1.2.24）。
 *
 * 与 CONTENT_HEADINGS 的区别：这个集合是给"两边是否都有这一栏"用的，
 * 所以**包含「实验名称」和「实验目的」这类必填栏**——模板有、你也一定会写。
 * 排除的只有「成绩和评语/指导教师/审阅日期」这三栏：
 * 它们是模板尾部的固定表格项，跟实验内容无关，纳入统计只会虚增覆盖率。
 */
const COMPARE_EXCLUDED = new Set(['成绩和评语', '指导教师', '审阅日期', '实验名称']);

/**
 * 从教师模板里提取「栏目骨架」（v1.2.24）。
 *
 * 为什么需要模板：判断「你交的报告是不是这次实验的」，最可靠的依据
 * 不是标题字符串相似度（写法五花八门：自己起名、写"实验X：xxx"、
 * 只写"实验二"），而是**教师给的模板里有哪些栏目**——你填的报告
 * 必然沿用同一套骨架。标题可能被改写，骨架很难被整体换掉。
 *
 * 模板本身是空白报告：栏目标题都在，栏目内容基本为空。
 * 但有两种情况模板里会有实义文本，价值极高：
 *   1. 「实验名称」栏若已被教师预填（如"实验2 PCA降维"），
 *      这就是**权威标题**，比条目名更准确；
 *   2. 模板正文里的说明性文字（"要求：本次实验针对……"）。
 *      这部分不是栏目内容，不能用来判断你写没写。
 *
 * @param {string} text 模板正文
 * @returns {{headings: string[], contentHeadings: string[], compareHeadings: string[],
 *            presetTitle: string, textLen: number}}
 */
export function extractTemplateSkeleton(text) {
  const squashed = String(text || '')
    .replace(/\s+/g, '')
    .replace(/　/g, '');
  // 模板用宽松匹配：表格转文本后标题与内容直接相接，严格正则会把大多数栏目漏掉
  const hits = findHeadings(squashed, HEADING_PATTERNS_LOOSE);

  // 去重保序：模板栏目顺序本身也携带信息（如"实验目的→内容→结果"）
  const headings = [];
  for (const hit of hits) {
    if (!headings.includes(hit.heading)) headings.push(hit.heading);
  }
  const contentHeadings = headings.filter((h) => CONTENT_HEADINGS.has(h));
  const compareHeadings = headings.filter((h) => !COMPARE_EXCLUDED.has(h));

  // 模板里「实验名称」后面若已有实义文字，就是教师预填的权威标题
  let presetTitle = '';
  const titleIdx = hits.findIndex((h) => h.heading === '实验名称');
  if (titleIdx >= 0) {
    const hit = hits[titleIdx];
    const next = hits[titleIdx + 1];
    let start = hit.idx + hit.heading.length;
    while (start < squashed.length && /[:：]/.test(squashed[start])) start += 1;
    const raw = stripPlaceholders(squashed.slice(start, next ? next.idx : undefined));
    // 模板里的填表提示不是标题："（请填写实验名称）""此处填写"等
    const isHint = /填写|请写|此处|请输入|待填/.test(raw);
    if (!isHint && countContent(raw) >= 2) {
      presetTitle = raw.replace(/[，,。;；:：]/g, '').trim().slice(0, 40);
    }
  }

  return { headings, contentHeadings, compareHeadings, presetTitle, textLen: countContent(squashed) };
}

/**
 * 把报告识别到的栏目与模板骨架比对（v1.2.24）。
 *
 * 返回值里的 `coverage` 是**模板栏目被报告覆盖的比例**，这是核心指标：
 *   - 高覆盖率 = 你确实按这份模板写的报告 → 交对了，
 *     此时标题措辞差异毫无意义，应当压掉 titleMismatch 的提示；
 *   - 低覆盖率 = 栏目骨架对不上，很可能交了别的实验报告。
 *
 * 判级刻意保守：只有模板栏目足够多（≥3）且覆盖率很低（<0.4）才降级，
 * 否则仅作参考信息——宁可少报，也不要再一次冤枉用户。
 *
 * @param {string[]|Set<string>} reportHeadings 报告里识别到的栏目名
 * @param {{compareHeadings?: string[], contentHeadings?: string[]}} template
 */
export function matchTemplate(reportHeadings, template) {
  const mine = reportHeadings instanceof Set ? reportHeadings : new Set(reportHeadings || []);
  // 优先用 compareHeadings（含实验目的/实验名称这类必填栏）；
  // 老调用方可能只传 contentHeadings，兼容之
  const tpl =
    template && Array.isArray(template.compareHeadings) && template.compareHeadings.length
      ? template.compareHeadings
      : template && Array.isArray(template.contentHeadings)
        ? template.contentHeadings
        : [];
  const total = tpl.length;
  if (!total) {
    return { usable: false, coverage: 0, covered: 0, total: 0, missing: [], level: null, note: '' };
  }
  const covered = tpl.filter((h) => mine.has(h));
  const missing = tpl.filter((h) => !mine.has(h));
  const coverage = covered.length / total;

  let level = null; // null = 不动判定，只作说明
  let note = '';
  if (coverage >= 0.6) {
    note = `与教师模板的栏目结构一致（${covered.length}/${total} 栏）`;
  } else if (total >= 3 && coverage < 0.4) {
    level = 'warn';
    note =
      `与教师模板的栏目结构差异较大（只对上 ${covered.length}/${total} 栏，` +
      `模板有「${missing.slice(0, 4).join('、')}」等栏目）`;
  } else {
    note = `与教师模板部分一致（${covered.length}/${total} 栏）`;
  }

  return { usable: true, coverage, covered: covered.length, total, missing, level, note };
}

/**
 * 分析 docx 文本。
 * @param {string} text
 * @param {{course?:string, title?:string}} item
 * @param {number} fileSize
 * @param {{headings?:string[], contentHeadings?:string[], presetTitle?:string}} [template]
 *        教师模板骨架（由 extractTemplateSkeleton 生成），没有模板时传 undefined
 */
export function analyzeReportText(text, item, fileSize, template) {
  // 去掉所有空白：docx 模板常用字间距排版，标题会被拆成“课 程 名 称”
  const squashed = String(text || '').replace(/\s+/g, '').replace(/　/g, '');
  const textLen = countContent(squashed);
  const hits = findHeadings(squashed);

  const sectionChars = new Map();
  const sectionRaw = new Map();
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    const next = hits[i + 1];
    // 内容从标题后开始；跳过紧随其后的冒号
    let start = hit.idx + hit.heading.length;
    while (start < squashed.length && /[:：]/.test(squashed[start])) start += 1;
    const content = squashed.slice(start, next ? next.idx : undefined);
    const cleaned = stripPlaceholders(content);
    const chars = countContent(cleaned);
    // 同名栏目取“内容最多”的一次（模板里可能出现多次）
    if (chars > (sectionChars.get(hit.heading) || 0)) {
      sectionChars.set(hit.heading, chars);
      sectionRaw.set(hit.heading, cleaned.slice(0, 60));
    } else if (!sectionChars.has(hit.heading)) {
      sectionChars.set(hit.heading, chars);
      sectionRaw.set(hit.heading, cleaned.slice(0, 60));
    }
  }

  const presentContent = [...sectionChars.entries()].filter(([h]) => CONTENT_HEADINGS.has(h));
  // 阈值：少于 10 个有效字符视为空（占位符已被剔除）
  const emptySections = presentContent.filter(([, chars]) => chars < 10).map(([h]) => h);
  const maxSection = presentContent.reduce((m, [, c]) => Math.max(m, c), 0);

  // 「实验总结 / 心得体会 / 结论」这类可选的收尾栏目：
  // 很多模板只要求部分栏目有内容，缺某个可选项不应判为「有问题」。
  // 只有当所有可选栏目都为空时才降级提示，且最多算「需人工确认」。
  const OPTIONAL_HEADINGS = new Set(['实验总结', '心得体会', '结论']);
  const requiredEmpty = emptySections.filter((h) => !OPTIONAL_HEADINGS.has(h));
  const optionalEmpty = emptySections.filter((h) => OPTIONAL_HEADINGS.has(h));

  // 课程名：兼容“课程名称：xxx”“课程：xxx”“课程名称xxx”
  const courseMatch = squashed.match(
    /课程名称[:：]?(.+?)(?:班级|学号|姓名|学院|专业|实验名称|指导教师|实验目的|$)/
  ) || squashed.match(/课程[:：](.+?)(?:班级|学号|姓名|学院|专业|实验名称|$)/
  );
  let reportCourse = courseMatch
    ? courseMatch[1].replace(/[，,。;；:：]/g, '').trim().slice(0, 24)
    : '';
  // 去掉多余的后缀（如"操作系统（2026年秋）"保留括号内的信息交给归一化处理）
  let courseOk = null;
  if (reportCourse && item && item.course) {
    const a = normalizeCourseName(reportCourse);
    const b = normalizeCourseName(item.course);
    courseOk = Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
    // 归一化后仍不匹配，且报告里课程名很短（可能被模板截断）→ 不做强判
    if (!courseOk && a.length < 2) {
      courseOk = null;
      reportCourse = '';
    }
  }

  const titleMatch = squashed.match(
    /实验名称[:：]?(.+?)(?:实验目的|实验原理|实验内容|实验要求|实验环境|$)/
  );
  let reportTitle = titleMatch
    ? titleMatch[1].replace(/[，,。;；:：]/g, '').trim().slice(0, 40)
    : '';

  // v1.2.24：模板骨架比对。有模板时，以模板为准。
  //
  // 模板的「实验名称」栏若已被教师预填，那是**权威标题**——
  // 比报告里自己写的那份更可信，也比条目名更贴近实验本身。
  //
  // 报告侧栏目名用宽松匹配再取一遍：你的报告也是表格转文本，
  // 「实验名称聚类算法实现实验目的1.掌握…」这类拼接同样匹配不到严格正则，
  // 只拿严格命中的栏目去比覆盖率会凭空低一半。
  const reportHeadings = new Set([
    ...sectionChars.keys(),
    ...findHeadings(squashed, HEADING_PATTERNS_LOOSE).map((h) => h.heading),
  ]);
  const templateMatch = template ? matchTemplate(reportHeadings, template) : null;
  const templateTitle = template && template.presetTitle ? String(template.presetTitle) : '';
  if (templateTitle && !reportTitle) reportTitle = templateTitle;

  // 模板已确认栏目结构对得上（v1.2.25）。
  // 用来压掉「未识别到标准实验栏目」——那句话和模板结论互相矛盾：
  // 表格转文本后栏目名与内容直接相接，严格正则抓不到，
  // 但宽松匹配明明命中了模板的 N/M 栏。
  const templateCovered = Boolean(
    templateMatch && templateMatch.usable && templateMatch.coverage >= 0.6
  );

  const reasons = [];
  let level = 'ok';

  if (requiredEmpty.length > 0) {
    level = 'bad';
    reasons.push(requiredEmpty.map((s) => `「${s}」为空`).join('、'));
  } else if (presentContent.length === 0) {
    const size = Number(fileSize) || 0;
    // v1.2.25：模板已确认栏目结构对得上，就不能再说「未识别到标准实验栏目」——
    // 上一版在这里输出过「未识别到标准实验栏目」+「与教师模板的栏目结构一致」
    // 两条互相矛盾的结论。真因是严格正则切不出表格转文本的栏目名，
    // 而模板比对用的是宽松匹配。此时改用总正文长度判定。
    if (templateCovered) {
      if (textLen < 80) {
        level = 'bad';
        reasons.push('模板的栏目结构能对上，但正文几乎没有内容');
      } else if (textLen < 200) {
        level = 'warn';
        reasons.push('正文内容较少，建议人工确认');
      }
      // 正文充足则保持 ok，模板比对的说明会在下文补上
    } else if (textLen < 80 && size > 0 && size < 60000) {
      level = 'bad';
      reasons.push('未识别到实验栏目，且文本极少');
    } else if (textLen < 80) {
      level = 'warn';
      reasons.push('文本很少，建议人工确认');
    } else {
      // 有实际内容但栏目结构不标准（手写报告 / 扫描件提取），不应判坏
      level = 'warn';
      reasons.push('未识别到标准实验栏目，正文有内容，建议人工确认');
    }
  } else if (maxSection < 20) {
    level = 'warn';
    reasons.push('各栏目内容都很少，建议人工确认');
  }

  // 可选收尾栏目为空：只在正文也很少时才提示，且不判坏
  if (optionalEmpty.length > 0 && requiredEmpty.length === 0) {
    const onlyOptional = optionalEmpty.join('、');
    if (maxSection < 60) {
      if (level === 'ok') level = 'warn';
      reasons.push(`可选栏目「${onlyOptional}」为空（正文较短，建议确认）`);
    } else if (level === 'ok') {
      // 正文充足，仅在说明里提一下，不改变判定
      reasons.push(`注：可选栏目「${onlyOptional}」为空，正文内容充足`);
    }
  }

  if (courseOk === false) {
    level = 'bad';
    reasons.push(`报告课程「${reportCourse}」与条目课程「${item.course}」不一致`);
  }

  // 报告标题与条目名字差异过大时提示（常见于提交了别的实验报告）。
  // v1.2.20：只提示、不再降级判定。原因是"实验名称"的写法五花八门
  // （自己起名、带小标题、写成"实验X：xxx"等），字符串相似度低并不代表交错。
  //
  // v1.2.24：有教师模板时，交给模板骨架判断，标题字符串法降到"仅参考"。
  // 栏目结构对得上就说明你按这份模板填的，标题怎么写都不影响结论——
  // 这正是之前人工智能实验二那条误报的来源。
  let titleMismatch = false;
  if (reportTitle && item && item.title) {
    const a = String(reportTitle).replace(/\s+/g, '');
    const b = String(item.title).replace(/\s+/g, '');
    if (a.length >= 3 && b.length >= 3 && !a.includes(b) && !b.includes(a)) {
      // 取两者共同的 2 字片段比例，太低的才算不匹配
      const grams = new Set();
      for (let i = 0; i + 2 <= a.length; i += 1) grams.add(a.slice(i, i + 2));
      let hit = 0;
      for (let i = 0; i + 2 <= b.length; i += 1) {
        if (grams.has(b.slice(i, i + 2))) hit += 1;
      }
      const ratio = hit / Math.max(1, b.length - 1);
      if (ratio < 0.2) {
        // 模板覆盖率够高 → 结构上没问题，标题差异只是措辞，不再提示
        const coveredByTemplate = templateMatch && templateMatch.usable && templateMatch.coverage >= 0.6;
        if (!coveredByTemplate) {
          titleMismatch = true;
          reasons.push(
            `报告里写的实验名称是「${reportTitle}」，作业标题是「${item.title}」，` +
              '写法不一致。这只表示标题措辞不同，不代表交错——请点开页面自行核对。'
          );
        }
      }
    }
  }

  // 模板比对结论：只在对不上时降级，对得上时补一句说明让人放心
  if (templateMatch && templateMatch.usable) {
    if (templateMatch.level === 'warn') {
      if (level === 'ok') level = 'warn';
      reasons.push(templateMatch.note);
    } else if (templateMatch.coverage >= 0.6) {
      reasons.push(templateMatch.note);
    }
  }

  return {
    textLen,
    reportCourse,
    courseMatch: courseOk,
    reportTitle,
    templateTitle,
    titleMismatch,
    template: templateMatch,
    sections: [...sectionChars.entries()].map(([name, chars]) => ({ name, chars })),
    emptySections: requiredEmpty,
    optionalEmptySections: optionalEmpty,
    level,
    reasons,
  };
}

/**
 * 从题目区附件里挑出一份教师模板，提取其栏目骨架（v1.2.24）。
 *
 * 题目区可能有多个附件：报告模板 docx、数据集 txt、实验指导 pdf……
 * 只有「能解析出正文、且识别到 ≥2 个实验栏目」的才可能是报告模板。
 * 数据集/说明文档的栏目结构完全不同，不会被误选。
 *
 * 若有多份候选，取栏目最多的一份——模板通常是结构最完整的那份。
 *
 * @param {Array<{text?:string, name?:string, kind?:string}>} questionAtts
 * @returns {{headings:string[],contentHeadings:string[],presetTitle:string,textLen:number}|null}
 */
export function pickTemplateSkeleton(questionAtts) {
  const list = Array.isArray(questionAtts) ? questionAtts : [];
  let best = null;
  for (const att of list) {
    const text = String((att && att.text) || '');
    if (!text) continue;
    // 只考虑文档类（docx/doc/pdf），压缩包和图片跳过
    const kind = String((att && att.kind) || '').toLowerCase();
    if (kind && !['docx', 'doc', 'pdf'].includes(kind)) continue;
    const skeleton = extractTemplateSkeleton(text);
    // 识别不到栏目结构的就不是报告模板
    if (skeleton.headings.length < 2) continue;
    if (!best || skeleton.headings.length > best.headings.length) best = skeleton;
  }
  return best;
}

/**
 * 在电脑版作业详情页执行：提取附件元数据、文本答案，并取每个附件的状态
 * （文件名/大小/下载直链）。**不下载附件本身**。
 *
 * 为什么 status 必须在这里取：
 * 学习通的 `/ananas/status/<objectid>` 有防盗链校验，从 service worker 直接请求会返回 403；
 * 在页面内同源请求（自动带 Referer 与 cookie）才能拿到下载地址。
 *
 * 为什么下载不在这里做：
 * 学习通 CDN 返回 `Access-Control-Allow-Origin: *`，页面内带 credentials 的跨域请求
 * 会被浏览器直接拒绝（`Failed to fetch`）；下载直链是签名 URL，由 service worker
 * 带 host_permissions 请求不受 CORS 限制，稳定可靠。
 *
 * 必须自包含（会被序列化注入页面）。
 */
export function pageInspectReport() {
  return (async () => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const params = new URL(location.href).searchParams;
    const out = {
      ok: true,
      url: location.href,
      courseId: params.get('courseId') || '',
      classId: params.get('classId') || '',
      workId: params.get('workId') || '',
      answerId: params.get('answerId') || '',
      pageTitle: clean(document.title),
      textAnswer: '',
      attachments: [],
      pageSignals: {},
    };

    // 文本答案（附件 iframe 的内容不会进入 innerText）
    //
    // v1.2.22：同样要遍历同源 iframe 内部文档——作答区常整个渲染在 iframe 里，
    // 只查主文档会导致 6 条结果 textAnswerLen 全为 0。
    const TEXT_SEL = 'dd.stuAnswerContent, dd.textwrap, .mark_answer dd, .mark_answer .textwrap';
    const collectTexts = (doc, depth) => {
      const acc = [];
      if (!doc || depth > 2) return acc;
      for (const el of doc.querySelectorAll(TEXT_SEL)) {
        const t = clean(el.innerText);
        if (t) acc.push(t);
      }
      for (const frame of doc.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) acc.push(...collectTexts(frame.contentDocument, depth + 1));
        } catch {
          /* 跨域，忽略 */
        }
      }
      return acc;
    };
    const texts = collectTexts(document, 0);
    out.textAnswer = [...new Set(texts)].join('\n').slice(0, 6000);

    // 页面信号：判断这是「已提交只读视图」还是「仍可作答」。
    // 注意：只看“有没有提交按钮”容易误判——已提交页面也可能保留“重新提交”。
    // 因此以“是否存在已提交痕迹”为主，提交按钮为辅。
    const bodyText = document.body ? String(document.body.innerText || '') : '';
    const hasSubmitTraces =
      /已提交|已交卷|提交时间|我的答案|已批阅|待批阅|批阅中|成绩|评语|重新提交|重交/.test(bodyText);
    const hasAnswerBlocks =
      document.querySelectorAll('dd.stuAnswerContent, dd.textwrap, .mark_answer dd').length > 0;
    const hasAttachments =
      document.querySelectorAll('iframe.attach-iframe, iframe[objectid]').length > 0;
    const hasSubmitButton = /提交作业|开始作答|保存并提交/.test(bodyText);

    out.pageSignals = {
      submitted: hasSubmitTraces || hasAnswerBlocks || hasAttachments,
      hasSubmitTraces,
      hasAnswerBlocks,
      hasAttachments,
      hasSubmitButton,
      urlHasView: /\/mooc2\/work\/view\b/i.test(location.href),
      urlHasDowork: /\/mooc2\/work\/dowork\b/i.test(location.href),
      textLen: bodyText.length,
      snippet: bodyText.slice(0, 200),
    };

    // 判断附件属于「题目区」还是「作答区」。
    //
    // 学习通详情页里两类附件的 DOM 位置不同：
    //   题目区（教师给的材料：模板 docx、数据集 txt）：直接挂在题干下
    //   作答区（学生自己交的文件）：在富文本编辑器容器内，或 .mark_answer 里
    //
    // v1.2.23 关键修正：必须**两趟扫描**。
    // 真实页面里整个题目（题干 + 作答编辑器）都包在 `.TiMu` / `.questionLi` 里，
    // 若只做一趟"从近到远找第一个命中"，作答区附件会先撞到外层的 `.TiMu` 被判成
    // question 而丢弃——这正是「机器学习实验2 明明交了却识别不到」的直接原因。
    // 先找作答区容器（更近、更具体），找不到再退到题目区容器。
    const ZONE_ANSWER_RE =
      /(mark_answer|stuanswer|stu_answer|answercontent|myanswer|answersheet|edui|ueditor|ans-editor|ans-attach-ct|ans-insertfile|froala|(?:^|[\s_-])answer(?:$|[\s_-]))/i;
    const ZONE_QUESTION_RE =
      /(questionli|timu|mark_item|mark_name|mark_description|questionitem|question_?list)/i;
    const zoneOfNode = (node, inheritedZone) => {
      const tokenOf = (el) => {
        try {
          return (String(el.className || '') + ' ' + String(el.id || '')).trim();
        } catch {
          return '';
        }
      };
      // 第一趟：作答区 / 富文本编辑器容器（离节点最近的优先）
      let cur = node;
      for (let depth = 0; cur && depth < 20; depth += 1) {
        const token = tokenOf(cur);
        if (token && ZONE_ANSWER_RE.test(token)) return 'answer';
        cur = cur.parentElement;
      }
      // 第二趟：题目区容器
      cur = node;
      for (let depth = 0; cur && depth < 20; depth += 1) {
        const token = tokenOf(cur);
        if (token && ZONE_QUESTION_RE.test(token)) return 'question';
        cur = cur.parentElement;
      }
      // 向上找不到区域标记时，继承外层容器的判断：
      // 一个位于作答区里的 iframe，其内部附件也应算作答区。
      return inheritedZone || 'unknown';
    };

    // 附件元数据（同一文件名只保留信息最完整的一条）
    // 学习通不同模板写法不同：iframe.attach-iframe、[data*=objectid]、
    // 或把 objectid 直接写在其他元素的属性里，这里多路采集避免漏读。
    const seen = new Map();
    const pushAtt = (objectid, name, type, filesize, zone) => {
      if (!objectid && !name) return;
      // 去重键必须优先用 objectid，而不是文件名。
      //
      // v1.2.23 真 bug：题目区和作答区**常常是同名文件**——
      // 教师发的模板叫「2.降维-机器学习实验报告.docx」（23.18K），
      // 你交的也叫「2.降维-机器学习实验报告.docx」（82.29K）。
      // 旧代码用 name 作 key，后到的作答区那条被并进题目区那条，
      // 保留下来的还是 question（教师材料），于是永远「找不到你提交的附件」。
      // 用 objectid 作 key 后，两个不同文件天然分开。
      const key = objectid || name;
      const prev = seen.get(key);
      const prevSize = prev ? Number(String(prev.filesize || '').replace(/[^\d.]/g, '')) || 0 : -1;
      const size = Number(String(filesize || '').replace(/[^\d.]/g, '')) || 0;
      const prevZone = prev && prev.zone ? prev.zone : 'unknown';
      const nextZone = zone || 'unknown';
      // 区域信息比文件大小更可靠：HTML 兜底捞出来的是 unknown，
      // 若之后从 DOM 里读到了明确区域，就用明确的那次覆盖。
      const preferZone = prevZone === 'unknown' && nextZone !== 'unknown';
      const sameZoneBetter = prevZone === nextZone && size > prevSize;
      if (!prev || preferZone || sameZoneBetter) {
        seen.set(key, {
          objectid: objectid || (prev ? prev.objectid : ''),
          name: name || (prev ? prev.name : ''),
          type: type || (prev ? prev.type : ''),
          filesize: filesize || (prev ? prev.filesize : ''),
          zone: nextZone,
        });
      }
    };

    // 1) 标准附件 iframe
    for (const frame of document.querySelectorAll('iframe.attach-iframe, iframe[objectid]')) {
      pushAtt(
        frame.getAttribute('objectid') || '',
        frame.getAttribute('filename') || frame.getAttribute('data-name') || '',
        String(frame.getAttribute('filetype') || '').replace(/^\./, '').toLowerCase(),
        frame.getAttribute('filesize') || '',
        zoneOfNode(frame)
      );
    }

    // 2) 带 data JSON 的附件节点
    for (const el of document.querySelectorAll('.ans-attach-online, [data*="objectid"]')) {
      const dataAttr = el.getAttribute('data') || el.getAttribute('data-attach') || '';
      let parsed = null;
      if (dataAttr) {
        try {
          parsed = JSON.parse(dataAttr);
        } catch {
          parsed = null;
        }
      }
      if (parsed && (parsed.objectid || parsed.name)) {
        pushAtt(
          String(parsed.objectid || ''),
          String(parsed.name || ''),
          String(parsed.type || '').replace(/^\./, '').toLowerCase(),
          String(parsed.size || ''),
          zoneOfNode(el)
        );
        continue;
      }
      pushAtt(
        el.getAttribute('objectid') || '',
        el.getAttribute('filename') || el.getAttribute('data-name') || '',
        String(el.getAttribute('filetype') || '').replace(/^\./, '').toLowerCase(),
        el.getAttribute('filesize') || '',
        zoneOfNode(el)
      );
    }

    // 3) 遍历同源 iframe 内部文档
    //
    // v1.2.22 关键补充：作答区（学生提交的附件）常常渲染在 iframe 里，
    // 主文档的 querySelectorAll 看不到它，HTML 兜底正则也捞不到——
    // 于是出现「只采到题目区模板、采不到我的报告」。
    // iframe 与主页面同源时 contentDocument 可直接访问，用它补采。
    //
    // v1.2.23：富文本编辑器的编辑区也是 iframe（src 是 javascript:void(...)），
    // 学生提交的附件就嵌在里面。这类 iframe 的 document 会异步重写，
    // 刚读时可能是空的，因此对"空文档"做一次短轮询重试。
    //
    // 跨域 iframe 会抛 SecurityError，逐个 try 并记录诊断。
    const iframeScan = {
      total: 0,
      sameOrigin: 0,
      crossOrigin: 0,
      scanned: 0,
      found: 0,
      emptyRetried: 0,
    };
    const ATT_SEL =
      'iframe.attach-iframe, iframe[objectid], .ans-attach-online, [data*="objectid"], [objectid]' +
      ', a[href*="objectid"], [onclick*="objectid"]';
    const countAttNodes = (doc) => {
      try {
        return doc ? doc.querySelectorAll(ATT_SEL).length : 0;
      } catch {
        return 0;
      }
    };
    const collectFromDoc = (doc, inheritedZone, depth, frameEl) => {
      if (!doc || depth > 3) return;
      // 编辑区 iframe 常延迟写入：先按"节点数为 0 且带 body"判定为空，交给外层重试
      const nodes = doc.querySelectorAll(ATT_SEL);
      for (const el of nodes) {
        if (el.tagName === 'IFRAME') {
          // 嵌套 iframe 递归（学习通的附件预览框里还会再套一层）
          try {
            const inner = el.contentDocument;
            if (inner) collectFromDoc(inner, zoneOfNode(el, inheritedZone) === 'answer' ? 'answer' : inheritedZone, depth + 1, el);
          } catch {
            /* 跨域，忽略 */
          }
        }
        const dataAttr = el.getAttribute('data') || el.getAttribute('data-attach') || '';
        let parsed = null;
        if (dataAttr) {
          try {
            parsed = JSON.parse(dataAttr);
          } catch {
            parsed = null;
          }
        }
        // 区域判定：优先用 frameEl（外层 iframe 所在的容器），
        // 因为编辑区内部的元素没有区域类名，只有外层容器有。
        const z = frameEl ? zoneOfNode(frameEl, inheritedZone) : zoneOfNode(el, inheritedZone);
        const before = seen.size;
        if (parsed && (parsed.objectid || parsed.name)) {
          pushAtt(
            String(parsed.objectid || ''),
            String(parsed.name || ''),
            String(parsed.type || '').replace(/^\./, '').toLowerCase(),
            String(parsed.size || ''),
            z
          );
        } else {
          pushAtt(
            el.getAttribute('objectid') || '',
            el.getAttribute('filename') || el.getAttribute('data-name') || '',
            String(el.getAttribute('filetype') || '').replace(/^\./, '').toLowerCase(),
            el.getAttribute('filesize') || '',
            z
          );
        }
        if (seen.size > before) iframeScan.found += 1;
      }
    };
    const frames = [...document.querySelectorAll('iframe')];
    iframeScan.total = frames.length;
    const frameDocs = [];
    for (const frame of frames) {
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch {
        doc = null;
      }
      if (!doc) {
        iframeScan.crossOrigin += 1;
        continue;
      }
      iframeScan.sameOrigin += 1;
      frameDocs.push({ frame, doc });
    }
    // 第一轮：立刻采集
    for (const { frame, doc } of frameDocs) {
      const outerZone = zoneOfNode(frame);
      try {
        collectFromDoc(doc, outerZone === 'unknown' ? '' : outerZone, 0, frame);
        iframeScan.scanned += 1;
      } catch {
        /* 忽略单帧失败 */
      }
    }
    // 第二轮：对"有 body 但一个附件节点都没有"的帧重试几次。
    // 富文本编辑区（javascript:void iframe）就是这样异步填充的。
    const emptyFrames = frameDocs.filter(({ doc }) => {
      try {
        return countAttNodes(doc) === 0 && doc.body;
      } catch {
        return false;
      }
    });
    if (emptyFrames.length) {
      iframeScan.emptyRetried = emptyFrames.length;
      for (let round = 0; round < 3; round += 1) {
        await new Promise((r) => setTimeout(r, 350));
        for (const { frame, doc } of emptyFrames) {
          const before = iframeScan.found;
          const outerZone = zoneOfNode(frame);
          try {
            collectFromDoc(doc, outerZone === 'unknown' ? '' : outerZone, 0, frame);
          } catch {
            /* 忽略 */
          }
          if (iframeScan.found > before) iframeScan.retryHit = true;
        }
        if (iframeScan.retryHit) break;
      }
    }

    // 3b) 从 HTML 兜底捞 objectid + 文件名（含 iframe 内部 HTML）
    //
    // 为什么要分帧单独处理：富文本编辑区里的附件是异步写进 iframe 的
    // innerHTML 的，DOM 节点可能来不及出现，但 HTML 里已经有 objectid。
    // 分帧处理才能给它标上正确的区域（answer），否则又会当成题目区材料。
    const htmlChunks = [{ html: document.documentElement ? document.documentElement.innerHTML : '', zone: '' }];
    for (const { frame, doc } of frameDocs) {
      try {
        if (doc && doc.documentElement) {
          const z = zoneOfNode(frame);
          htmlChunks.push({ html: doc.documentElement.innerHTML, zone: z === 'unknown' ? '' : z });
        }
      } catch {
        /* 跨域，忽略 */
      }
    }
    // 同时兼容「objectid 在前、文件名在后」和「文件名在前、objectid 在后」两种渲染顺序。
    const fileExtRe = String.raw`[^"',}<]{1,120}\.(?:docx?|pdf|zip|rar|pptx?|xlsx?)`;
    const fwdRe = new RegExp(
      String.raw`objectid["'\s:=]+([0-9a-f]{32})[^}]{0,600}?(?:name|filename)["'\s:=]+(` + fileExtRe + ')',
      'gi'
    );
    const revRe = new RegExp(
      '(' + fileExtRe + String.raw`)[^}]{0,600}?objectid["'\s:=]+([0-9a-f]{32})`,
      'gi'
    );
    for (const chunk of htmlChunks) {
      const zone = chunk.zone || '';
      let m;
      while ((m = fwdRe.exec(chunk.html)) !== null) {
        pushAtt(m[1], m[2].trim(), '', '', zone);
      }
      while ((m = revRe.exec(chunk.html)) !== null) {
        pushAtt(m[2], m[1].trim(), '', '', zone);
      }
    }

    // 4) 页面内取附件状态 + 下载成 base64
    //
    // 为什么都在页面内：
    // - `/ananas/status/` 有防盗链，service worker 直接请求返回 403；
    // - 返回的签名下载链接常指向 `d0.cldisk.com`（非 chaoxing 域名），
    //   service worker 请求缺少该站点的 cookie/referer 也会 403；
    // - 页面内同源/带站点上下文的 fetch 与用户手动点击下载等价，最可靠。
    const MAX_BYTES = 20 * 1024 * 1024;
    const toBase64 = (bytes) => {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(i, Math.min(i + chunk, bytes.length))
        );
      }
      return btoa(binary);
    };

    const list = [...seen.values()];
    for (const att of list) {
      if (!att.objectid) continue;
      try {
        const res = await fetch(
          'https://mooc1.chaoxing.com/ananas/status/' +
            encodeURIComponent(att.objectid) +
            '?flag=normal',
          { credentials: 'include' }
        );
        if (!res.ok) {
          att.statusError = 'HTTP ' + res.status;
          continue;
        }
        const status = await res.json();
        if (status.filename) att.name = String(status.filename);
        att.size = Number(status.length) || 0;
        let download = String(status.download || '').replace(/^http:\/\//i, 'https://');
        att.download = download;
        if (!download) {
          att.statusError = '接口未返回下载地址';
          continue;
        }

        const lowerName = String(att.name || '').toLowerCase();
        const supported =
          /\.(docx?|pdf)$/i.test(lowerName) || ['doc', 'docx', 'pdf'].includes(att.type);
        if (!supported) continue;
        if (att.size > MAX_BYTES) {
          att.downloadError = '附件超过 20MB';
          continue;
        }

        // 多策略下载。
        //
        // 背景：签名链接指向 `d0.cldisk.com`，该域返回通配 CORS 头，
        // 页面内带 credentials 的 fetch 会被浏览器拒绝（Failed to fetch）；
        // 但不带 credentials 又可能缺 cookie 导致 403。
        // 因此依次尝试：
        //  1) XHR（页面上下文，自动带同源 cookie，且对 cldisk 这类公共 CDN 通常可直接读 blob）
        //  2) fetch + omit
        //  3) fetch + include
        //  4) 若 status 返回了 pdf 字段，改试 pdf 地址（PDF 也能提取文本）
        const tried = [];
        const candidates = [];
        if (download) {
          candidates.push({ url: download, tag: 'xhr-pkg', how: 'xhr' });
          candidates.push({ url: download, tag: 'fetch-omit', how: 'fetch', credentials: 'omit' });
        }
        const pdfUrl = String(status.pdf || '').replace(/^http:\/\//i, 'https://');
        if (pdfUrl && pdfUrl !== download) {
          att.pdfUrl = pdfUrl;
          candidates.push({ url: pdfUrl, tag: 'xhr-pdf', how: 'xhr' });
          candidates.push({ url: pdfUrl, tag: 'fetch-pdf', how: 'fetch', credentials: 'omit' });
        }

        for (const cand of candidates) {
          try {
            let buf = null;
            if (cand.how === 'xhr') {
              buf = await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', cand.url, true);
                xhr.responseType = 'arraybuffer';
                xhr.timeout = 25000;
                xhr.onload = () => {
                  if (xhr.status >= 200 && xhr.status < 300 && xhr.response && xhr.response.byteLength) {
                    resolve(new Uint8Array(xhr.response));
                  } else {
                    resolve(null);
                  }
                };
                xhr.onerror = () => resolve(null);
                xhr.ontimeout = () => resolve(null);
                try {
                  xhr.send();
                } catch {
                  resolve(null);
                }
              });
              if (buf) {
                att.base64 = toBase64(buf);
                att.downloadVia = cand.tag;
                att.downloadUrlUsed = cand.url;
                tried.push(cand.tag + '=ok');
                break;
              }
              tried.push(cand.tag + '=fail');
              continue;
            }
            const r2 = await fetch(cand.url, {
              credentials: cand.credentials,
              mode: 'cors',
              cache: 'no-store',
            });
            if (!r2.ok) {
              tried.push(cand.tag + '=HTTP' + r2.status);
              continue;
            }
            const ab = await r2.arrayBuffer();
            if (!ab || ab.byteLength === 0) {
              tried.push(cand.tag + '=empty');
              continue;
            }
            att.base64 = toBase64(new Uint8Array(ab));
            att.downloadVia = cand.tag;
            att.downloadUrlUsed = cand.url;
            tried.push(cand.tag + '=ok');
            break;
          } catch (e) {
            tried.push(cand.tag + '=' + (e && e.name ? e.name : 'err'));
          }
        }
        if (!att.base64) att.downloadError = '全部下载方式失败（' + tried.join('，') + '）';
      } catch (e) {
        att.downloadError = String(e && e.message ? e.message : e);
      }
    }

    out.attachments = list;
    out.debug = {
      attachIframes: document.querySelectorAll('iframe.attach-iframe').length,
      objectidNodes: document.querySelectorAll('[objectid]').length,
      dataNodes: document.querySelectorAll('[data*="objectid"]').length,
      // 诊断用：v1.2.22 起记录真实 DOM 结构，便于定位「作答区附件采不到」。
      // 只保留少量样本并截断，避免把 storage 撑爆。
      totalIframes: document.querySelectorAll('iframe').length,
      iframeScan,
      iframeSrcs: [...document.querySelectorAll('iframe')]
        .slice(0, 8)
        .map((f) => String(f.getAttribute('src') || '').slice(0, 120)),
      answerSels: {
        markAnswer: document.querySelectorAll('.mark_answer').length,
        stuAnswerContent: document.querySelectorAll('dd.stuAnswerContent').length,
        textwrap: document.querySelectorAll('dd.textwrap').length,
        markItem: document.querySelectorAll('.mark_item').length,
        markTable: document.querySelectorAll('.mark_table').length,
        TiMu: document.querySelectorAll('.TiMu').length,
        questionLi: document.querySelectorAll('.questionLi').length,
        ansAttachOnline: document.querySelectorAll('.ans-attach-online').length,
        ansAttachCt: document.querySelectorAll('.ans-attach-ct').length,
      },
      // 每个附件判定的区域（answer/question/unknown），看清采集结果的分布
      attZones: [...seen.values()].slice(0, 8).map((a) => a.zone || 'unknown'),
    };
    return out;
  })();
}

/**
 * 把页面结构诊断数据翻译成一句人话。
 *
 * 用途：当判定为「没找到你提交的东西」时，同时告诉用户页面长什么样，
 * 例如「页面上有 3 个 iframe，作答区选择器 .mark_answer 命中 0 个」——
 * 这直接指出是选择器不匹配，还是内容根本不在主文档里。
 *
 * @param {object} debug pageInspectReport 返回的 debug
 * @returns {string} 空字符串表示没有可用信息
 */
export function describePageDebug(debug) {
  if (!debug || typeof debug !== 'object') return '';
  const parts = [];
  const iframes = Number(debug.totalIframes) || 0;
  if (iframes > 0) {
    const st = debug.iframeScan || {};
    parts.push(
      `页面含 ${iframes} 个 iframe（同源 ${
        Number(st.sameOrigin) ? st.sameOrigin : 0
      }、跨域 ${Number(st.crossOrigin) || 0}，从中补采到 ${Number(st.found) || 0} 个附件）`
    );
  }
  const sels = debug.answerSels || {};
  const hasSelData = Object.keys(sels).length > 0;
  const hit = [];
  const miss = [];
  const LABELS = {
    markAnswer: '.mark_answer',
    stuAnswerContent: 'dd.stuAnswerContent',
    textwrap: 'dd.textwrap',
    markItem: '.mark_item',
    markTable: '.mark_table',
    TiMu: '.TiMu',
    questionLi: '.questionLi',
    ansAttachOnline: '.ans-attach-online',
    ansAttachCt: '.ans-attach-ct',
  };
  if (hasSelData) {
    for (const [key, label] of Object.entries(LABELS)) {
      const n = Number(sels[key]) || 0;
      if (n > 0) hit.push(`${label}×${n}`);
      else miss.push(label);
    }
    if (hit.length) parts.push('命中 ' + hit.join('、'));
    if (miss.length && hit.length === 0) {
      parts.push('全部作答区选择器均未命中（' + miss.join('、') + '）');
    }
  }
  return parts.length ? '页面结构：' + parts.join('；') : '';
}

/**
 * 执行检查。
 * @param {Array} items 最近一次扫描的条目
 * @param {(p:{done:number,total:number,message:string})=>void} [onProgress]
 * @param {{includePastDeadline?:boolean}} [options]
 * @returns {Promise<Array>} 检查结果
 */
export async function runReportCheck(items, onProgress = () => {}, options = {}) {
  const now = Date.now();
  const includePast = options.includePastDeadline === true;

  // 只检查「已提交」的实验类作业。
  // 默认跳过：① 已过截止时间；② 截止时间无法确定（deadline=null 通常就是过期作业）；
  //          ③ 已进入互评阶段（互评的"剩余时间"不是提交截止时间）。
  // 若用户勾选「包含已过截止时间的作业」，则全部纳入。
  const labItems = (items || []).filter((item) => isLabReportItem(item));
  const candidates = labItems.filter((item) => {
    if (includePast) return true;
    // 互评阶段：提交窗口已关，没有「还没交的报告」可查。
    // 但去重后若同一条还有一份「非互评」记录（deadline=null 的那条），
    // 会走 isPastDeadline 被跳过——这正是我们要的行为。
    if (isPeerReviewItem(item)) return false;
    return !isPastDeadline(item, now);
  });
  const skippedPast = labItems.length - candidates.length;
  if (onProgress && skippedPast > 0) {
    onProgress({
      done: 0,
      total: 0,
      message: `已跳过 ${skippedPast} 份已截止/互评中/截止时间未知的报告`,
      skippedPast,
    });
  }

  // 去重：同一份报告可能以不同 key 出现（聚合页里既算课程作业、又出现在其它任务里），
  // 导致「同一条被检查两遍且内容不同」。按「课程 + 标题」归一化后去重。
  const dedupSeen = new Set();
  const dedupKeyOf = (item) => {
    const course = normalizeCourseName(item.course || '');
    const title = String(item.title || '')
      .replace(/\s+/g, '')
      .replace(/[（(].*?[)）]/g, '')
      .toLowerCase();
    return course + '|' + title;
  };
  const selected = [];
  for (const item of candidates) {
    const k = dedupKeyOf(item);
    if (dedupSeen.has(k)) continue;
    dedupSeen.add(k);
    selected.push(item);
  }
  const dedupRemoved = candidates.length - selected.length;

  const results = [];
  if (!selected.length) {
    if (skippedPast > 0) {
      onProgress({
        done: 0,
        total: 0,
        message:
          `本次没有需要检查的报告（${skippedPast} 份已截止或截止时间未知，默认跳过）。` +
          '如需检查历史报告，请打开「包含已过截止时间的作业」。',
        skippedPast,
        noCandidate: true,
      });
    }
    return results;
  }
  clearDesktopCache();

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (!tab || tab.id == null) throw new Error('无法创建检查标签页');

    for (let i = 0; i < selected.length; i += 1) {
      const item = selected[i];
      const base = {
        key: item.key,
        course: item.course || '',
        title: item.title || '',
        status: item.status || '',
        deadline: typeof item.deadline === 'number' ? item.deadline : null,
        deadlineText: item.deadlineText || '',
        url: item.url || '',
        attachments: [],
        textAnswerLen: 0,
        level: 'unknown',
        reasons: [],
        analysis: null,
      };
      onProgress({
        done: i,
        total: selected.length,
        message: `检查「${item.title || '实验报告'}」…`,
      });

      try {
        const params = paramsFromItemUrl(item.url, false);
        if (!params.cpi) {
          params.cpi = await fetchCourseCpi(
            params.courseId,
            params.classId || params.clazzId
          );
        }
        // 后台 fetch 拿不到时，退回在详情页里请求课程列表
        if (!params.cpi && params.courseId) {
          const wait = waitForTabComplete(tab.id, 20000);
          await chrome.tabs.update(tab.id, { url: item.url });
          const nav = await wait;
          if (nav && nav.ok) {
            const courses = await execInTab(tab.id, pageFetchCourses, []);
            if (courses && courses.ok && Array.isArray(courses.courses)) {
              const classId = params.classId || params.clazzId || '';
              const match = courses.courses.find(
                (c) =>
                  String(c.courseId) === String(params.courseId) &&
                  (!classId || String(c.classId) === String(classId))
              );
              if (match && match.cpi) params.cpi = String(match.cpi);
            }
          }
        }
        if (!params.courseId || !params.workId) {
          base.reasons.push('条目缺少课程/作业信息');
          results.push(base);
          continue;
        }
        if (!params.cpi) {
          base.reasons.push('无法获取课程 cpi');
          results.push(base);
          continue;
        }

        const viewUrl = await resolveDesktopTask(tab.id, params, 'work');
        if (!viewUrl) {
          base.level = 'unknown';
          base.reasons.push('无法打开作业详情页（电脑版列表里没找到该作业）');
          base.hint = '可能是作业已被教师关闭，或学习通列表结构与预期不同';
          results.push(base);
          continue;
        }
        // 校验：详情页确实属于当前条目。
        // 之前出现过"操作系统的实验四"却读到"机器学习实验1"的情况——
        // 电脑版列表搜索是按 id 匹配的，若不同课程的作业 id 相同/被误命中就会串号。
        const urlParams2 = new URL(viewUrl).searchParams;
        const viewCourseId = urlParams2.get('courseId') || '';
        const expectCourseId = String(params.courseId || '');
        if (viewCourseId && expectCourseId && viewCourseId !== expectCourseId) {
          base.level = 'unknown';
          base.reasons.push(
            '打开的详情页属于其它课程（courseId 不匹配），已跳过以避免误判'
          );
          base.hint = '可能是学习通列表结构异常，请手动确认该作业';
          base.diagnostics = base.diagnostics || [];
          base.diagnostics.push({
            step: 'course-mismatch',
            error: '期望 courseId=' + expectCourseId + '，实际=' + viewCourseId,
          });
          results.push(base);
          continue;
        }
        base.viewCourseId = viewCourseId;

        base.viewUrl = viewUrl;
        const isReadonlyView = /\/mooc-ans\/mooc2\/work\/view\b/i.test(viewUrl);

        const info = await execInTab(tab.id, pageInspectReport, []);
        if (!info || !info.ok) {
          base.reasons.push('读取提交内容失败');
          results.push(base);
          continue;
        }

        // 诊断信息（页面 DOM 结构快照）：先在结果里留底，文案在构造完附件后统一生成。
        // 一条作业的 debug 最多几百字节，只保留有用字段，避免把 storage 撑爆。
        if (info.debug && typeof info.debug === 'object') {
          base.pageDebug = info.debug;
        }

        // 用页面实际内容判断是否已提交（比 URL 更可靠：有些已提交作业仍落在 dowork）
        const signals = info.pageSignals || {};
        const submittedByPage =
          signals.submitted === true ||
          signals.urlHasView === true ||
          isReadonlyView ||
          (Array.isArray(info.attachments) && info.attachments.length > 0) ||
          String(info.textAnswer || '').trim().length > 0;

        if (!submittedByPage) {
          base.level = 'warn';
          base.reasons.push(
            '学习通详情页未显示已提交内容，与列表状态「' +
              (item.status || '未知') +
              '」不一致'
          );
          base.hint = '请在学习通里确认该作业的提交状态';
          results.push(base);
          continue;
        }

        base.textAnswerLen = String(info.textAnswer || '').replace(/\s+/g, '').length;

        // 附件：页面已取到状态并下载成 base64（见 pageInspectReport 注释），这里只解析正文
        const parsedAttachments = [];
        const metaAttachments = Array.isArray(info.attachments) ? info.attachments : [];
        for (const att of metaAttachments) {
          const entry = {
            name: att.name || '',
            type: att.type || '',
            size: Number(att.size) || 0,
            kind: '',
            method: '',
            textLen: 0,
            text: '',
            error: '',
            zone: att.zone || 'unknown',
          };

          if (att.statusError) {
            entry.error = '附件状态获取失败：' + att.statusError;
            base.diagnostics = base.diagnostics || [];
            base.diagnostics.push({
              step: 'status',
              objectid: String(att.objectid || '').slice(0, 8) + '…',
              error: att.statusError,
            });
            parsedAttachments.push(entry);
            continue;
          }

          const lowerName = String(entry.name || '').toLowerCase();
          const supported =
            /\.(docx?|pdf)$/i.test(lowerName) || ['doc', 'docx', 'pdf'].includes(entry.type);
          const isZip = /\.(zip|rar|7z)$/i.test(lowerName) || ['zip', 'rar', '7z'].includes(entry.type);

          if (!supported) {
            entry.kind = isZip ? 'zip' : entry.type || 'other';
            parsedAttachments.push(entry);
            continue;
          }

          if (att.downloadError) {
            // 页面内下载失败 → 用 service worker 兜底重试一次（已加 cldisk.com 权限）
            let retried = false;
            if (att.download) {
              const dl = await fetchAttachmentBytes(att.download);
              if (dl.ok) {
                try {
                  const parsed = await extractAttachmentText(dl.buffer, entry.name, entry.type);
                  entry.kind = parsed.kind || entry.kind;
                  entry.method = parsed.method;
                  entry.text = String(parsed.text || '').slice(0, 30000);
                  entry.textLen = entry.text.replace(/\s+/g, '').length;
                  if (!parsed.ok) entry.error = entry.error || '未能提取正文';
                  retried = true;
                } catch (e) {
                  entry.error = '正文解析失败：' + String(e && e.message ? e.message : e);
                  retried = true;
                }
              }
            }
            if (!retried) {
              entry.error = '下载失败：' + att.downloadError;
              base.diagnostics = base.diagnostics || [];
              base.diagnostics.push({
                step: 'download',
                url: String(att.download || '').slice(0, 120),
                error: att.downloadError + '（页面内与后台均失败）',
              });
            }
            parsedAttachments.push(entry);
            continue;
          }

          if (!att.base64) {
            entry.error = '附件未下载到内容（可能被教师关闭下载）';
            parsedAttachments.push(entry);
            continue;
          }

          try {
            const binary = atob(att.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            const parsed = await extractAttachmentText(bytes.buffer, entry.name, entry.type);
            entry.kind = parsed.kind || entry.kind;
            entry.method = parsed.method;
            entry.text = String(parsed.text || '').slice(0, 30000);
            entry.textLen = entry.text.replace(/\s+/g, '').length;
            if (!parsed.ok) entry.error = entry.error || '未能提取正文';
          } catch (e) {
            entry.error = '正文解析失败：' + String(e && e.message ? e.message : e);
          }
          parsedAttachments.push(entry);
        }

        base.attachments = parsedAttachments.map((a) => ({
          name: a.name,
          type: a.type,
          size: a.size,
          kind: a.kind,
          textLen: a.textLen,
          error: a.error,
          zone: a.zone,
        }));

        // v1.2.21 关键修正：只分析「学生提交的附件」。
        //
        // 作业详情页里题目区也会有附件（教师给的报告模板 docx、数据集 txt），
        // 模板是一份空白报告——若被当成交上来的文件分析，栏目自然都是空的，
        // 就会误判成「报告有问题」。这就是"检查结果与实际不符"的主因之一。
        //
        // zone 判定见 pageInspectReport 的 zoneOfNode：
        //   'answer' = 作答区（学生提交）；'question' = 题目区（教师材料）；
        //   'unknown' = 没能判断出来，保守地照旧参与分析，避免漏检。

        // v1.2.23 兜底：同名文件按大小择优。
        //
        // 教师模板和你提交的报告经常同名（如「2.降维-机器学习实验报告.docx」），
        // 分别是 23.18K 和 82.29K。即使区域判定失败（两边都 unknown），
        // 也能靠"更大的那份是你填过的"来纠正——空白模板不可能比成品大。
        //
        // 规则：若出现同名文件且分布在多个区域，把**最大的那份**算作答区，
        // 其余同名小文件算题目区材料。仅在同名时生效，不影响不同名的情况。
        const byName = new Map();
        for (const a of parsedAttachments) {
          const n = String(a.name || '').toLowerCase();
          if (!n) continue;
          if (!byName.has(n)) byName.set(n, []);
          byName.get(n).push(a);
        }
        for (const [, group] of byName) {
          if (group.length < 2) continue;
          const zones = new Set(group.map((a) => a.zone));
          // 两边都是 unknown 时也必须处理——那正是区域判定失败、
          // 最需要靠大小纠正的情况。只有"已经明确落在同一具体区域"才跳过。
          const allUnknown = zones.size === 1 && zones.has('unknown');
          if (zones.size < 2 && !allUnknown) continue;
          const biggest = group.reduce((x, y) => (y.size > x.size ? y : x));
          if (biggest.zone === 'answer') continue; // 已正确
          // 把最大的改成 answer，其余同名的一律算题目区材料。
          //
          // 为什么要连 unknown 一起改成 question，而不是留着 unknown：
          // 在同一组同名文件里，既然已经认定最大的那份是你的成品，
          // 其余的就只能是教师模板——留成 unknown 会让它继续参与分析，
          // 而空白模板栏目必然为空，又会把结论带偏成「报告有问题」。
          biggest.zone = 'answer';
          for (const a of group) {
            if (a !== biggest) a.zone = 'question';
          }
          base.reasons.push(
            `发现 ${group.length} 个同名附件，按文件大小判断：${biggest.name}（${Math.round(
              biggest.size / 1024
            )}KB）算作你提交的，其余算题目区材料`
          );
        }
        // 重新分组（上面的「同名按大小择优」兜底可能改过 zone）
        const questionAtts2 = parsedAttachments.filter((a) => a.zone === 'question');
        const answerAtts2 = parsedAttachments.filter((a) => a.zone !== 'question');
        if (questionAtts2.length && answerAtts2.length) {
          base.reasons.push(
            `题目区另有 ${questionAtts2.length} 个附件（${questionAtts2
              .map((a) => a.name || '未命名')
              .join('、')}），属于教师提供的材料，未计入检查`
          );
        }

        const withText = answerAtts2.filter((a) => a.text && a.textLen > 0);
        // 图片/压缩包等本来就不该解析正文，不算失败
        const NON_TEXT_KINDS = new Set(['zip', 'image', 'other', 'png', 'jpg', 'jpeg', 'gif', 'rar', '7z']);
        const undecodable = answerAtts2.filter(
          (a) => !a.text && a.error && !NON_TEXT_KINDS.has(String(a.kind || '').toLowerCase())
        );
        const nonText = answerAtts2.filter((a) => {
          const k = String(a.kind || '').toLowerCase();
          return !a.text && !a.error && (NON_TEXT_KINDS.has(k) || /\.(zip|rar|7z|png|jpe?g|gif)$/i.test(a.name || ''));
        });

        // 1) 学生没有交任何附件、也没有文本答案 → 疑似没交东西
        if (!answerAtts2.length) {
          if (base.textAnswerLen === 0) {
            // 只采到题目区材料时，不能断言「报告有问题」——
            // 更可能是**我们的采集没找到**你交的东西（区域误判 / 内容在跨域 iframe）。
            // 因此降为 warn 并把页面结构诊断一并给出，避免误导成「我的报告不合格」。
            base.level = questionAtts2.length ? 'warn' : 'bad';
            base.reasons.push(
              questionAtts2.length
                ? '只找到题目区的教师材料，没有找到你提交的附件或文本答案'
                : '未发现任何附件或文本答案'
            );
            if (questionAtts2.length) {
              base.hint = '如果你确实交过文件，请点开页面核对；下次检查会带上页面结构诊断';
            }
            // v1.2.22：附上页面结构诊断，说明"为什么没找到"。
            // 这条信息决定后续是补选择器还是遍历 iframe，必须让用户看得见。
            const diag = describePageDebug(base.pageDebug);
            if (diag) base.reasons.push(diag);
          } else {
            base.level = 'ok';
            base.reasons.push('存在文本答案（无附件）');
          }
          results.push(base);
          continue;
        }

        // 2) 有附件但都没能提取正文
        if (!withText.length) {
          if (base.textAnswerLen > 0) {
            base.level = 'ok';
            base.reasons.push('存在文本答案（附件正文未解析）');
          } else if (undecodable.length) {
            // 确实尝试解析但失败了 → 需人工确认，并把失败原因说清楚
            base.level = 'warn';
            const detail = undecodable
              .map((a) => `${a.name || '附件'}：${a.error}`)
              .join('；');
            base.reasons.push('附件正文读取失败，需人工确认 —— ' + detail);
            base.hint = '若反复失败，可在学习通里直接打开该附件确认内容';
          } else {
            // 只有图片/压缩包这类无正文附件
            base.level = 'warn';
            base.reasons.push(
              '附件无可提取的正文（' +
                [...new Set(nonText.map((a) => a.kind || '压缩包'))].join('、') +
                '），请人工确认内容'
            );
          }
          results.push(base);
          continue;
        }

        // 3) 有正文 → 做结构分析，多份取「问题最严重」的
        //
        // v1.2.24：先取教师模板骨架，再用它校验报告结构。
        // 模板来自题目区附件（zone==='question'）——它是一份空白报告，
        // 但栏目骨架是真的，能可靠回答"你这份是不是按这份模板写的"。
        const template = pickTemplateSkeleton(questionAtts2);
        if (template) {
          base.templateSkeleton = {
            headings: template.headings,
            presetTitle: template.presetTitle,
            textLen: template.textLen,
          };
        }
        const analyses = withText.map((a) => {
          const r = analyzeReportText(a.text, item, a.size || 0, template || undefined);
          r.fileName = a.name;
          return r;
        });
        const rank = { bad: 0, warn: 1, ok: 2 };
        const worst = analyses.slice().sort((a, b) => rank[a.level] - rank[b.level])[0];
        base.analysis = worst;
        base.level = worst.level;
        base.reasons = worst.reasons.slice();
        if (analyses.length > 1) {
          base.reasons.push(`共 ${analyses.length} 份可解析附件，已全部检查`);
        }
        if (undecodable.length) {
          base.reasons.push(
            `另有 ${undecodable.length} 个附件（${undecodable
              .map((a) => a.name)
              .join('、')}）正文读取失败，需人工确认`
          );
          if (base.level === 'ok') base.level = 'warn';
        }
        results.push(base);
      } catch (e) {
        base.reasons.push('检查异常：' + String(e && e.message ? e.message : e));
        results.push(base);
      }
    }
  } finally {
    if (tab && tab.id != null) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* 已关闭 */
      }
    }
  }

  onProgress({ done: selected.length, total: selected.length, message: '检查完成' });
  return results;
}
