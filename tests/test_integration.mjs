/**
 * 集成测试：用 chrome API mock 在 Node 中跑 service-worker 的完整扫描流程。
 *
 * 覆盖：
 * - 模块可导入、初始化无异常；
 * - runScan 扫描成功 → items/notified/scanMeta 写入、浏览器通知触发、邮件与心跳调用；
 * - 未登录场景 → 登录失效通知 + 邮件（节流）；
 * - 消息协议 GET_STATE / SAVE_CONFIG / SCAN_NOW / CLEAR_ITEMS。
 *
 * 运行：node tests/test_integration.mjs
 */
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ */
/* chrome API mock                                                     */
/* ------------------------------------------------------------------ */

function makeStorageArea() {
  const data = new Map();
  const normalizeKeys = (keys) => {
    if (keys == null) return [...data.keys()];
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys;
    if (typeof keys === 'object') return Object.keys(keys);
    return [];
  };
  return {
    __data: data,
    async get(keys) {
      const out = {};
      for (const k of normalizeKeys(keys)) {
        if (data.has(k)) out[k] = data.get(k);
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of normalizeKeys(keys)) data.delete(k);
    },
    async clear() {
      data.clear();
    },
  };
}

const storage = { local: makeStorageArea(), session: makeStorageArea() };
const alarms = new Map();
const listeners = {
  installed: [],
  startup: [],
  message: [],
  alarm: [],
  notificationClicked: [],
  tabUpdated: [],
  tabRemoved: [],
};
const notifications = [];
let nextTabId = 100;
const tabs = new Map();

