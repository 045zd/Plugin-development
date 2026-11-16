/**
 * 实验报告文本分析测试。
 * 运行：node tests/test_report_check.mjs
 */
import assert from 'node:assert/strict';
import {
  analyzeReportText,
  isLabReportItem,
  isPastDeadline,
} from '../extension/background/report-check.js';

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
    console.log('     ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e);
  }
}

// 实测的「实验一 环境安装与配置」docx 文本（模板栏目录入为空）
const EMPTY_REPORT = `right0示例大学实验报告（理工类）二级学院：示例学院专业：计算机科学与技术课程名称：操作系统班级：计算机2301学号：姓名：示例大学实验报告（理工类）二级学院：示例学院专业：计算机科学与技术课程名称：操作系统班级：计算机2301学号：姓名：实验名称环境配置及调试实验目的1.熟悉虚拟机的安装；2.掌握OpenEuler操作系统的安装及配置；3.理解进程创建相关理论；4.掌握进程创建方法；5.掌握进程相关数据结构。实验室名称4J332主要仪器名称计算机实验类型验证性实验要求：本次实验针对在Open Euler操作系统中，对进程相关理论进行设计，要求编写程序并进行测试。代码主要模拟进程的创建。编写一个C（C++/Java）程序，并使用系统调用fork()创建一个子进程。（1）安装虚拟机，并进行配置；完成Open Euler操作系统安装过程，并配置桌面环境；（2）编写程序，使用系统调用fork()创建一个子进程。要求：①在子进程中分别输出当前进程为子进程的提示、当前进程的PID和父进程的PID、根据用户输入确定当前进程的返回值、退出提示等信息。②在父进程中分别输出：当前进程为父进程的提示、当前进程的PID和子进程的PID、等待子进程退出后获得的返回值、退出提示等信息。；（3）选择学过的编程语言进行编写程序；（4）运行程序进行功能测试；（5）将实验过程进行截图，完成实验报告。实验内容和步骤：实验结果及分析：成绩和评语：指导教师：________________审阅日期：________________`;

// 实测的「实验二」docx 文本结构（有实质内容）
const GOOD_REPORT = `示例大学实验报告（理工类）二级学院：示例学院专业：计算机科学与技术课程名称：操作系统班级：计算机2301学号：20230000000姓名：张三实验名称P、V原语的模拟实现实验目的掌握信号量同步与互斥。实验内容和步骤：1．实验原理PV操作是对信号量S的两个原语操作：P(S)使S减1，若S<0则调用进程阻塞并进入等待队列；V(S)使S加1，若S≤0则从等待队列中唤醒一个进程，S的修改与判断不可中断。本实验用三个信号量解决生产者—消费者问题的同步与互斥。2．信号量设计信号量初值作用hEmpty5记录缓冲区空槽位数，供生产者申请hFull0记录缓冲区已有数据数，供消费者申请hMutex1保证缓冲区互斥访问。3．程序实现生产者线程循环产生数据并调用P(hEmpty)、P(hMutex)写入缓冲区，消费者线程调用P(hFull)、P(hMutex)读取数据。代码运行稳定，注释完整。实验结果及分析：1．运行结果图1 Windows平台运行结果（编译与运行）图2 openEuler平台运行结果（编译与运行）2．结果分析（1）同步正确。7条数据全部按写入顺序被读出，无丢失、无重复、无乱序，说明hEmpty与hFull正确实现了生产者与消费者之间的同步。（2）互斥正确。写入与读出的槽位内容一一对应，未出现两个线程同时访问缓冲区所致的数据竞争，说明hMutex起到了互斥作用。成绩和评语：指导教师：________________审阅日期：________________`;

