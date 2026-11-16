/**
 * 电脑版作业链接匹配测试：聚合页给的 id 在 taskrefId，电脑版列表用 workId。
 * 这是「作业详情页不是只读视图」的根因。
 *
 * 运行：node tests/test_open_tab.mjs
 */
import assert from 'node:assert/strict';

// 复刻 pageFindTaskUrl 的核心匹配逻辑（页面内函数无法直接单测）
function matchValue(data, wanted, kind) {
  const workKeys = ['workId=', 'workid=', 'taskrefId=', 'workRelationId='];
  const examKeys = ['examId=', 'examid=', 'taskrefId='];
  const keys = kind === 'exam' ? examKeys : workKeys;
  for (const k of keys) {
    const idx = data.indexOf(k);
    if (idx < 0) continue;
    const rest = data.slice(idx + k.length);
    const val = rest.split(/[&#"'\s]/)[0];
    if (val === wanted) return true;
  }
  return false;
}

function pickUrl(found, kind) {
  if (kind === 'peer') {
    return found.find((u) => /\/mooc2\/work\/eval-list\?/i.test(u)) || found[0];
  }
  if (kind === 'work') {
    const view = found.find((u) => /\/mooc2\/work\/view\?/i.test(u));
    if (view) return view;
    const task = found.find((u) => /\/mooc2\/work\/task\?/i.test(u));
    if (task) return task;
    const dowork = found.find((u) => /\/mooc2\/work\/dowork\?/i.test(u));
    return dowork || found[0];
  }
  return found[0];
}

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

test('taskrefId 能匹配到 workId 链接（用户反馈根因）', () => {
  // 聚合页给 workId=56970326（来自 taskrefId），电脑版列表链接用 workId=
  const data = '/mooc-ans/mooc2/work/view?courseId=235991649&workId=56970326&clazzId=151522773';
  assert.equal(matchValue(data, '56970326', 'work'), true);
});

test('参数值必须完全相等，不能前缀误匹配', () => {
  const data = '/mooc-ans/mooc2/work/view?workId=5697032';
  assert.equal(matchValue(data, '56970326', 'work'), false, 'workId=5697032 不应匹配 56970326');
  const data2 = '/mooc-ans/mooc2/work/view?workId=569703260';
  assert.equal(matchValue(data2, '56970326', 'work'), false);
});

test('URL 中 workId 后面跟 & 时能正确截断', () => {
  const data = '/mooc2/work/view?workId=56970326&clazzId=151';
  assert.equal(matchValue(data, '56970326', 'work'), true);
});

test('优先选 view（已提交只读详情）', () => {
  const found = [
    'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=1',
    'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view?workId=1',
  ];
  assert.ok(pickUrl(found, 'work').includes('/view?'));
});

test('只有 dowork 时返回 dowork', () => {
  const found = ['https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?workId=1'];
  assert.ok(pickUrl(found, 'work').includes('/dowork?'));
});

test('互评优先 eval-list', () => {
  const found = [
    'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view?workRelationId=1',
    'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/eval-list?workRelationId=1',
  ];
  assert.ok(pickUrl(found, 'peer').includes('/eval-list?'));
});

test('考试按 examId / taskrefId 匹配', () => {
  const data = '/mooc-ans/exam/test/examcode/examnotes?examId=10526320&courseId=1';
  assert.equal(matchValue(data, '10526320', 'exam'), true);
  assert.equal(matchValue(data, '10526320', 'work'), false, '作业匹配不应命中 examId');
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
