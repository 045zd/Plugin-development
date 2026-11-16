// v1.2.24 模板比对测试。
//
// 目标是替掉不可靠的"标题 2 字片段重合率"判据。
// 核心场景就是真实误报：人工智能实验二，报告里「实验名称」写的是
// 「聚类算法实现」，而作业标题是「人工智能实验报告-实验2-2026」，
// 字符串相似度极低 → 旧逻辑报"内容不符"。但报告其实是按模板填的，
// 栏目结构完全一致，属于**交对了**。
import assert from 'node:assert/strict';

const {
  extractTemplateSkeleton,
  matchTemplate,
  analyzeReportText,
  pickTemplateSkeleton,
} = await import('../extension/background/report-check.js');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (e && e.message ? e.message : e));
  }
}

// ── 还原真实教师模板：栏目齐全，内容空白，带说明性要求文字 ──
const TEMPLATE_TEXT = [
  '示例大学实验报告（理工类）',
  '二级学院：示例学院专业：计算机科学与技术',
  '课程名称：机器学习班级：计算机2301',
  '学号：姓名：',
  '实验名称聚类算法实现',
  '实验目的1.掌握K-Means聚类的基本原理；2.能够实现并调参。',
  '实验内容和步骤：________________________________________________',
  '要求：本次实验针对聚类算法进行设计，要求编写程序并进行测试。',
  '实验结果及分析：________________________________________________',
  '成绩和评语：',
  '指导教师：________________审阅日期：________________',
].join('');

// ── 用户真实提交的报告：栏目骨架与模板一致，标题措辞不同 ──
const USER_REPORT = [
  '示例大学实验报告（理工类）',
  '二级学院：示例学院专业：计算机科学与技术',
  '课程名称：机器学习班级：计算机2301',
  '学号：20230000000姓名：张三',
  '实验名称聚类算法实现',
  '实验目的本次实验通过实现K-Means算法，理解无监督学习中簇划分的基本思想，',
  '并掌握如何用轮廓系数评价聚类质量。',
  '实验内容和步骤：1．数据准备使用sklearn生成三簇二维样本点共300个。',
  '2．算法实现按欧氏距离把样本分配到最近的质心，迭代更新质心直至收敛。',
  '3．参数分析分别取k=2,3,4,5运行，比较轮廓系数与簇内平方和。',
  '4．结果观察k=3时轮廓系数最高为0.62，与样本真实簇数一致。',
  '代码结构清晰，注释完整，运行稳定无异常。',
  '实验结果及分析：1．运行结果图1为k=3时的聚类散点图与质心位置。',
  '2．结果分析随着k增大簇内平方和单调下降，但轮廓系数在k=3达到峰值后回落，',
  '说明k=3是最合理的簇数，这与构造数据时的真实簇数完全吻合。',
  '成绩和评语：',
  '指导教师：________________审阅日期：________________',
].join('');

console.log('extractTemplateSkeleton');
test('能识别模板里的核心栏目', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  assert.ok(s.contentHeadings.includes('实验内容和步骤'), '应识别出实验内容和步骤');
  assert.ok(s.contentHeadings.includes('实验结果及分析'), '应识别出实验结果及分析');
  // 「实验目的」不在 CONTENT_HEADINGS（它不是"内容栏目"），但必须进 compareHeadings，
  // 否则模板里最稳定的这一栏不参与骨架比对。
  assert.ok(s.headings.includes('实验目的'), '应识别出实验目的');
  assert.ok(s.compareHeadings.includes('实验目的'), '实验目的应参与骨架比对');
});
test('比对集合排除成绩/指导教师/审阅日期这类固定表格项', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  assert.ok(!s.compareHeadings.includes('成绩和评语'), '成绩栏与实验内容无关，不应计入覆盖率');
  assert.ok(!s.compareHeadings.includes('指导教师'));
  assert.ok(!s.compareHeadings.includes('审阅日期'));
});
test('栏目标题去重且保持顺序', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  assert.equal(new Set(s.headings).size, s.headings.length, '不应有重复栏目');
});
test('教师预填的实验名称被提取为权威标题', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  assert.equal(s.presetTitle, '聚类算法实现');
});
test('模板里的填写提示不会被当成标题', () => {
  const s = extractTemplateSkeleton(
    '课程名称：机器学习实验名称（请填写实验名称）实验目的：____'
  );
  assert.equal(s.presetTitle, '', '「请填写实验名称」是提示，不是标题');
});
test('空文本返回空骨架而不是崩溃', () => {
  const s = extractTemplateSkeleton('');
  assert.deepEqual(s.headings, []);
  assert.equal(s.presetTitle, '');
});
test('非报告类文档（数据集说明）识别不出栏目', () => {
  const s = extractTemplateSkeleton('x1,y1,x2,y2,label\n1.2,3.4,5.6,7.8,0');
  assert.ok(s.headings.length < 2, 'CSV 不应被当成报告模板');
});

