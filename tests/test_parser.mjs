/**
 * parser.js / notifier.js 纯函数单元测试（在 Node 中直接 import，不依赖 chrome API）。
 *
 * 运行：node tests/test_parser.mjs
 */
import assert from 'node:assert/strict';

import {
  parseDeadline,
  parseRemaining,
  extractDates,
  rowsToItems,
  parseStatus,
  formatDuration,
  mapWorkStatus,
  mapExamStatus,
  aggregateWorkToItems,
  aggregateExamToItems,
} from '../extension/background/parser.js';
import { computeAlerts, humanRemain } from '../extension/background/notifier.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS', name);
  } catch (e) {
    failed += 1;
    console.log('FAIL', name);
    console.log('     ', e.message);
  }
}

const NOW = new Date(2026, 9, 19, 12, 0, 0).getTime(); // 2026-10-19 12:00 本地时间

/* ---------------- parseRemaining ---------------- */
test('parseRemaining 剩余X天Y小时', () => {
  assert.equal(parseRemaining('剩余 2 天 3 小时'), (2 * 24 + 3) * 3600000);
});

test('parseRemaining 剩余X小时Y分钟', () => {
  assert.equal(parseRemaining('剩余 5 小时 30 分钟'), (5 * 60 + 30) * 60000);
});

test('parseRemaining 剩余X分钟', () => {
  assert.equal(parseRemaining('剩余 45 分钟'), 45 * 60000);
});

test('parseRemaining 无匹配返回 null', () => {
  assert.equal(parseRemaining('已完成'), null);
});

/* ---------------- extractDates ---------------- */
test('extractDates 提取两个日期', () => {
  const dates = extractDates('2026-10-10 08:00 至 2026-10-20 23:59');
  assert.equal(dates.length, 2);
  assert.equal(dates[0].text, '2026-10-10 08:00');
  assert.equal(dates[1].text, '2026-10-20 23:59');
});

test('extractDates 单日期', () => {
  const dates = extractDates('截止时间：2026-10-20 23:59');
  assert.equal(dates.length, 1);
});

/* ---------------- parseDeadline ---------------- */
test('parseDeadline 绝对日期（取最后一个作为截止）', () => {
  const r = parseDeadline('2026-10-10 08:00 至 2026-10-20 23:59', NOW);
  assert.ok(r.deadline != null);
  assert.equal(r.deadlineText, '2026-10-20 23:59');
  assert.equal(r.startText, '2026-10-10 08:00');
  const d = new Date(r.deadline);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 20);
});

test('parseDeadline 相对剩余时间', () => {
  const r = parseDeadline('未交 剩余 3 小时 20 分钟', NOW);
  assert.equal(r.deadline, NOW + (3 * 60 + 20) * 60000);
  assert.ok(r.deadlineText.includes('剩余'));
});

test('parseDeadline 优先绝对日期', () => {
  const r = parseDeadline('剩余 1 天 2026-10-20 23:59', NOW);
  assert.equal(r.deadlineText, '2026-10-20 23:59');
});

/* ---------------- parseStatus ---------------- */
test('parseStatus 作业状态', () => {
  assert.equal(parseStatus('未交', 'assignment'), '未交');
  assert.equal(parseStatus('已交', 'assignment'), '已完成');
  assert.equal(parseStatus('已批阅 98分', 'assignment'), '已批阅');
  assert.equal(parseStatus('待批阅', 'assignment'), '待批阅');
  assert.equal(parseStatus('待互评', 'assignment'), '待互评');
  assert.equal(parseStatus('互评中', 'assignment'), '待互评');
  assert.equal(parseStatus('已互评', 'assignment'), '已完成');
});

test('parseStatus 考试状态', () => {
  assert.equal(parseStatus('进行中', 'exam'), '进行中');
  assert.equal(parseStatus('未开始', 'exam'), '未开始');
  assert.equal(parseStatus('已结束', 'exam'), '已结束');
});