const chromeMock = {
  runtime: {
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    getURL: (path) => 'chrome-extension://mockid/' + path,
    openOptionsPage: async () => {},
    sendMessage: async () => ({ ok: true }),
  },
  storage,
  alarms: {
    async get(name) {
      return alarms.get(name) || null;
    },
    async create(name, info) {
      alarms.set(name, Object.assign({ name }, info));
    },
    async clear(name) {
      return alarms.delete(name);
    },
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  tabs: {
    async create(info) {
      const id = nextTabId++;
      const tab = { id, url: info.url || '', active: info.active !== false };
      tabs.set(id, tab);
      setTimeout(() => {
        for (const fn of listeners.tabUpdated) fn(id, { status: 'complete' });
      }, 5);
      return tab;
    },
    async get(id) {
      const tab = tabs.get(id);
      if (!tab) throw new Error('No tab with id: ' + id);
      return tab;
    },
    async update(id, info) {
      const tab = tabs.get(id);
      if (!tab) throw new Error('No tab with id: ' + id);
      Object.assign(tab, info);
      setTimeout(() => {
        for (const fn of listeners.tabUpdated) fn(id, { status: 'complete' });
      }, 5);
      return tab;
    },
    async remove(id) {
      tabs.delete(id);
      for (const fn of listeners.tabRemoved) fn(id);
    },
    async query() {
      return [...tabs.values()];
    },
    onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn), removeListener: (fn) => {
      const i = listeners.tabUpdated.indexOf(fn);
      if (i >= 0) listeners.tabUpdated.splice(i, 1);
    } },
    onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn), removeListener: (fn) => {
      const i = listeners.tabRemoved.indexOf(fn);
      if (i >= 0) listeners.tabRemoved.splice(i, 1);
    } },
  },
  scripting: {
    async executeScript({ func, args }) {
      const name = func.name;
      if (name === 'pageFetchCourses') {
        if (globalThis.__mockNotLoggedIn) {
          return [{ result: { ok: false, error: 'NOT_LOGGED_IN' } }];
        }
        return [
          {
            result: {
              ok: true,
              courses: [
                { courseId: 'c1', classId: 'k1', cpi: '123', title: '高等数学' },
              ],
            },
          },
        ];
      }
      if (name === 'pageClickTabAndGetIframe') {
        return [{ result: { ok: true, url: 'https://mooc1.chaoxing.com/mock/list' } }];
      }
      if (name === 'pageParseAggregateWorks') {
        if (globalThis.__mockNotLoggedIn) {
          return [{ result: { ok: false, error: 'NOT_LOGGED_IN' } }];
        }
        if (globalThis.__mockAggregateFail) {
          return [
            { result: { ok: false, error: 'STRUCTURE_MISMATCH', snippet: 'mock 结构不匹配' } },
          ];
        }
        return [
          {
            result: {
              ok: true,
              hasContainer: true,
              rows:
                globalThis.__mockWorkRows ||
                [
                  {
                    title: '第3章作业',
                    statusText: '未交',
                    hasStatusSpan: true,
                    uncommitted: true,
                    course: '高等数学',
                    leftTime: '剩余 5 小时',
                    link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=999',
                    stableId: 'workId=999',
                  },
                  {
                    title: '第2章作业',
                    statusText: '已完成',
                    hasStatusSpan: true,
                    uncommitted: false,
                    course: '高等数学',
                    leftTime: '',
                    link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=998',
                    stableId: 'workId=998',
                  },
                ],
            },
          },
        ];
      }
      if (name === 'pageParseAggregateExams') {
        if (globalThis.__mockNotLoggedIn) {
          return [{ result: { ok: false, error: 'NOT_LOGGED_IN' } }];
        }
        if (globalThis.__mockAggregateFail) {
          return [{ result: { ok: false, error: 'STRUCTURE_MISMATCH' } }];
        }
        return [
          {
            result: {
              ok: true,
              hasContainer: true,
              rows:
                globalThis.__mockExamRows ||
                [
                  {
                    title: '期中考试',
                    timeLeft: '剩余 3 天',
                    statusText: '进行中',
                    expired: false,
                    link: 'https://mooc1.chaoxing.com/exam/test?examId=88',
                    stableId: 'examId=88',
                  },
                ],
            },
          },
        ];
      }
      if (name === 'pageExtractAnswerUrl') {
        return [
          {
            result: {
              ok: true,
              url: 'https://mooc1-api.chaoxing.com/mooc-ans/work/phone/doHomeWork?workId=999&cpi=4&enc=mock',
            },
          },
        ];
      }
      if (name === 'pageClickTabAndGetListUrl') {
        if (!globalThis.__mockDesktop) return [{ result: { ok: false, error: 'MOCK_NO_DESKTOP' } }];
        return [
          {
            result: {
              ok: true,
              url: 'https://mooc1.chaoxing.com/mooc2/work/list?courseId=2&classId=3&cpi=4',
            },
          },
        ];
      }
      if (name === 'pageFindTaskUrl') {
        const kind = Array.isArray(args) ? args[1] : 'work';
        const url =
          kind === 'peer'
            ? 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/eval-list?courseId=2&classId=3&cpi=4&workId=88'
            : 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=2&classId=3&cpi=4&workId=1';
        return [{ result: { ok: true, url } }];
      }
      if (name === 'pageCheckPageUsable') {
        return [{ result: { ok: true } }];
      }
      if (name === 'pageExtractExamStartUrl') {
        return [{ result: { ok: false } }];
      }
      if (name === 'pageOpenDxAiChat') {
        globalThis.__mockAiChatClicked = (globalThis.__mockAiChatClicked || 0) + 1;
        return [{ result: { ok: true, clicked: true } }];
      }
      if (name === 'pageParseListPage') {
        const kind = Array.isArray(args) ? args[0] : 'assignment';
        const defaultRows =
          kind === 'exam'
            ? [
                {
                  text: '期中考试\n进行中\n' + FUTURE_DEADLINE,
                  link: 'https://mooc1.chaoxing.com/exam/test?examId=88',
                },
              ]
            : [
                {
                  text: '第3章作业\n未交\n' + FUTURE_DEADLINE,
                  link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=999',
                },
                { text: '第2章作业\n已批阅\n95 分', link: '' },
              ];
        return [{ result: { ok: true, rows: globalThis.__mockRows || defaultRows } }];
      }
      return [{ result: { ok: false, error: 'UNKNOWN_FUNC' } }];
    },
  },
  notifications: {
    create(id, options, callback) {
      notifications.push({ id, options });
      if (typeof callback === 'function') callback(id);
    },
    async clear() {},
    onClicked: { addListener: (fn) => listeners.notificationClicked.push(fn) },
  },
};

globalThis.chrome = chromeMock;

// fetch mock（邮件代理）
const fetchCalls = [];
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, mailConfigured: true, lastHeartbeat: Date.now() };
    },
  };
};

/* ------------------------------------------------------------------ */
/* 测试工具                                                            */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS', name);
  } catch (e) {
    failed += 1;
    console.log('FAIL', name);
    console.log('     ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e);
  }
}

function waitFor(predicate, timeoutMs = 30000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      try {
        if (await predicate()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('waitFor 超时'));
        }
      } catch (e) {
        clearInterval(timer);
        reject(e);
      }
    }, intervalMs);
  });
}

/** 生成 "YYYY-MM-DD HH:mm" 格式的本地时间文本（用于 mock 作业截止时间）。 */
function formatLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

