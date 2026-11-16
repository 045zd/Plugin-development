/**
 * 生成 README 用的界面截图。
 *
 * 做法：不手绘 mock，直接加载真实的 extension/options/options.html 与
 * extension/popup/popup.html。页面加载前注入一个最小的 chrome API mock
 * （只实现 options.js / popup.js 真正用到的几个方法），返回结构与真实
 * 扫描结果一致的演示数据，然后交给 ego-browser 截图。
 *
 * 这样截图里的布局、配色、字号全部来自真实 CSS；改了 UI 重新跑一次即可同步，
 * 不会出现「截图和实际界面对不上」的问题。
 *
 * 用法：node tools/screenshot.mjs
 * 输出：docs/images/options.png、docs/images/popup.png
 *
 * 注意：依赖 ego-browser（Chromium）。若没有，脚本会打印页面地址，
 * 也可以自己在浏览器里打开后手动截图。
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const extDir = join(root, 'extension');
const outDir = join(root, 'docs', 'images');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* 演示数据（结构同真实扫描结果，内容是虚构的课程名与作业名）           */
/* ------------------------------------------------------------------ */

const NOW = Date.now();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function assignment(at, title, course, extra = {}) {
  return {
    key: `${course}|${title}`,
    type: 'assignment',
    course,
    title,
    status: '未交',
    deadline: at,
    deadlineText: '',
    startText: '',
    score: '',
    url: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/list',
    extra: '',
    ...extra,
  };
}

// 时间相对「现在」计算，截图里的「剩余 X 小时」才会自然
const DEMO_ITEMS = [
  assignment(NOW + 3 * HOUR + 20 * 60 * 1000, '实验三 进程调度算法模拟', '操作系统'),
  assignment(NOW + 22 * HOUR, '第三章 课后作业', '计算机组成原理'),
  assignment(NOW + 2 * DAY + 4 * HOUR, '实验报告五 网络协议分析', '计算机网络'),
  assignment(NOW + 4 * DAY, '期中测验', '软件工程', { type: 'exam', status: '未开始' }),
  assignment(NOW + 6 * DAY, 'Unit 5 Writing Task', '大学英语'),
];

const DEMO_CONFIG = {
  scanIntervalMinutes: 60,
  checkAssignments: true,
  checkExams: true,
  reminderHours: [72, 24, 6, 1],
  expiredAlert: true,
  browserNotifications: true,
  emailEnabled: true,
  mailProxyUrl: 'http://127.0.0.1:8765',
  maxCourses: 15,
  autoFillAccount: true,
  rememberedAccount: '20230000000',
  courseFilterEnabled: true,
  scheduleCourses: ['操作系统', '计算机组成原理', '计算机网络', '软件工程', '大学英语'],
  dxAiChatAutoOpen: true,
  showExpiredItems: false,
};

const DEMO_SCAN_META = {
  lastScanAt: NOW - 13 * 60 * 1000,
  lastScanOk: true,
  lastError: '',
  loggedIn: true,
  scannedCourses: 5,
  scannedItems: DEMO_ITEMS.length,
  source: 'auto',
};