test('空白模板：识别实验内容/结果栏目为空', () => {
  const r = analyzeReportText(EMPTY_REPORT, { course: '《操作系统》', title: '实验一 环境安装与配置' }, 23883);
  assert.equal(r.level, 'bad');
  assert.ok(r.emptySections.includes('实验内容和步骤'), '应识别实验内容和步骤为空');
  assert.ok(r.emptySections.includes('实验结果及分析'), '应识别实验结果及分析为空');
  assert.equal(r.courseMatch, true, '报告课程应为操作系统');
  assert.equal(r.reportTitle, '环境配置及调试');
});

test('内容完整的报告判为正常', () => {
  const r = analyzeReportText(GOOD_REPORT, { course: '《操作系统》', title: '实验二 P、V原语的模拟实现' }, 457612);
  assert.equal(r.level, 'ok');
  assert.equal(r.emptySections.length, 0);
  assert.equal(r.courseMatch, true);
  assert.ok(r.textLen > 200);
});

test('课程不一致时标红', () => {
  const r = analyzeReportText(GOOD_REPORT, { course: '《机器学习》' }, 457612);
  assert.equal(r.courseMatch, false);
  assert.equal(r.level, 'bad');
  assert.ok(r.reasons.some((x) => x.includes('不一致')));
});

test('实验类已提交条目筛选', () => {
  assert.equal(isLabReportItem({ type: 'assignment', title: '实验一 环境安装与配置', status: '待批阅' }), true);
  assert.equal(isLabReportItem({ type: 'assignment', title: '实验一 环境安装与配置', status: '未交' }), false);
  assert.equal(isLabReportItem({ type: 'assignment', title: '第一次作业', status: '已完成' }), false);
  assert.equal(isLabReportItem({ type: 'exam', title: '实验相关考试', status: '已完成' }), false);
  // 待互评是学生还要操作的任务，不应进入「已提交报告」检查
  assert.equal(isLabReportItem({ type: 'assignment', title: '实验二', status: '待互评' }), false);
});

test('isPastDeadline 判断已过截止时间', () => {
  const now = 1790000000000;
  assert.equal(isPastDeadline({ deadline: now - 1000 }, now), true);
  assert.equal(isPastDeadline({ deadline: now + 1000 }, now), false);
  // v1.2.19 起：时间未知（deadline=null）保守视为已截止——
  // 聚合页对过期作业不再显示剩余时间，这是过期作业的典型特征
  assert.equal(isPastDeadline({ deadline: null }, now), true, '时间未知默认视为已截止');
  assert.equal(
    isPastDeadline({ deadline: null }, now, { treatUnknownAsExpired: false }),
    false,
    '可显式关闭保守判定'
  );
  assert.equal(isPastDeadline({}, now), true);
});

test('占位符不算内容（下划线/点线/（空））', () => {
  const text =
    '课程名称：操作系统实验名称：进程调度实验内容和步骤：______________________________________________' +
    '实验结果及分析：......成绩和评语：指导教师：______审阅日期：______';
  const r = analyzeReportText(text, { course: '《操作系统》' }, 20000);
  assert.equal(r.level, 'bad');
  assert.ok(r.emptySections.includes('实验内容和步骤'), '下划线占位应判为空');
  assert.ok(r.emptySections.includes('实验结果及分析'), '点线占位应判为空');
});

test('正文里出现栏目同名词不应被当成标题', () => {
  // “实验内容如下”不是标题，不应把后面正文切成空栏目
  const text =
    '课程名称：操作系统实验名称：PV实现实验内容和步骤：1.实验原理PV操作是对信号量的操作，' +
    '本实验内容如下所述，包含生产者消费者模型与完整代码实现。实验结果及分析：运行正确，' +
    '同步互斥均满足要求，附有截图与数据表格说明。成绩和评语：指导教师：审阅日期：';
  const r = analyzeReportText(text, { course: '《操作系统》' }, 450000);
  assert.equal(r.level, 'ok', '有实质内容应判正常，实际原因：' + JSON.stringify(r.reasons));
  assert.equal(r.emptySections.length, 0);
});