function getState() {
  return new Promise((resolve) => {
    listeners.message[0]({ type: 'GET_STATE' }, {}, (response) => {
      resolve(response.data || response);
    });
  });
}

async function waitScanDone(timeoutMs = 40000) {
  await waitFor(async () => {
    const state = await getState();
    return state.scanning === false && state.scanMeta && state.scanMeta.lastScanAt > 0;
  }, timeoutMs);
}

/** 动态生成一个「5 小时后截止」的文本，确保命中提醒阈值。 */
const FUTURE_DEADLINE = formatLocal(new Date(Date.now() + 5 * 60 * 60 * 1000));

/* ------------------------------------------------------------------ */
/* 主测试                                                              */
/* ------------------------------------------------------------------ */

console.log('导入 service-worker 模块…');
const sw = await import('../extension/background/service-worker.js');
console.log('模块导入成功');

await test('初始化：alarm 已创建', async () => {
  assert.ok(alarms.size > 0, '应创建至少一个 alarm');
});

await test('GET_STATE 返回完整结构', async () => {
  const response = await new Promise((resolve) => {
    listeners.message[0]({ type: 'GET_STATE' }, {}, resolve);
  });
  assert.ok(response && typeof response === 'object');
  const state = response.data || response;
  assert.ok(state.config, '应有 config');
  assert.ok(Array.isArray(state.items), '应有 items 数组');
  assert.ok(state.scanMeta, '应有 scanMeta');
  assert.equal(typeof state.scanning, 'boolean');
});

await test('SAVE_CONFIG 保存并规范化', async () => {
  const response = await new Promise((resolve) => {
    listeners.message[0](
      { type: 'SAVE_CONFIG', config: { scanIntervalMinutes: 9999, reminderHours: [0, 6, 6, 24] } },
      {},
      resolve
    );
  });
  assert.ok(response.ok);
  const saved = response.config;
  assert.equal(saved.scanIntervalMinutes, 720); // 上限
  assert.deepEqual(saved.reminderHours, [24, 6]); // 去重 + 去 0
});

await test('SCAN_NOW 触发扫描：items / 通知 / 邮件 / 心跳', async () => {
  globalThis.__mockNotLoggedIn = false;
  delete globalThis.__mockWorkRows;
  delete globalThis.__mockExamRows;
  delete globalThis.__mockAggregateFail;
  // 开启邮件通知
  const emailResp = await new Promise((resolve) => {
    listeners.message[0](
      { type: 'SAVE_CONFIG', config: { emailEnabled: true } },
      {},
      resolve
    );
  });
  assert.ok(emailResp.ok);

  const notifCountBefore = notifications.length;
  const fetchCountBefore = fetchCalls.length;

  const scanResp = await new Promise((resolve) => {
    listeners.message[0]({ type: 'SCAN_NOW' }, {}, resolve);
  });
  assert.ok(scanResp, 'SCAN_NOW 应有响应');

  // 等待扫描完成
  await waitFor(async () => {
    const res = await new Promise((resolve) => {
      listeners.message[0]({ type: 'GET_STATE' }, {}, resolve);
    });
    const state = res.data || res;
    return state.scanMeta && state.scanMeta.lastScanAt > 0;
  }, 40000);

  const res = await new Promise((resolve) => {
    listeners.message[0]({ type: 'GET_STATE' }, {}, resolve);
  });
  const state = res.data || res;
  assert.equal(state.scanMeta.lastScanOk, true, '扫描应成功');
  assert.equal(state.scanMeta.loggedIn, true, '应已登录');
  assert.equal(state.items.length, 3, '应解析出作业 2 条 + 考试 1 条');
  assert.equal(state.items[0].title, '第3章作业');
  assert.equal(state.items[0].status, '未交');
  assert.ok(state.items[0].deadline != null);
  assert.equal(state.items[1].status, '已完成', '已完成的作业状态应为已完成');
  assert.ok(
    state.items.some((i) => i.type === 'exam'),
    '应包含考试条目'
  );

  // 通知：2 天后的作业，默认阈值 24/6/1 已在上一步 GET_STATE 测试中保存为 [24,6]
  // 不论命中哪个阈值，都应至少有 1 条浏览器通知
  assert.ok(
    notifications.length > notifCountBefore,
    '应触发浏览器通知，实际 ' + (notifications.length - notifCountBefore)
  );
  // 已完成的「第2章作业」不应出现在通知里
  const newNotifications = notifications.slice(notifCountBefore);
  assert.ok(
    !newNotifications.some((n) =>
      String((n.options && n.options.message) || '').includes('第2章作业')
    ),
    '已完成的作业不应触发通知'
  );

  // 邮件与心跳调用代理
  const proxyCalls = fetchCalls.slice(fetchCountBefore);
  assert.ok(
    proxyCalls.some((c) => c.url.includes('/send')),
    '应调用 /send 发送提醒邮件'
  );
  assert.ok(
    proxyCalls.some((c) => c.url.includes('/heartbeat')),
    '应调用 /heartbeat'
  );
});

