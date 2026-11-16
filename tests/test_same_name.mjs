// 测试 v1.2.23 修复的三个真实 bug。
//
// 背景（用户反馈 + 截图核实）：
// 机器学习实验2「实验2 PCA降维」明明交了，却始终显示
// 「只找到题目区的教师材料」。截图对比暴露了根因：
//
//   题目区：2.降维-机器学习实验报告.docx   23.18K  ← 教师模板
//   作答区：2.降维-机器学习实验报告.docx   82.29K  ← 学生提交
//
// 1) 两个文件**同名**，旧去重键 `name || objectid` 把学生那条覆盖掉了。
// 2) 整个题目（题干+作答编辑器）都包在 .TiMu 里，一趟扫描会先撞到外层 .TiMu
//    把作答区附件判成 question。
// 3) 富文本编辑区 iframe（javascript:void）异步写入，读太早就是空的。
//
// 本文件用最小 DOM 假件复刻这三个场景，锁住修复。

import assert from 'node:assert';

let pass = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ---------- 复刻 1：去重键 ---------- */
// 与 report-check.js 的 pushAtt 保持同构，便于独立验证键的选择。
function makePushAtt() {
  const seen = new Map();
  const pushAtt = (objectid, name, type, filesize, zone) => {
    if (!objectid && !name) return;
    const key = objectid || name; // ← 被验证的这行
    const prev = seen.get(key);
    const prevSize = prev ? Number(String(prev.filesize || '').replace(/[^\d.]/g, '')) || 0 : -1;
    const size = Number(String(filesize || '').replace(/[^\d.]/g, '')) || 0;
    const prevZone = prev && prev.zone ? prev.zone : 'unknown';
    const nextZone = zone || 'unknown';
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
  return { seen, pushAtt };
}

test('同名但 objectid 不同的两个文件都应被保留', () => {
  const { seen, pushAtt } = makePushAtt();
  // 题目区模板（23.18K）与作答区提交（82.29K）同名
  pushAtt('a'.repeat(32), '2.降维-机器学习实验报告.docx', 'docx', '23.18K', 'question');
  pushAtt('b'.repeat(32), '2.降维-机器学习实验报告.docx', 'docx', '82.29K', 'answer');

  assert.strictEqual(seen.size, 2, '同名文件必须保留两条，否则学生报告被吞');
  const zones = [...seen.values()].map((a) => a.zone).sort();
  assert.deepStrictEqual(zones, ['answer', 'question']);
});

test('同 objectid 重复采集仍按大小/区域择优（不产生重复项）', () => {
  const { seen, pushAtt } = makePushAtt();
  const oid = 'c'.repeat(32);
  pushAtt(oid, '报告.docx', '', '', 'unknown');
  pushAtt(oid, '报告.docx', 'docx', '50K', 'answer');
  assert.strictEqual(seen.size, 1);
  const only = [...seen.values()][0];
  assert.strictEqual(only.zone, 'answer', 'unknown 应被明确的区域覆盖');
});

test('两种完全同名同 objectid 的重复项只留一条', () => {
  const { seen, pushAtt } = makePushAtt();
  const oid = 'd'.repeat(32);
  pushAtt(oid, 'x.docx', 'docx', '10K', 'answer');
  pushAtt(oid, 'x.docx', 'docx', '10K', 'answer');
  assert.strictEqual(seen.size, 1);
});

/* ---------- 复刻 2：两趟扫描的区域判定 ---------- */
const ZONE_ANSWER_RE =
  /(mark_answer|stuanswer|stu_answer|answercontent|myanswer|answersheet|edui|ueditor|ans-editor|ans-attach-ct|ans-insertfile|froala|(?:^|[\s_-])answer(?:$|[\s_-]))/i;
const ZONE_QUESTION_RE =
  /(questionli|timu|mark_item|mark_name|mark_description|questionitem|question_?list)/i;

// 最小节点：只要有 className/id/parentElement 就能跑 zoneOfNode
function node(cls, parent) {
  return { className: cls || '', id: '', parentElement: parent || null };
}

function zoneOfNode(n, inheritedZone) {
  const tokenOf = (el) => (String(el.className || '') + ' ' + String(el.id || '')).trim();
  let cur = n;
  for (let depth = 0; cur && depth < 20; depth += 1) {
    const token = tokenOf(cur);
    if (token && ZONE_ANSWER_RE.test(token)) return 'answer';
    cur = cur.parentElement;
  }
  cur = n;
  for (let depth = 0; cur && depth < 20; depth += 1) {
    const token = tokenOf(cur);
    if (token && ZONE_QUESTION_RE.test(token)) return 'question';
    cur = cur.parentElement;
  }
  return inheritedZone || 'unknown';
}

test('作答区附件嵌在 .TiMu 内时仍判为 answer（两趟扫描的核心）', () => {
  // 真实结构：.TiMu > ... > .mark_table > 富文本编辑器 .edui-body-container > 附件
  const tiMu = node('TiMu questionLi');
  const table = node('mark_table', tiMu);
  const editor = node('edui-body-container', table);
  const att = node('ans-attach-online', editor);
  assert.strictEqual(zoneOfNode(att), 'answer', '应先命中编辑器容器，而不是外层 .TiMu');
});

test('纯题目区附件仍判为 question', () => {
  const tiMu = node('TiMu questionLi');
  const att = node('ans-attach-online', node('mark_name', tiMu));
  assert.strictEqual(zoneOfNode(att), 'question');
});

test('没有任何区域标记时回退到继承值', () => {
  const plain = node('');
  assert.strictEqual(zoneOfNode(plain, 'answer'), 'answer');
  assert.strictEqual(zoneOfNode(plain, ''), 'unknown');
  assert.strictEqual(zoneOfNode(plain), 'unknown');
});

test('富文本编辑器容器类名被识别为作答区', () => {
  for (const cls of ['edui-body-container', 'ueditor-body', 'ans-editor', 'froala-element']) {
    assert.strictEqual(zoneOfNode(node(cls)), 'answer', cls + ' 应算作答区');
  }
});

/* ---------- 复刻 3：HTML 兜底的双向正则 ---------- */
const fileExtRe = String.raw`[^"',}<]{1,120}\.(?:docx?|pdf|zip|rar|pptx?|xlsx?)`;
const fwdRe = new RegExp(
  String.raw`objectid["'\s:=]+([0-9a-f]{32})[^}]{0,600}?(?:name|filename)["'\s:=]+(` + fileExtRe + ')',
  'gi'
);
const revRe = new RegExp('(' + fileExtRe + String.raw`)[^}]{0,600}?objectid["'\s:=]+([0-9a-f]{32})`, 'gi');

test('正向顺序：objectid 在前、文件名在后', () => {
  const html = `data='{"objectid":"${'e'.repeat(32)}","name":"报告.docx"}'`;
  const m = fwdRe.exec(html);
  fwdRe.lastIndex = 0;
  assert.ok(m, '应能匹配 objectid 在前的写法');
  assert.strictEqual(m[1], 'e'.repeat(32));
  assert.strictEqual(m[2], '报告.docx');
});

test('反向顺序：文件名在前、objectid 在后', () => {
  const html = `data='{"name":"报告.docx","objectid":"${'f'.repeat(32)}"}'`;
  const m = revRe.exec(html);
  revRe.lastIndex = 0;
  assert.ok(m, '应能匹配文件名在前的写法');
  assert.strictEqual(m[1], '报告.docx');
  assert.strictEqual(m[2], 'f'.repeat(32));
});

test('两段同名不同 objectid 的 HTML 能分别捞出（不被覆盖）', () => {
  const html =
    `{"objectid":"${'1'.repeat(32)}","name":"2.降维-机器学习实验报告.docx"}` +
    `{"objectid":"${'2'.repeat(32)}","name":"2.降维-机器学习实验报告.docx"}`;
  const oids = [];
  let m;
  while ((m = fwdRe.exec(html)) !== null) oids.push(m[1]);
  fwdRe.lastIndex = 0;
  assert.strictEqual(oids.length, 2, '两个不同 objectid 都应被捞出');
  assert.notStrictEqual(oids[0], oids[1]);
});

/* ---------- 复刻 4：同名按大小择优兜底 ---------- */
// 即使区域判定完全失败（两边都 unknown），也要靠文件大小纠正：
// 空白模板不可能比填好的成品大。
function applySizeFallback(atts) {
  const byName = new Map();
  for (const a of atts) {
    const n = String(a.name || '').toLowerCase();
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(a);
  }
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const zones = new Set(group.map((a) => a.zone));
    const allUnknown = zones.size === 1 && zones.has('unknown');
    if (zones.size < 2 && !allUnknown) continue;
    const biggest = group.reduce((x, y) => (y.size > x.size ? y : x));
    if (biggest.zone === 'answer') continue;
    biggest.zone = 'answer';
    for (const a of group) {
      if (a !== biggest) a.zone = 'question';
    }
  }
  return atts;
}