test('课程名带括号与年份也能匹配', () => {
  const text =
    '课程名称：操作系统（2026年秋）实验名称：进程调度实验内容和步骤：' +
    '1.实验原理与设计思路，包含PCB结构与调度算法选择；2.完整代码实现与运行截图；3.结果分析。';
  const r = analyzeReportText(text, { course: '《操作系统》' }, 100000);
  assert.equal(r.courseMatch, true);
  assert.notEqual(r.level, 'bad', '实际原因：' + JSON.stringify(r.reasons));
});

test('可选栏目（实验总结/心得体会/结论）为空不判坏', () => {
  // 用户反馈：Web开发第五次实验报告 912 字，却因「实验总结」为空被判"疑似有问题"
  const text =
    '课程名称：Web开发技术实验名称：第五次实验实验内容和步骤：' +
    '1.完整实现前端页面与交互逻辑，包含路由与状态管理；2.后端接口联调与异常处理；' +
    '3.完整代码实现与运行截图；4.测试用例与结果分析，覆盖主要分支。' +
    '实验结果及分析：全部用例通过，页面渲染正常，接口响应在预期范围内。' +
    '实验总结：成绩和评语：指导教师：审阅日期：';
  const r = analyzeReportText(text, { course: '《Web 开发...》' }, 88000);
  assert.notEqual(r.level, 'bad', '可选栏目为空不应判 bad，实际: ' + JSON.stringify(r.reasons));
  assert.equal(r.emptySections.length, 0, '可选栏目不应出现在必填空栏目里');
  assert.ok(r.optionalEmptySections.includes('实验总结'), '应记录为可选空栏目');
});

test('必填栏目为空仍判坏', () => {
  const text =
    '课程名称：操作系统实验名称：进程调度实验内容和步骤：________________实验结果及分析：________';
  const r = analyzeReportText(text, { course: '《操作系统》' }, 20000);
  assert.equal(r.level, 'bad');
  assert.ok(r.emptySections.length > 0);
});

test('报告标题与作业名差异过大时提示（但不改变判定）', () => {
  const text =
    '课程名称：操作系统实验名称：机器学习回归分析实验内容和步骤：' +
    '1.完整实现数据预处理与模型训练流程；2.结果可视化与误差分析；3.结论与改进方向。';
  const r = analyzeReportText(
    text,
    { course: '《操作系统》', title: '实验四 银行家算法模拟' },
    100000
  );
  assert.equal(r.titleMismatch, true, '标题差异大应标记');
  assert.ok(r.reasons.some((x) => x.includes('不代表交错')), '提示应说明不代表交错');
  // v1.2.20：标题措辞不同不足以判定报告有问题，只提示不降级
  assert.notEqual(r.level, 'bad', '标题不一致不应判坏');
});

test('标题不一致不再把 ok 降级为 warn', () => {
  const text =
    '课程名称：操作系统实验名称：内存管理实验内容和步骤：' +
    '1.完成分区分配算法的完整实现，包含首次适应与最佳适应两种策略；' +
    '2.给出运行结果截图并分析碎片产生的具体原因；3.总结三种算法的优缺点。';
  const r = analyzeReportText(
    text,
    { course: '《操作系统》', title: '实验四 银行家算法模拟' },
    100000
  );
  assert.equal(r.titleMismatch, true);
  assert.equal(r.level, 'ok', '正文完整时不应仅因标题措辞不同而降级');
});

test('报告标题与作业名一致时不提示', () => {
  const text =
    '课程名称：操作系统实验名称：银行家算法模拟实验内容和步骤：' +
    '1.实现银行家算法与安全序列检测；2.完整代码与运行截图；3.结果分析。';
  const r = analyzeReportText(
    text,
    { course: '《操作系统》', title: '实验四 银行家算法模拟' },
    100000
  );
  assert.equal(r.titleMismatch, false);
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