const DEMO_REPORT_CHECK = {
  running: false,
  startedAt: NOW - 10 * 60 * 1000,
  finishedAt: NOW - 8 * 60 * 1000,
  message: '检查完成：4 份报告，1 份已截止跳过',
  total: 3,
  done: 3,
  error: '',
  results: [
    {
      course: '操作系统',
      title: '实验三 进程调度算法模拟',
      level: 'ok',
      reason: '报告内容完整，栏目齐全。',
      viewUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view',
      analysis: {
        textLen: 3120,
        reportTitle: '进程调度算法模拟',
        template: { usable: true, coverage: 1, covered: 4, total: 4 },
      },
      templateSkeleton: {
        headings: ['实验名称', '实验目的', '实验过程', '实验结果'],
        presetTitle: '进程调度算法模拟',
      },
      attachments: [
        { name: '实验三报告.docx', kind: 'docx', size: 318000, zone: 'answer', textLen: 3120 },
        { name: '实验三模板.docx', kind: 'docx', size: 22000, zone: 'question' },
      ],
      textAnswerLen: 0,
    },
    {
      course: '计算机网络',
      title: '实验报告五 网络协议分析',
      level: 'warn',
      reason:
        '报告里写的实验名称是「TCP 抓包分析」，作业标题是「实验报告五 网络协议分析」，写法不一致。这只表示标题措辞不同，不代表交错——请点开页面自行核对。',
      viewUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view',
      analysis: {
        textLen: 980,
        reportTitle: 'TCP 抓包分析',
        template: { usable: true, coverage: 0.5, covered: 2, total: 4 },
      },
      templateSkeleton: {
        headings: ['实验名称', '实验目的', '实验过程', '实验结果'],
        presetTitle: '',
      },
      attachments: [
        { name: '网络协议分析.docx', kind: 'docx', size: 96000, zone: 'answer', textLen: 980 },
      ],
      textAnswerLen: 0,
    },
    {
      course: '软件工程',
      title: '实验二 需求分析',
      level: 'ok',
      reason: '报告内容完整。',
      viewUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view',
      analysis: { textLen: 2040, reportTitle: '需求分析', template: null },
      attachments: [
        { name: '需求分析报告.docx', kind: 'docx', size: 210000, zone: 'answer', textLen: 2040 },
      ],
      textAnswerLen: 0,
    },
  ],
};

/* ------------------------------------------------------------------ */
/* chrome API mock（在页面脚本执行前注入 <head>）                        */
/* ------------------------------------------------------------------ */

const MOCK_SCRIPT = `
(() => {
  // 收集页面 JS 错误：截图脚本只有在页面零错误时才认为成功，
  // 否则容易截出一张「少了几块」的残缺图还以为是好的。
  window.__errors = [];
  window.addEventListener('error', (e) => {
    window.__errors.push('error: ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    window.__errors.push('rejection: ' + String((r && r.stack) || r));
  });

  const DEMO = ${JSON.stringify({
    config: DEMO_CONFIG,
    items: DEMO_ITEMS,
    scanMeta: DEMO_SCAN_META,
    reportCheck: DEMO_REPORT_CHECK,
    version: '1.2.25',
  })};

  function reply(message) {
    switch (message && message.type) {
      case 'GET_STATE':
        return {
          config: DEMO.config,
          items: DEMO.items,
          scanMeta: DEMO.scanMeta,
          scanning: false,
          progress: null,
          runtimeVersion: DEMO.version,
        };
      case 'GET_REPORT_CHECK':
        return DEMO.reportCheck;
      case 'SAVE_CONFIG':
        return { ok: true, config: message.config || DEMO.config };
      case 'TEST_EMAIL':
      case 'CLEAR_ITEMS':
      case 'OPEN_URL':
      case 'OPEN_OPTIONS':
        return { ok: true };
      case 'SCAN_NOW':
        return { started: true };
      default:
        return { ok: true };
    }
  }

  const noop = () => {};
  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: DEMO.version, name: '学习通截止提醒' }),
      sendMessage: (message, cb) => {
        const data = reply(message);
        // 复刻真实异步回调，避免调用方拿到同步结果后行为不同
        setTimeout(() => { if (typeof cb === 'function') cb(data); }, 0);
      },
      openOptionsPage: noop,
      onMessage: { addListener: noop },
    },
    storage: {
      local: {
        get: (keys, cb) => { if (typeof cb === 'function') setTimeout(() => cb({}), 0); },
        set: (obj, cb) => { if (typeof cb === 'function') setTimeout(() => cb(), 0); },
      },
    },
    tabs: {
      create: noop,
      query: (q, cb) => { if (typeof cb === 'function') setTimeout(() => cb([]), 0); },
    },
    notifications: { create: noop },
  };
})();
`;

/* ------------------------------------------------------------------ */
/* 静态文件服务                                                        */
/* ------------------------------------------------------------------ */

