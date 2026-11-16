/**
 * 已截止判定与分组测试：确认「已截止未交」不会进入主待办，也不会被报告检查纳入。
 * 运行：node tests/test_expired.mjs
 */
import assert from 'node:assert/strict';
import { isLabReportItem, isPastDeadline } from '../extension/background/report-check.js';

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
    console.log('     ', e && e.message ? e.message : e);
  }
}

const NOW = 1790000000000;
const HOUR = 3600000;

function isExpiredForTodo(item, now) {
  if (item.deadline !== null && item.deadline <= now) return true;
  if (item.deadline === null && (item.status === '未交' || item.status === '待互评')) return true;
  return false;
}

test('未交且未截止 → 主待办', () => {
  const item = { status: '未交', deadline: NOW + 3 * HOUR };
  assert.equal(isExpiredForTodo(item, NOW), false);
});

test('未交且已截止 → 已截止分组', () => {
  const item = { status: '未交', deadline: NOW - 3 * HOUR };
  assert.equal(isExpiredForTodo(item, NOW), true);
});

test('未交且时间未知 → 已截止分组', () => {
  const item = { status: '未交', deadline: null };
  assert.equal(isExpiredForTodo(item, NOW), true);
});

test('已完成且已截止 → 已完成（不受截止影响）', () => {
  const item = { status: '已完成', deadline: NOW - 3 * HOUR };
  const doneStatuses = ['已完成', '已批阅', '已结束', '待批阅'];
  assert.ok(doneStatuses.includes(item.status), '应归入已完成');
});

test('已截止的未交实验报告不进入报告检查（默认）', () => {
  const expiredLab = {
    type: 'assignment',
    title: '实验四 进程调度算法',
    status: '未交',
    deadline: NOW - 5 * HOUR,
  };
  // 未交本来就不满足 isLabReportItem
  assert.equal(isLabReportItem(expiredLab), false);
  assert.equal(isPastDeadline(expiredLab, NOW), true);
});

test('已提交但已截止的实验报告，默认也不检查', () => {
  const submittedButExpired = {
    type: 'assignment',
    title: '实验三 黑盒测试',
    status: '待批阅',
    deadline: NOW - 5 * HOUR,
  };
  assert.equal(isLabReportItem(submittedButExpired), true, '已提交应满足检查条件');
  assert.equal(isPastDeadline(submittedButExpired, NOW), true, '但已截止，默认跳过');
});

test('已提交且未截止的实验报告照常检查', () => {
  const normal = {
    type: 'assignment',
    title: '实验四 进程调度算法',
    status: '待批阅',
    deadline: NOW + 20 * HOUR,
  };
  assert.equal(isLabReportItem(normal), true);
  assert.equal(isPastDeadline(normal, NOW), false);
});

test('用户反馈场景：操作系统实验四 / 软件测试实验三', () => {
  const items = [
    { type: 'assignment', title: '实验四 进程调度算法', status: '待批阅', course: '《操作系统》', deadline: NOW - 2 * HOUR },
    { type: 'assignment', title: '实验三 白盒测试', status: '未交', course: '《软件测试》', deadline: NOW - 2 * HOUR },
    { type: 'assignment', title: '实验二 P、V原语的模拟实现', status: '待批阅', course: '《操作系统》', deadline: NOW + 30 * HOUR },
  ];
  const checked = items.filter((i) => isLabReportItem(i) && !isPastDeadline(i, NOW));
  assert.equal(checked.length, 1, '只应检查未截止且已提交的那一条');
  assert.equal(checked[0].title, '实验二 P、V原语的模拟实现');
});

test('deadline=null 的已提交报告默认跳过（用户反馈根因）', () => {
  // 真实数据：已过期的实验报告，聚合页不再显示剩余时间 → deadline 为 null
  const expiredReports = [
    { type: 'assignment', title: '实验四 银行家算法模拟', status: '已完成', course: '《操作系统》', deadline: null },
    { type: 'assignment', title: '实验三 进程调度算法', status: '已完成', course: '《操作系统》', deadline: null },
    { type: 'assignment', title: '实验一 环境安装与配置', status: '已完成', course: '《操作系统》', deadline: null },
  ];
  for (const item of expiredReports) {
    assert.equal(
      isPastDeadline(item, NOW),
      true,
      `deadline=null 应视为已截止：${item.title}`
    );
  }
  const checked = expiredReports.filter((i) => isLabReportItem(i) && !isPastDeadline(i, NOW));
  assert.equal(checked.length, 0, '已截止（时间未知）的报告默认不检查');
});

test('未截止且有明确时间点的报告照常检查', () => {
  const items = [
    { type: 'assignment', title: '实验四 银行家算法模拟', status: '已完成', course: '《操作系统》', deadline: NOW + 6 * 24 * HOUR },
    { type: 'assignment', title: '实验9 循环神经网络', status: '已完成', course: '《机器学习》', deadline: NOW + 2 * HOUR },
  ];
  const checked = items.filter((i) => isLabReportItem(i) && !isPastDeadline(i, NOW));
  assert.equal(checked.length, 2, '未截止的应全部检查');
});

test('用户勾选「包含已过截止时间」时不跳过', () => {
  const item = { type: 'assignment', title: '实验四', status: '已完成', course: '《操作系统》', deadline: null };
  assert.equal(isPastDeadline(item, NOW, { treatUnknownAsExpired: false }), false, '关闭保守判定则应视为未截止');
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
