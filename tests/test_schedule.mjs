/**
 * 课表解析 + 课程过滤测试。
 *
 * 运行：node tests/test_schedule.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import '../extension/shared/xlsx.js';
import {
  normalizeCourseName,
  matchCourse,
  filterItemsBySchedule,
  normalizeScheduleCourses,
} from '../extension/background/course-filter.js';

const CX = globalThis.CXSchedule;
const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures');

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
    console.log('     ', e && e.message ? e.message : e);
  }
}

function readFixture(name) {
  const buf = readFileSync(join(FIX, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/* ---------------- xlsx 解析 ---------------- */
await test('解析 xlsx 课表并提取课程名', async () => {
  const result = await CX.parseFile({
    name: 'schedule.xlsx',
    buffer: readFixture('schedule.xlsx'),
  });
  assert.ok(result.rows.length >= 5, '应解析出多行');
  const names = result.candidates.map((c) => c.name);
  for (const expected of ['高等数学', '大学英语', '线性代数', '大学物理', '数据结构', '体育', '单片机原理']) {
    assert.ok(names.includes(expected), '候选应包含 ' + expected + '，实际: ' + names.join(' / '));
  }
  // 教师/教室不应作为课程名候选（每格取第一个像课程名的片段）
  assert.ok(!names.some((n) => n.includes('张老师')), '不应包含教师名');
  assert.ok(!names.some((n) => n.includes('教A101')), '不应包含教室');
});

await test('解析合并单元格的 xlsx', async () => {
  const result = await CX.parseFile({
    name: 'schedule-merged.xlsx',
    buffer: readFixture('schedule-merged.xlsx'),
  });
  const names = result.candidates.map((c) => c.name);
  assert.ok(
    names.some((n) => n.includes('习近平')),
    '应解析出长课程名，实际: ' + names.join(' / ')
  );
  assert.ok(names.some((n) => n.includes('计算机网络')), '应解析出计算机网络');
});

await test('解析 GBK 编码 CSV', async () => {
  const result = await CX.parseFile({
    name: 'schedule-gbk.csv',
    buffer: readFixture('schedule-gbk.csv'),
  });
  const names = result.candidates.map((c) => c.name);
  assert.ok(names.includes('高等数学'), 'GBK CSV 应正确解码，实际: ' + names.join(' / '));
  assert.ok(names.includes('线性代数'));
});

await test('解析真实教务格式课表（一格多门课 + 汇总行）', async () => {
  const result = await CX.parseFile({
    name: 'schedule-format.xlsx',
    buffer: readFixture('schedule-format.xlsx'),
  });
  const names = result.candidates.map((c) => c.name);
  for (const expected of [
    '高等数学',
    '线性代数',
    '大学英语',
    '计算机组成原理',
    '操作系统',
    '数据结构',
    '形势与政策Ⅴ',
    '习近平新时代中国特色社会主义思想概论',
  ]) {
    assert.ok(names.includes(expected), '应包含 ' + expected + '，实际: ' + names.join(' / '));
  }
  for (const noise of ['节次', '星期一', '上午', '2026-2027年第1学期', '专业：', '课表', '注--']) {
    assert.ok(!names.some((n) => n.includes(noise)), '不应包含噪声: ' + noise);
  }
});

await test('解析非法文件报错', async () => {
  let threw = false;
  try {
    await CX.parseFile({ name: 'bad.xlsx', buffer: new TextEncoder().encode('not a zip').buffer });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, '非法 xlsx 应抛错或回退失败');
});

/* ---------------- 课程过滤 ---------------- */
await test('normalizeCourseName 去括号与空白', () => {
  assert.equal(normalizeCourseName(' 高等数学（上） '), '高等数学');
  assert.equal(normalizeCourseName('大学 英语'), '大学英语');
  // 学习通列表真实格式：书名号包裹 + 课程名截断省略号
  assert.equal(normalizeCourseName('《人工智能》'), '人工智能');
  assert.equal(normalizeCourseName('《计算机组成原...》'), '计算机组成原');
  assert.equal(normalizeCourseName('《Web 开发...》'), 'web开发');
});

await test('matchCourse 精确与包含匹配', () => {
  assert.equal(matchCourse('高等数学', ['高等数学']), true);
  assert.equal(matchCourse('高等数学A', ['高等数学']), true);
  assert.equal(matchCourse('高等数学', ['高等数学A']), true);
  assert.equal(matchCourse('单片机原理', ['高等数学']), false);
  // 真实数据：书名号 + 截断课程名
  assert.equal(matchCourse('《计算机组成原...》', ['计算机组成原理']), true);
  assert.equal(matchCourse('《Web 开发...》', ['Web开发技术实践']), true);
  assert.equal(matchCourse('《人工智能》', ['人工智能']), true);
  assert.equal(matchCourse('《数据库原理》', ['人工智能', '操作系统']), false);
});

await test('filterItemsBySchedule 过滤历史课程', () => {
  const items = [
    { course: '高等数学', title: '作业1', type: 'assignment' },
    { course: '单片机原理', title: '上学期作业', type: 'assignment' },
    { course: '', title: '无课程名考试', type: 'exam' },
  ];
  const filtered = filterItemsBySchedule(items, {
    courseFilterEnabled: true,
    scheduleCourses: ['高等数学'],
  });
  assert.equal(filtered.items.length, 2, '应保留高数与无课程名条目');
  assert.equal(filtered.filteredCount, 1, '应过滤掉单片机');
  assert.ok(filtered.items.some((i) => i.title === '上学期作业') === false);
});

await test('filterItemsBySchedule 未启用时不过滤', () => {
  const items = [{ course: '单片机原理', title: 'x' }];
  const filtered = filterItemsBySchedule(items, {
    courseFilterEnabled: false,
    scheduleCourses: ['高等数学'],
  });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.filteredCount, 0);
});

await test('normalizeScheduleCourses 去重限长', () => {
  const list = normalizeScheduleCourses([
    '高等数学',
    ' 高等数学 ',
    '高等数学（上）',
    '',
    '大学英语',
  ]);
  assert.equal(list.length, 1 + 1, '高等数学与高等数学（上）归一化后重复，应去重');
  assert.equal(list[0], '高等数学');
  assert.equal(list[1], '大学英语');
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