/* ---------------- rowsToItems ---------------- */
test('rowsToItems 解析作业行', () => {
  const rows = [
    {
      text: '第3章作业\n未交\n2026-10-10 08:00 至 2026-10-20 23:59',
      link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?id=1',
    },
    { text: '第2章作业\n已批阅\n95 分', link: '' },
  ];
  const items = rowsToItems(rows, { type: 'assignment', course: '高等数学', listUrl: 'https://list' }, NOW);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '第3章作业');
  assert.equal(items[0].status, '未交');
  assert.equal(items[0].course, '高等数学');
  assert.ok(items[0].deadline != null);
  assert.equal(items[1].status, '已批阅');
  assert.equal(items[1].deadline, null);
});

test('rowsToItems 过滤噪声行', () => {
  const rows = [{ text: '全部', link: '' }, { text: '暂无作业', link: '' }];
  const items = rowsToItems(rows, { type: 'assignment', course: '课', listUrl: '' }, NOW);
  assert.equal(items.length, 0);
});

test('rowsToItems key 稳定且去重', () => {
  const row = { text: '第3章作业\n未交\n剩余 2 天', link: '' };
  const a = rowsToItems([row], { type: 'assignment', course: '高数', listUrl: '' }, NOW);
  const b = rowsToItems([row], { type: 'assignment', course: '高数', listUrl: '' }, NOW + 1000);
  assert.equal(a.length, 1);
  assert.equal(a[0].key, b[0].key); // 相对时间不变时 key 稳定
});

/* ---------------- computeAlerts ---------------- */
const CONFIG = {
  reminderHours: [72, 24, 6, 1],
  expiredAlert: true,
};

function item(overrides) {
  return Object.assign(
    {
      key: 'a|课|作业|deadline',
      type: 'assignment',
      course: '高数',
      title: '第3章作业',
      status: '未交',
      deadline: NOW + 5 * 3600000, // 5 小时后
      deadlineText: '',
      url: 'https://example.com',
    },
    overrides
  );
}

test('computeAlerts 命中最近阈值', () => {
  const { alerts } = computeAlerts([item({})], CONFIG, NOW, {});
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].threshold, 6);
});

test('computeAlerts 不重复提醒同一阈值', () => {
  const first = computeAlerts([item({})], CONFIG, NOW, {});
  const second = computeAlerts([item({})], CONFIG, NOW + 1000, first.notified);
  assert.equal(second.alerts.length, 0);
});

test('computeAlerts 剩余时间跨过更紧迫阈值时再次提醒', () => {
  const first = computeAlerts([item({})], CONFIG, NOW, {});
  const later = NOW + 5 * 3600000; // 已过期
  const second = computeAlerts([item({})], CONFIG, later, first.notified);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].kind, 'expired');
});

test('computeAlerts 忽略已完成条目', () => {
  const { alerts } = computeAlerts([item({ status: '已完成' })], CONFIG, NOW, {});
  assert.equal(alerts.length, 0);
});

test('computeAlerts 无截止时间不提醒', () => {
  const { alerts } = computeAlerts([item({ deadline: null })], CONFIG, NOW, {});
  assert.equal(alerts.length, 0);
});

test('computeAlerts 清理消失条目的已提醒记录', () => {
  const first = computeAlerts([item({})], CONFIG, NOW, {});
  assert.equal(Object.keys(first.notified).length, 1);
  const second = computeAlerts([], CONFIG, NOW + 1000, first.notified);
  assert.equal(Object.keys(second.notified).length, 0);
});

test('computeAlerts 直接进入 0.5 小时只发一次最紧迫提醒', () => {
  const soon = item({ deadline: NOW + 0.5 * 3600000 });
  const { alerts, notified } = computeAlerts([soon], CONFIG, NOW, {});
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].threshold, 1);
  // 所有 >=1 的阈值都应标记为已提醒，避免后续重复
  assert.deepEqual([...notified[soon.key]].sort((a, b) => a - b), [1, 6, 24, 72]);
});