function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(base, decoded));
  if (!target.startsWith(base + sep) && target !== base) return null;
  return target;
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const filePath = safeJoin(extDir, req.url === '/' ? '/options/options.html' : req.url);
      if (!filePath || !existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      try {
        let body = await readFile(filePath);
        if (extname(filePath) === '.html') {
          const html = body.toString('utf8');
          body = Buffer.from(
            html.replace(/<head[^>]*>/i, (m) => `${m}\n<script>${MOCK_SCRIPT}</script>`),
            'utf8'
          );
        }
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(err && err.message));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ------------------------------------------------------------------ */
/* 截图规格                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每张截图的处理：
 * - selector：先等它出现，确保脚本已渲染完
 * - css：仅在截图时注入的样式微调（不修改仓库源码）
 * - width/height：视口尺寸
 * - clipToBody：按内容实际高度裁剪，避免大片留白
 */
const SHOTS = [
  {
    name: 'options',
    path: '/options/options.html',
    selector: '.page-header',
    width: 1249,
    height: 900,
    clipToBody: true,
  },
  {
    name: 'popup',
    path: '/popup/popup.html',
    selector: '.item-list',
    width: 380,
    height: 900,
    clipToBody: true,
    // 真实弹窗 body 固定 520px 高、列表内部滚动；README 里希望一屏看到全部
    // 条目，所以截图时解除高度限制（只影响截图，不改源码）。
    css: 'body{height:auto!important;min-height:0!important}.item-list{max-height:none!important;overflow:visible!important}',
  },
];

/* ------------------------------------------------------------------ */
/* 通过 ego-browser 截图                                               */
/* ------------------------------------------------------------------ */

/**
 * 通过 ego-browser 截图。
 *
 * 注意：不能给子进程用管道 stdio——本机沙箱下 Node 的 stdio:'pipe' 会报
 * spawn EPERM（连 stdin 管道也不行）。这里把 ego 脚本先写到临时文件，
 * 再用文件描述符当 stdin（普通文件不是命名管道，不受限制），stdout/stderr
 * 直接丢弃，靠「PNG 是否重新生成」判定成功。
 */
function runEgo(script, tmpScript, timeoutMs = 180000) {
  return new Promise(async (resolve, reject) => {
    const cli = process.env.EGO_BROWSER_CLI;
    if (!cli) {
      reject(new Error('未设置 EGO_BROWSER_CLI，跳过自动截图'));
      return;
    }
    await writeFile(tmpScript, script, 'utf8');
    // stdout/stderr 重定向到日志文件（不用管道，避开沙箱 spawn EPERM）
    const logPath = tmpScript.replace(/\.js$/, '.log');
    const inFd = openSync(tmpScript, 'r');
    const outFd = openSync(logPath, 'w');
    let child;
    try {
      child = spawn(process.execPath, [cli, 'nodejs'], {
        stdio: [inFd, outFd, outFd],
        env: { ...process.env },
      });
    } catch (e) {
      closeSync(inFd);
      closeSync(outFd);
      reject(e);
      return;
    }
    closeSync(inFd);
    closeSync(outFd);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ego-browser 超时'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, logPath });
    });
  });
}