console.log('matchTemplate');
test('按模板填写的报告覆盖率高', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  const report = analyzeReportText(USER_REPORT, { course: '机器学习', title: '实验2' }, 80000);
  const m = matchTemplate(report.sections.map((x) => x.name), s);
  assert.ok(m.usable, '模板应可用');
  assert.ok(m.coverage >= 0.6, `覆盖率应 >= 0.6，实际 ${m.coverage}`);
});
test('完全没有模板栏目时 coverage 为 0 且不可用', () => {
  const m = matchTemplate(['实验目的'], { contentHeadings: [] });
  assert.equal(m.usable, false);
  assert.equal(m.coverage, 0);
  assert.equal(m.level, null, '没有模板时不应改变判定');
});
test('栏目对不上时给出 warn 级提示', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  // 只写了一个栏目，其余全缺
  const m = matchTemplate(['实验目的'], s);
  assert.equal(m.level, 'warn');
  assert.ok(m.missing.length > 0);
});
test('覆盖率过低时列出缺失栏目名', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  const m = matchTemplate(['实验目的'], s);
  assert.ok(m.note.includes('模板有'), '提示里应说明模板有哪些栏目');
});

console.log('analyzeReportText + 模板（核心：修掉人工智能实验二误报）');
test('★ 标题措辞不同但按模板填写时，不再报 titleMismatch', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  // 作业标题是「人工智能实验报告-实验2-2026」，报告里写「聚类算法实现」，
  // 字符串相似度极低——旧逻辑在这里误报。
  const r = analyzeReportText(
    USER_REPORT,
    { course: '机器学习', title: '人工智能实验报告-实验2-2026' },
    80000,
    s
  );
  assert.equal(r.titleMismatch, false, '有模板且结构一致时不应报标题不符');
  assert.ok(
    r.reasons.some((x) => x.includes('栏目结构一致')),
    '应说明与模板结构一致，实际：' + JSON.stringify(r.reasons)
  );
});
test('没有模板时仍保留标题提示（无模板即无更好依据）', () => {
  const r = analyzeReportText(
    USER_REPORT,
    { course: '机器学习', title: '人工智能实验报告-实验2-2026' },
    80000
  );
  assert.equal(r.titleMismatch, true, '无模板时保留旧行为，避免漏报');
});
test('模板比对结果随分析结果返回，供设置页展示', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  const r = analyzeReportText(USER_REPORT, { course: '机器学习', title: '实验2' }, 80000, s);
  assert.ok(r.template && r.template.usable, '结果里应带模板比对信息');
  assert.ok(typeof r.template.coverage === 'number');
});
test('模板预填标题会作为 templateTitle 返回', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  const r = analyzeReportText(USER_REPORT, { course: '机器学习', title: '实验2' }, 80000, s);
  assert.equal(r.templateTitle, '聚类算法实现');
});
test('模板结构一致时不会把 ok 降成 warn', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  const r = analyzeReportText(USER_REPORT, { course: '机器学习', title: '实验2' }, 80000, s);
  assert.equal(r.level, 'ok', '按模板填写的完整报告应判 ok');
});
test('结构不符的报告降为 warn 并说明原因', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  // 只有实验目的有内容，其余栏目全空
  const thin = '课程名称：机器学习实验名称聚类算法实现实验目的了解聚类的基本概念。';
  const r = analyzeReportText(thin, { course: '机器学习', title: '实验2' }, 5000, s);
  assert.notEqual(r.level, 'ok', '内容缺失时不应判 ok');
});

