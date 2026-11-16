// 测试互评阶段识别与页面诊断文案。
//
// 背景（用户反馈）：操作系统实验四的提交早已截止，但因为处在互评阶段，
// 聚合页仍显示「剩余 6 天 2 小时」——那是**互评**截止时间。
// 旧逻辑只看 deadline，于是把它当成"还没截止"，去检查一份根本不存在的报告，
// 得到「只有题目区的教师材料」这种无意义的结论。

import assert from 'node:assert';
import { isPeerReviewItem, describePageDebug } from '../extension/background/report-check.js';

let pass = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------- isPeerReviewItem ----------

test('状态含「已互评」→ 是互评阶段', () => {
  assert.strictEqual(isPeerReviewItem({ status: '已互评' }), true);
});

test('状态含「待互评」→ 是互评阶段', () => {
  assert.strictEqual(isPeerReviewItem({ status: '待互评' }), true);
});

test('extra 里出现「已互评」也能识别（真实数据形态）', () => {
  // 实测存储：extra = "剩余146小时5分钟 | 已互评 | 《操作系统》 / 剩余146小时5分钟"
  assert.strictEqual(
    isPeerReviewItem({
      status: '已完成',
      extra: '剩余146小时5分钟 | 已互评 | 《操作系统》 / 剩余146小时5分钟',
      deadlineText: '剩余6天2小时',
    }),
    true
  );
});

test('deadlineText 含「互评」→ 是互评阶段', () => {
  assert.strictEqual(isPeerReviewItem({ deadlineText: '互评剩余3天' }), true);
});

test('普通已完成作业不算互评', () => {
  assert.strictEqual(
    isPeerReviewItem({
      status: '已完成',
      extra: '剩余2天 | 已完成 | 《机器学习》',
      deadlineText: '剩余2天',
    }),
    false
  );
});

test('未交作业不算互评', () => {
  assert.strictEqual(isPeerReviewItem({ status: '未交', deadlineText: '剩余3天' }), false);
});

test('null / 空对象安全返回 false', () => {
  assert.strictEqual(isPeerReviewItem(null), false);
  assert.strictEqual(isPeerReviewItem({}), false);
  assert.strictEqual(isPeerReviewItem(undefined), false);
});

// ---------- describePageDebug ----------

test('无 debug 时返回空字符串', () => {
  assert.strictEqual(describePageDebug(null), '');
  assert.strictEqual(describePageDebug({}), '');
  assert.strictEqual(describePageDebug('nope'), '');
});

test('能说明 iframe 的采集情况', () => {
  const s = describePageDebug({
    totalIframes: 3,
    iframeScan: { total: 3, sameOrigin: 2, crossOrigin: 1, scanned: 2, found: 4 },
  });
  assert.match(s, /3 个 iframe/);
  assert.match(s, /同源 2/);
  assert.match(s, /跨域 1/);
  assert.match(s, /补采到 4 个附件/);
});

test('全部选择器都没命中时说清楚', () => {
  const s = describePageDebug({
    totalIframes: 0,
    answerSels: { markAnswer: 0, stuAnswerContent: 0, textwrap: 0, markItem: 0 },
  });
  assert.match(s, /全部作答区选择器均未命中/);
  assert.match(s, /\.mark_answer/);
});

test('部分命中时列出命中项', () => {
  const s = describePageDebug({
    totalIframes: 0,
    answerSels: { markAnswer: 1, stuAnswerContent: 2, textwrap: 0, markItem: 0 },
  });
  assert.match(s, /命中/);
  assert.match(s, /\.mark_answer×1/);
  assert.match(s, /dd\.stuAnswerContent×2/);
});

// ---------- 跑用例 ----------

for (const { name, fn } of cases) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    console.log('  FAIL ' + name);
    console.log('       ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} 通过`);