/* ---------------- humanRemain / formatDuration ---------------- */
test('humanRemain', () => {
  assert.equal(humanRemain(0.5), '30分钟');
  assert.equal(humanRemain(5.5), '5小时30分钟');
  assert.equal(humanRemain(50), '2天2小时');
  assert.equal(humanRemain(-1), '已过期');
});

test('formatDuration', () => {
  assert.equal(formatDuration(2 * 3600000 + 30 * 60000), '2小时30分钟');
  assert.equal(formatDuration(0), '');
});

/* ---------------- 聚合页状态映射（用户反馈修复） ---------------- */
test('mapWorkStatus 已完成类文本 → 已完成', () => {
  for (const t of ['已完成', '已交', '已提交', '待批阅', '已批阅', '已评分', '未批阅']) {
    assert.equal(mapWorkStatus(t, false, true), '已完成', '文本: ' + t);
  }
});

test('mapWorkStatus 未交类文本 → 未交', () => {
  for (const t of ['未交', '未提交', '未完成', '待完成', '待提交', '去完成']) {
    assert.equal(mapWorkStatus(t, true, true), '未交', '文本: ' + t);
  }
});

test('mapWorkStatus 文本缺失时用 class 标记兜底', () => {
  assert.equal(mapWorkStatus('', true, true), '未交');
  assert.equal(mapWorkStatus('', false, true), '已完成');
  assert.equal(mapWorkStatus('', null, false), '未知');
});

test('mapWorkStatus 互评类状态：待互评未完成，已互评才完成', () => {
  assert.equal(mapWorkStatus('已互评', null, true), '已完成');
  assert.equal(mapWorkStatus('待互评', true, true), '待互评');
  assert.equal(mapWorkStatus('未互评', null, true), '待互评');
  assert.equal(mapWorkStatus('互评中', null, true), '待互评');
});

test('待互评的互评任务应进入待办并触发提醒', () => {
  const rows = [
    {
      title: '实验三 进程调度算法',
      statusText: '待互评',
      statusClass: 'status',
      hasStatusSpan: true,
      uncommitted: true,
      statusCandidates: [
        { text: '待互评', cls: 'status' },
        { text: '《操作系统》', cls: '' },
        { text: '剩余5小时', cls: 'fr' },
      ],
      itemText: '实验三 进程调度算法\n\n待互评\n《操作系统》\n剩余5小时',
      course: '《操作系统》',
      leftTime: '剩余 5 小时',
      link: 'https://mooc1-api.chaoxing.com/mooc-ans/work/phone/eval-list?courseId=265974593&classId=151638641&cpi=423390678&workRelationId=57333121&enc=x',
      stableId: 'workRelationId=57333121&',
    },
  ];
  const items = aggregateWorkToItems(rows, NOW, 'x');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, '待互评');
  assert.ok(items[0].deadline > NOW);
  assert.ok(items[0].key.includes('workRelationId=57333121'), '互评条目 key 应含 workRelationId');
  const { alerts } = computeAlerts(items, CONFIG, NOW, {});
  assert.equal(alerts.length, 1, '待互评任务应触发提醒');
});

test('mapWorkStatus 状态元素缺失时用整条文本兜底（本次修复）', () => {
  // 页面状态元素没取到，但条目文本里含状态词
  assert.equal(mapWorkStatus('', null, false, '单片机原理作业\n已完成\n2026-10-18'), '已完成');
  assert.equal(mapWorkStatus('', null, false, '第3章作业\n未交\n剩余 2 天'), '未交');
  // 状态候选（其他 span）里含状态词
  assert.equal(mapWorkStatus('', null, false, '', ['已完成', '单片机原理']), '已完成');
  assert.equal(mapWorkStatus('', null, false, '', ['未交', '高数']), '未交');
  // li 的 class 线索
  assert.equal(mapWorkStatus('', null, false, '', [], 'work-item work-done'), '已完成');
  // 都没有 → 未知
  assert.equal(mapWorkStatus('', null, false, '单片机原理作业\n2026-10-18'), '未知');
});