test('两边都是 unknown 时，同名文件中更大的判为作答', () => {
  const atts = [
    { name: '2.降维-机器学习实验报告.docx', size: 23738, zone: 'unknown' }, // 23.18K 模板
    { name: '2.降维-机器学习实验报告.docx', size: 84265, zone: 'unknown' }, // 82.29K 提交
  ];
  applySizeFallback(atts);
  const biggest = atts.find((a) => a.size === 84265);
  const smaller = atts.find((a) => a.size === 23738);
  assert.strictEqual(biggest.zone, 'answer', '大文件应是学生提交的');
  assert.strictEqual(smaller.zone, 'question', '小文件应是教师模板');
});

test('超过两个同名文件时仍只留最大的一个作答', () => {
  const atts = [
    { name: 'r.docx', size: 100, zone: 'unknown' },
    { name: 'r.docx', size: 900, zone: 'unknown' },
    { name: 'r.docx', size: 500, zone: 'unknown' },
  ];
  applySizeFallback(atts);
  const answers = atts.filter((a) => a.zone === 'answer');
  assert.strictEqual(answers.length, 1);
  assert.strictEqual(answers[0].size, 900);
});

test('不同名文件不干预区域判定', () => {
  const atts = [
    { name: 'a.docx', size: 900, zone: 'unknown' },
    { name: 'b.docx', size: 100, zone: 'unknown' },
  ];
  applySizeFallback(atts);
  assert.strictEqual(atts[0].zone, 'unknown', '不同名时不应擅自改区域');
  assert.strictEqual(atts[1].zone, 'unknown');
});

test('同名且已在同一区域时不干预', () => {
  const atts = [
    { name: 'x.docx', size: 900, zone: 'answer' },
    { name: 'x.docx', size: 100, zone: 'answer' },
  ];
  applySizeFallback(atts);
  assert.ok(atts.every((a) => a.zone === 'answer'), '同区域已明确，不该改');
});

/* ---------- 跑用例 ---------- */
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
console.log(`\n通过 ${pass} / ${cases.length}`);