await test('重复扫描不重复提醒同一条目', async () => {
  globalThis.__mockWorkRows = [
    {
      title: '第3章作业',
      statusText: '未交',
      hasStatusSpan: true,
      uncommitted: true,
      course: '高等数学',
      leftTime: '剩余 5 小时',
      link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=999',
      stableId: 'workId=999',
    },
  ];
  const beforeScanAt = (await getState()).scanMeta.lastScanAt;
  listeners.message[0]({ type: 'SCAN_NOW' }, {}, () => {});
  await waitFor(async () => {
    const state = await getState();
    return state.scanning === false && state.scanMeta.lastScanAt !== beforeScanAt;
  }, 40000);
  // 同一作业（相同 workId）不应重复提醒同一阈值
  const notified = await storage.local.get('notified');
  const map = notified.notified || {};
  const homeworkKey = Object.keys(map).find((k) =>
    k.startsWith('a|高等数学|第3章作业')
  );
  assert.ok(homeworkKey, '应有作业条目的提醒记录');
  const entry = map[homeworkKey] || [];
  assert.ok(
    entry.length <= 2,
    '已提醒阈值不应重复累积，实际 ' + JSON.stringify(entry) + ' key=' + homeworkKey
  );
});

await test('未登录场景触发登录失效通知与邮件', async () => {
  globalThis.__mockNotLoggedIn = true;
  const notifBefore = notifications.length;
  const fetchBefore = fetchCalls.length;
  listeners.message[0]({ type: 'SCAN_NOW' }, {}, () => {});
  await waitFor(async () => {
    const res = await new Promise((resolve) => {
      listeners.message[0]({ type: 'GET_STATE' }, {}, resolve);
    });
    const state = res.data || res;
    return state.scanMeta && state.scanMeta.loggedIn === false;
  }, 40000);

  const authNotif = notifications
    .slice(notifBefore)
    .find((n) => n.id === 'chaoxing-auth-required');
  assert.ok(authNotif, '应触发登录失效通知');
  const authMail = fetchCalls
    .slice(fetchBefore)
    .find((c) => c.url.includes('/send'));
  assert.ok(authMail, '应发送登录失效邮件');
});

await test('聚合页结构不匹配时回退逐课程采集', async () => {
  globalThis.__mockNotLoggedIn = false;
  globalThis.__mockAggregateFail = true;
  delete globalThis.__mockWorkRows;
  delete globalThis.__mockExamRows;
  delete globalThis.__mockRows; // 旧路径使用默认测试数据
  const beforeScanAt = (await getState()).scanMeta.lastScanAt;
  listeners.message[0]({ type: 'SCAN_NOW' }, {}, () => {});
  await waitFor(async () => {
    const state = await getState();
    return state.scanning === false && state.scanMeta.lastScanAt !== beforeScanAt;
  }, 40000);
  const state = await getState();
  assert.equal(state.scanMeta.lastScanOk, true, '回退路径扫描应成功');
  assert.equal(state.items.length, 3, '应回退到逐课程解析出 3 条（作业2+考试1）');
  delete globalThis.__mockAggregateFail;
});

await test('CHECK_REPORTS 无实验报告时正常完成', async () => {
  const start = await new Promise((resolve) => {
    listeners.message[0]({ type: 'CHECK_REPORTS' }, {}, resolve);
  });
  assert.equal(start.ok, true);

  await waitFor(async () => {
    const res = await new Promise((resolve) => {
      listeners.message[0]({ type: 'GET_REPORT_CHECK' }, {}, resolve);
    });
    const state = res.data || res;
    return state && state.running === false && Array.isArray(state.results);
  });

  const res = await new Promise((resolve) => {
    listeners.message[0]({ type: 'GET_REPORT_CHECK' }, {}, resolve);
  });
  const state = res.data || res;
  assert.deepEqual(state.results, []);
});

await test('CLEAR_ITEMS 清空缓存', async () => {
  const response = await new Promise((resolve) => {
    listeners.message[0]({ type: 'CLEAR_ITEMS' }, {}, resolve);
  });
  assert.ok(response.ok);
  const res = await new Promise((resolve) => {
    listeners.message[0]({ type: 'GET_STATE' }, {}, resolve);
  });
  const state = res.data || res;
  assert.equal(state.items.length, 0);
});