test('aggregateWorkToItems 处理状态元素缺失的已完成作业（用户反馈场景）', () => {
  const rows = [
    {
      title: '单片机原理作业',
      statusText: '',
      hasStatusSpan: false,
      uncommitted: null,
      statusCandidates: [],
      itemText: '单片机原理作业\n已完成\n提交时间 2026-10-18 20:30',
      course: '单片机原理',
      leftTime: '',
      link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=777',
      stableId: 'workId=777',
    },
  ];
  const items = aggregateWorkToItems(rows, NOW, 'x');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, '已完成', '整条文本含“已完成”应判为已完成');
  const { alerts } = computeAlerts(items, CONFIG, NOW, {});
  assert.equal(alerts.length, 0, '已完成的作业不应产生提醒');
});

test('用户反馈场景：已完成的单片机作业不再被当成未完成', () => {
  const rows = [
    {
      title: '单片机原理作业',
      statusText: '已完成',
      hasStatusSpan: true,
      uncommitted: false,
      course: '单片机原理',
      leftTime: '剩余 2 天',
      link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=555',
      stableId: 'workId=555',
    },
    {
      title: '第3章作业',
      statusText: '未交',
      hasStatusSpan: true,
      uncommitted: true,
      course: '高等数学',
      leftTime: '剩余 5 小时',
      link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=666',
      stableId: 'workId=666',
    },
  ];
  const items = aggregateWorkToItems(rows, NOW, 'https://mooc1-api.chaoxing.com/work/stu-work');
  assert.equal(items.length, 2);
  assert.equal(items[0].status, '已完成');
  assert.equal(items[1].status, '未交');
  // 已完成的不应进入提醒
  const { alerts } = computeAlerts(items, CONFIG, NOW, {});
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].item.title, '第3章作业');
});

test('aggregateWorkToItems 解析剩余时间与链接', () => {
  const rows = [
    {
      title: '实验报告',
      statusText: '未交',
      hasStatusSpan: true,
      uncommitted: true,
      course: '物理',
      leftTime: '剩余 3 天 2 小时',
      link: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=1',
      stableId: 'workId=1',
    },
  ];
  const items = aggregateWorkToItems(rows, NOW, 'x');
  assert.ok(items[0].deadline != null);
  assert.equal(items[0].deadline, NOW + (3 * 24 + 2) * 3600000);
  assert.equal(items[0].url, 'https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=1');
  assert.equal(items[0].course, '物理');
});

test('mapExamStatus', () => {
  assert.equal(mapExamStatus('已完成', false), '已完成');
  assert.equal(mapExamStatus('待批阅', false), '已完成');
  assert.equal(mapExamStatus('进行中', false), '进行中');
  assert.equal(mapExamStatus('未开始', false), '未开始');
  assert.equal(mapExamStatus('', true), '已结束');
  assert.equal(mapExamStatus('', false), '未知');
});

test('aggregateExamToItems 解析考试时间与过期', () => {
  const rows = [
    {
      title: '期中考试',
      timeLeft: '2026-10-22 14:00 至 2026-10-22 16:00',
      statusText: '进行中',
      expired: false,
      link: 'https://x/exam?examId=1',
      stableId: 'examId=1',
    },
    {
      title: '旧考试',
      timeLeft: '已结束',
      statusText: '',
      expired: true,
      link: 'https://x/exam?examId=2',
      stableId: 'examId=2',
    },
  ];
  const items = aggregateExamToItems(rows, NOW, 'fallback');
  assert.equal(items.length, 2);
  assert.equal(items[0].status, '进行中');
  assert.ok(items[0].deadline != null);
  assert.equal(items[1].status, '已结束');
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