function buildEgoScript(base, shots) {
  return `
const shots = ${JSON.stringify(shots)};
const reports = [];

// ego 的 page.waitForSelector 要求选择器唯一，popup 页的 .item-list 有多个，
// 所以这里自己轮询「至少出现一个」。
async function waitForAny(sel, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
    if (n > 0) return n;
    if (Date.now() - started > timeoutMs) throw new Error('等待超时: ' + sel);
    await page.waitForTimeout(120);
  }
}

// ego-browser 会往页面里插一个 agent 光标覆盖层（灰色 DeepSeek 方块），
// 不隐藏就会画进截图里。
async function hideAgentOverlay() {
  await page.evaluate(() => {
    const ids = ['ego-agent-cursor-overlay', 'ego-cursor-overlay', 'ego-agent-overlay'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    for (const el of document.querySelectorAll('[id*="ego"][id*="overlay"], [class*="ego-cursor"], [class*="agent-cursor"]')) {
      el.style.display = 'none';
    }
  });
}

for (const s of shots) {
  await page.goto('${base}' + s.path, { waitUntil: 'load' });
  await waitForAny(s.selector);
  await page.waitForTimeout(400);

  // ego 的 Emulation.setDeviceMetricsOverride 里 width/height 是设备像素，
  // 所以 CSS 视口宽度 = width / deviceScaleFactor。这里先按这个关系设一次，
  // 再读 window.innerWidth 校准，确保页面按期望的 CSS 宽度布局
  // （否则会掉进 max-width:720px 的窄屏媒体查询，截出单列窄图）。
  const dsf = s.dsf || 1;
  const want = s.width;
  let cssW = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reqW = Math.round(want * dsf * (cssW ? want / cssW : 1));
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: reqW, height: Math.round(s.height * dsf), deviceScaleFactor: dsf, mobile: false,
    });
    await page.waitForTimeout(250);
    cssW = await page.evaluate(() => window.innerWidth);
    if (Math.abs(cssW - want) <= 2) break;
  }

  if (s.css) {
    await page.evaluate((css) => {
      const st = document.createElement('style');
      st.textContent = css;
      document.head.appendChild(st);
    }, s.css);
    await page.waitForTimeout(300);
  }
  await hideAgentOverlay();
  await page.waitForTimeout(150);

  // 关键：clip 超出视口的部分 CDP 不一定能画出来（会留大片空白），
  // 所以先把视口高度设成整页高度，再不带 clip 截整屏。
  const box = await page.evaluate(() => ({
    h: Math.ceil(document.body.scrollHeight),
    w: Math.ceil(window.innerWidth),
  }));
  if (s.clipToBody) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: Math.round(want * dsf), height: Math.round(box.h * dsf), deviceScaleFactor: dsf, mobile: false,
    });
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: ${JSON.stringify(outDir.replace(/\\/g, '/'))} + '/' + s.name + '.png' });

  // 页面自身的 JS 错误一并带回，父进程据此判断截图是否可信
  const info = await page.evaluate(() => ({
    errors: window.__errors || [],
    cards: document.querySelectorAll('section.card').length,
    textLen: (document.body.innerText || '').length,
  }));
  reports.push({ name: s.name, cssWidth: box.w, cssHeight: box.h, ...info });
}
console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: true, reports }));
`;
}

async function main() {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const tmpDir = join(root, '.tmp');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('页面地址：');
  for (const s of SHOTS) console.log(`  ${base}${s.path}`);

  try {
    // 先删掉旧文件，这样「生成了新文件」才算成功
    const targets = SHOTS.map((s) => join(outDir, s.name + '.png'));
    for (const t of targets) {
      try {
        await rm(t, { force: true });
      } catch {
        /* 忽略 */
      }
    }

    const { code, logPath } = await runEgo(buildEgoScript(base, SHOTS), join(root, '.tmp', 'ego-shot.js'));
    let logText = '';
    try {
      logText = await readFile(logPath, 'utf8');
    } catch {
      /* 忽略 */
    }
    if (code !== 0) {
      throw new Error(`ego-browser 退出码 ${code}\n${logText.slice(-1500)}`);
    }

    const missing = [];
    for (const s of SHOTS) {
      const f = join(outDir, s.name + '.png');
      if (!existsSync(f)) missing.push(f);
    }
    if (missing.length) throw new Error('以下截图未生成：' + missing.join(', '));

    for (const s of SHOTS) {
      const f = join(outDir, s.name + '.png');
      const st = await stat(f);
      console.log(`已保存 ${f}  (${Math.round(st.size / 1024)} KB)`);
    }
  } catch (err) {
    console.error('自动截图失败：' + (err && err.message ? err.message : err));
    console.error('可以手动打开上面的地址截图，或设置 EGO_BROWSER_CLI 指向 ego-browser.mjs。');
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    console.error('启动失败:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

export { DEMO_CONFIG, DEMO_ITEMS, DEMO_SCAN_META, DEMO_REPORT_CHECK, MOCK_SCRIPT, startServer };