await test('OPEN_URL 打开标签页并拒绝非法协议', async () => {
  const before = tabs.size;
  const okRes = await new Promise((resolve) => {
    listeners.message[0](
      { type: 'OPEN_URL', url: 'https://mooc1-api.chaoxing.com/work/stu-work' },
      {},
      resolve
    );
  });
  assert.equal(okRes.ok, true, '合法 https 链接应打开成功');
  await waitFor(() => tabs.size === before + 1);
  assert.equal(tabs.size, before + 1, '应创建新标签页');

  const badRes = await new Promise((resolve) => {
    listeners.message[0]({ type: 'OPEN_URL', url: 'javascript:alert(1)' }, {}, resolve);
  });
  assert.equal(badRes.ok, false, '非法协议应被拒绝');
  assert.equal(badRes.error, 'invalid_url');
  assert.equal(tabs.size, before + 1, '非法链接不应创建标签页');
});

await test('详情页打开后解析为作答页', async () => {
  const { openUrlInTab, isDetailPageUrl } = await import('../extension/background/open-tab.js');
  const detail =
    'https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=1&courseId=2&clazzId=3&cpi=4';
  assert.equal(isDetailPageUrl(detail), true);
  assert.equal(isDetailPageUrl('https://mooc1-api.chaoxing.com/work/stu-work'), false);

  const before = tabs.size;
  const res = await openUrlInTab(detail);
  assert.equal(res.ok, true);
  assert.equal(res.resolved, true, '应解析出 doHomeWork 地址');
  await waitFor(() => tabs.size === before + 1);
  const opened = [...tabs.values()].find((t) => t.url.includes('/work/phone/doHomeWork'));
  assert.ok(opened, '标签页应导航到作答页');
  assert.equal(opened.active, true, '作答页标签应被激活');
});

await test('作业优先打开电脑版作答页（兼容搜题插件）', async () => {
  globalThis.__mockDesktop = true;
  const { openUrlInTab } = await import('../extension/background/open-tab.js');
  const detail =
    'https://mooc1-api.chaoxing.com/mooc-ans/android/mtaskmsgspecial?taskrefId=77&courseId=2&clazzId=3&cpi=4';
  const res = await openUrlInTab(detail, { openAiChat: true });
  assert.equal(res.ok, true);
  assert.equal(res.resolved, true);
  assert.equal(res.desktop, true, '应走电脑版流程');
  assert.ok(/\/mooc-ans\/mooc2\/work\/dowork/.test(res.url), '最终应落在电脑版作答页');
  assert.ok(globalThis.__mockAiChatClicked > 0, '应尝试打开大学搜题酱 AI 会话');
  delete globalThis.__mockDesktop;
  delete globalThis.__mockAiChatClicked;
});

await test('互评任务优先打开电脑版互评页', async () => {
  globalThis.__mockDesktop = true;
  const { openUrlInTab, isDetailPageUrl } = await import('../extension/background/open-tab.js');
  const mobile =
    'https://mooc1-api.chaoxing.com/mooc-ans/work/phone/eval-list?courseId=2&classId=3&cpi=4&workRelationId=88&enc=x';
  assert.equal(isDetailPageUrl(mobile), true);
  const res = await openUrlInTab(mobile);
  assert.equal(res.ok, true);
  assert.equal(res.desktop, true, '互评应走电脑版');
  assert.ok(/\/mooc-ans\/mooc2\/work\/eval-list/.test(res.url), '应落在电脑版互评列表');
  delete globalThis.__mockDesktop;
});

await test('考试优先打开电脑版考试页', async () => {
  const { openUrlInTab } = await import('../extension/background/open-tab.js');
  const detail =
    'https://mooc1-api.chaoxing.com/exam-ans/exam/phone/task-exam?taskrefId=10526320&courseId=265599301&classId=150849619&cpi=423390678&from=examlist';
  const res = await openUrlInTab(detail);
  assert.equal(res.ok, true);
  assert.equal(res.desktop, true, '考试也应优先走电脑版');
  assert.ok(/examnotes/.test(res.url), '应落在电脑版考试说明/作答入口');
});

await test('未知消息类型返回错误', async () => {
  const response = await new Promise((resolve) => {
    listeners.message[0]({ type: 'NOT_A_REAL_TYPE' }, {}, resolve);
  });
  assert.equal(response.ok, false);
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