// ── v1.2.25：模板确认结构一致时，不得再输出自相矛盾的「未识别到实验栏目」 ──
//
// 真实 bug：报告是表格，转纯文本后栏目名与内容直接相接，
// 严格正则可以一个都匹配不到（sections 只剩「成绩和评语」这类固定项，
// 它们不在 CONTENT_HEADINGS 里 → presentContent 为空），
// 于是走了「未识别到标准实验栏目」分支；
// 而模板比对用宽松匹配明明命中 3/3 栏 → 用户同时看到两条相反的结论。
console.log('templateCovered 抑制矛盾结论（v1.2.25）');
test('表格报告严格匹配全落空时，不再报「未识别到标准实验栏目」', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  // 整篇栏目名都与内容直接相接，严格正则一个内容栏目都切不出来
  const tableReport =
    '示例大学实验报告（理工类）课程名称：机器学习班级：计算机2301' +
    '学号：姓名：实验名称机器学习与BP神经网络' +
    '实验目的1.掌握BP神经网络的前向传播与反向传播原理；2.能够独立实现网络训练流程并分析超参数对结果的影响；3.理解梯度消失与梯度爆炸现象的成因及缓解手段。' +
    '实验内容和步骤用Python从零实现三层BP神经网络，采用Sigmoid激活函数与交叉熵损失，在MNIST手写数字数据集上训练，学习率取0.1，批量大小64，训练20轮。' +
    '实验结果及分析训练20轮后验证集准确率达到97.2%，训练损失从2.31下降到0.08，验证损失从2.29下降到0.11，未出现明显过拟合。' +
    '成绩和评语：指导教师：审阅日期：';
  const r = analyzeReportText(tableReport, { course: '机器学习', title: '实验2' }, 380000, s);
  // 前提确认：严格匹配确实一个"内容栏目"都没切出来（否则这个用例没测到目标分支）。
  // 只切到「成绩和评语/指导教师/审阅日期」这类固定表格项，它们不计入内容栏目。
  const CONTENT = new Set([
    '实验内容和步骤', '实验内容及步骤', '实验内容', '实验步骤', '实验过程',
    '实验结果及分析', '实验结果与分析', '实验结果', '实验分析',
    '实验总结', '心得体会', '结论',
  ]);
  assert.equal(
    r.sections.filter((x) => CONTENT.has(x.name)).length,
    0,
    '严格匹配不应切出任何内容栏目，实际：' + JSON.stringify(r.sections)
  );
  assert.ok(
    !r.reasons.some((x) => x.includes('未识别到')),
    '模板已确认结构一致，不应再说未识别到栏目，实际：' + JSON.stringify(r.reasons)
  );
  assert.ok(
    r.reasons.some((x) => x.includes('栏目结构一致')),
    '应保留模板结构一致的结论'
  );
  assert.equal(r.level, 'ok', '按模板填写、正文充足应判 ok');
});
test('模板结构一致但正文极少时才判坏', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  // 只有 70 个有效字符：结构对得上，但内容几乎没有
  const tiny =
    '课程名称：机器学习实验名称机器学习与BP神经网络实验目的了解BP网络的基本概念。' +
    '实验内容和步骤实现一个简单的网络。实验结果及分析准确率百分之九十七。';
  const r = analyzeReportText(tiny, { course: '机器学习', title: '实验2' }, 380000, s);
  assert.equal(r.level, 'bad', '模板对得上但正文几乎为空，应判坏');
  assert.ok(
    r.reasons.some((x) => x.includes('正文几乎没有内容')),
    '应说明正文几乎没有内容，实际：' + JSON.stringify(r.reasons)
  );
});
test('模板结构一致但正文较少时降为 warn', () => {
  const s = extractTemplateSkeleton(TEMPLATE_TEXT);
  const short =
    '课程名称：机器学习实验名称机器学习与BP神经网络实验目的了解BP网络的基本概念和训练流程。' +
    '实验内容和步骤用Python实现三层网络并在MNIST上训练，记录损失曲线。' +
    '实验结果及分析验证集准确率达到97.2%，训练损失下降到0.08。';
  const r = analyzeReportText(short, { course: '机器学习', title: '实验2' }, 380000, s);
  assert.equal(r.level, 'warn', '正文偏少应降为 warn');
  assert.ok(r.reasons.some((x) => x.includes('正文内容较少')));
});
test('没有模板时「未识别到实验栏目」的旧行为保持不变', () => {
  const tableReport =
    '课程名称：机器学习实验名称机器学习与BP神经网络实验目的了解BP网络的基本概念。' +
    '实验内容和步骤用Python实现三层网络并在MNIST上训练，记录损失曲线。' +
    '实验结果及分析验证集准确率达到97.2%。';
  const r = analyzeReportText(tableReport, { course: '机器学习', title: '实验2' }, 380000);
  assert.ok(
    r.reasons.some((x) => x.includes('未识别到标准实验栏目')),
    '没有模板时仍应提示栏目结构不标准，实际：' + JSON.stringify(r.reasons)
  );
});

console.log('pickTemplateSkeleton');
test('从题目区附件中挑出报告模板', () => {
  const picked = pickTemplateSkeleton([
    { name: 'kmeansSamples.txt', kind: 'other', text: '1.2,3.4,0' },
    { name: '模板.docx', kind: 'docx', text: TEMPLATE_TEXT },
  ]);
  assert.ok(picked, '应挑出模板');
  assert.equal(picked.presetTitle, '聚类算法实现');
});
test('只有数据集时挑不出模板，返回 null', () => {
  const picked = pickTemplateSkeleton([
    { name: 'kmeansSamples.txt', kind: 'other', text: '1.2,3.4,0' },
  ]);
  assert.equal(picked, null);
});
test('多份候选时取栏目最完整的', () => {
  const thin = '课程名称：机器学习实验名称实验内容：____';
  const picked = pickTemplateSkeleton([
    { name: 'a.docx', kind: 'docx', text: thin },
    { name: 'b.docx', kind: 'docx', text: TEMPLATE_TEXT },
  ]);
  assert.ok(picked.headings.length >= 4, '应选中栏目更完整的模板');
});
test('没有正文的附件被跳过', () => {
  const picked = pickTemplateSkeleton([{ name: 'x.docx', kind: 'docx', text: '' }]);
  assert.equal(picked, null);
});

console.log('');
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail > 0) process.exit(1);
