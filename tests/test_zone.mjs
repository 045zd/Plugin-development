/**
 * 附件区域区分测试（v1.2.21）
 *
 * 背景：学习通作业详情页里，题目区的附件是教师给的材料（报告模板、数据集），
 * 作答区的附件才是学生交上去的文件。若把模板当成交上来的报告分析，
 * 模板里栏目大多是空的，就会误判成「报告有问题」。
 *
 * pageInspectReport 是注入页面的自包含函数，这里用最小 DOM 桩来验证 zoneOfNode
 * 的判定逻辑：从附件节点向上找最近的带类名的祖先，先命中 answer 还是 question。
 */
import assert from 'node:assert';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
    passed += 1;
  } catch (e) {
    console.log('FAIL ' + name);
    console.log('    ' + (e && e.message ? e.message : e));
    failed += 1;
  }
}

// ---- 复刻 pageInspectReport 里的 zoneOfNode（与源码保持一致） ----
const ZONE_ANSWER_RE =
  /(mark_answer|stuanswer|stu_answer|answercontent|myanswer|answersheet|(?:^|[\s_-])answer(?:$|[\s_-]))/i;
const ZONE_QUESTION_RE =
  /(questionli|timu|mark_item|mark_name|mark_description|questionitem|question_?list)/i;

function zoneOfNode(node) {
  let cur = node;
  for (let depth = 0; cur && depth < 15; depth += 1) {
    let token = '';
    try {
      token = String(cur.className || '') + ' ' + String(cur.id || '');
    } catch {
      token = '';
    }
    if (token.trim()) {
      if (ZONE_ANSWER_RE.test(token)) return 'answer';
      if (ZONE_QUESTION_RE.test(token)) return 'question';
    }
    cur = cur.parentElement;
  }
  return 'unknown';
}

/** 构造一个最小元素桩：parentElement 链 + className/id */
function makeNode(className, id, parent) {
  return { className: className || '', id: id || '', parentElement: parent || null };
}

// ---- 页面结构复刻（对应人工智能实验二的真实结构） ----
// <div class="TiMu">
//   <iframe class="attach-iframe" filename="人工智能实验报告---实验2-2026.docx">
//   <iframe class="attach-iframe" filename="kmeansSamples.txt">
// </div>
// <div class="mark_answer">
//   <dd class="stuAnswerContent">
//     <iframe class="attach-iframe" filename="人工智能实验报告---实验2-姚腾.docx">
//   </dd>
// </div>
const root = makeNode('', '', null);
const questionZone = makeNode('TiMu questionLi', '', root);
const templateFrame = makeNode('attach-iframe', '', questionZone);
const datasetFrame = makeNode('attach-iframe', '', questionZone);

const answerZone = makeNode('mark_answer', '', root);
const answerDd = makeNode('stuAnswerContent', '', answerZone);
const myReportFrame = makeNode('attach-iframe', '', answerDd);

test('题目区的模板被识别为 question', () => {
  assert.equal(zoneOfNode(templateFrame), 'question');
  assert.equal(zoneOfNode(datasetFrame), 'question');
});

test('作答区的报告被识别为 answer', () => {
  assert.equal(zoneOfNode(myReportFrame), 'answer');
  // 即使中间隔了 dd.stuAnswerContent 也能向上找到 mark_answer
  assert.equal(zoneOfNode(answerDd), 'answer');
});

test('嵌套时以最近的带区域类名的祖先为准', () => {
  // 真实页面里作答区可能整体在 mark_item 内部，此时离附件更近的 mark_answer 应优先
  const outerQuestion = makeNode('mark_item', '', root);
  const innerAnswer = makeNode('mark_answer', '', outerQuestion);
  const frame = makeNode('attach-iframe', '', innerAnswer);
  assert.equal(zoneOfNode(frame), 'answer', '最近的祖先优先');
});

test('两侧都无类名时为 unknown（保守参与分析）', () => {
  const plain = makeNode('attach-iframe', '', makeNode('', '', root));
  assert.equal(zoneOfNode(plain), 'unknown');
});

test('只有 id 没有 class 也能识别', () => {
  const byId = makeNode('', 'answer', root);
  assert.equal(zoneOfNode(byId), 'answer');
  const qById = makeNode('', 'questionLi', root);
  assert.equal(zoneOfNode(qById), 'question');
});

test('超过 15 层的深层嵌套不会误判（返回 unknown）', () => {
  let node = makeNode('mark_answer', '', root);
  for (let i = 0; i < 20; i += 1) node = makeNode('', '', node);
  // mark_answer 在第 21 层，超出搜索深度
  assert.equal(zoneOfNode(node), 'unknown');
});

// ---- 分组逻辑：对应 runReportCheck 里的 questionAtts / answerAtts ----
function splitByZone(atts) {
  const questionAtts = atts.filter((a) => a.zone === 'question');
  const answerAtts = atts.filter((a) => a.zone !== 'question');
  return { questionAtts, answerAtts };
}

test('分组：模板与数据集不进分析，只分析我的报告', () => {
  const { questionAtts, answerAtts } = splitByZone([
    { name: '人工智能实验报告---实验2-2026.docx', zone: 'question', textLen: 0 },
    { name: 'kmeansSamples.txt', zone: 'question', textLen: 0 },
    { name: '人工智能实验报告---实验2-姚腾.docx', zone: 'answer', textLen: 1200 },
  ]);
  assert.equal(questionAtts.length, 2);
  assert.equal(answerAtts.length, 1);
  assert.equal(answerAtts[0].name, '人工智能实验报告---实验2-姚腾.docx');
});

test('分组：unknown 的附件仍参与分析（避免漏检）', () => {
  const { answerAtts } = splitByZone([
    { name: '未知区域.docx', zone: 'unknown', textLen: 500 },
  ]);
  assert.equal(answerAtts.length, 1, 'unknown 应保守计入');
});

test('分组：只有题目区材料视为没交', () => {
  const { questionAtts, answerAtts } = splitByZone([
    { name: '模板.docx', zone: 'question' },
  ]);
  assert.equal(questionAtts.length, 1);
  assert.equal(answerAtts.length, 0, '没有作答附件 → 应判为没交东西');
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
