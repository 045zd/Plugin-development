/**
 * doc-text.js 测试：真实 .doc / .docx 样本的正文提取。
 * 运行：node tests/test_doc_text.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  extractDocText,
  extractDocxText,
  extractPdfText,
  extractAttachmentText,
  parseCompoundFile,
} from '../extension/background/doc-text.js';

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

const HAS_DOC = (() => {
  try {
    readFileSync(join(FIX, 'report.doc'));
    return true;
  } catch {
    return false;
  }
})();
const HAS_DOCX = (() => {
  try {
    readFileSync(join(FIX, 'report.docx'));
    return true;
  } catch {
    return false;
  }
})();

await test('OLE2 复合文档解析（WordDocument 流存在）', async () => {
  if (!HAS_DOC) {
    console.log('     （跳过：缺少 report.doc 样本）');
    return;
  }
  const buffer = readFixture('report.doc');
  const cfb = parseCompoundFile(buffer);
  assert.ok(cfb, '应识别为 OLE2 文档');
  assert.ok(cfb.getStream('WordDocument'), '应有 WordDocument 流');
  const names = cfb.entries.map((e) => e.name);
  assert.ok(names.includes('1Table') || names.includes('0Table'), '应有表格流');
});

await test('提取 .doc 正文：课程名/实验栏目/正文内容', async () => {
  if (!HAS_DOC) {
    console.log('     （跳过：缺少 report.doc 样本）');
    return;
  }
  const r = extractDocText(readFixture('report.doc'));
  assert.equal(r.ok, true, '应成功提取');
  const t = r.text.replace(/\s+/g, '');
  for (const kw of ['课程名称：操作系统', '实验名称', 'P、V原语', '实验内容和步骤', '实验结果及分析', '信号量']) {
    assert.ok(t.includes(kw.replace(/\s+/g, '')), '正文应包含 ' + kw + '，实际提取: ' + t.slice(0, 200));
  }
  console.log('     提取方式:', r.method, '| 文本长度:', r.text.length);
});

await test('提取 .docx 正文', async () => {
  if (!HAS_DOCX) {
    console.log('     （跳过：缺少 report.docx 样本）');
    return;
  }
  const text = await extractDocxText(readFixture('report.docx'));
  const t = text.replace(/\s+/g, '');
  assert.ok(t.includes('课程名称：操作系统'), '应含课程名');
  assert.ok(t.includes('实验内容和步骤'), '应含栏目');
});

await test('extractAttachmentText 按文件名/魔数分派 .doc', async () => {
  if (!HAS_DOC) return;
  const r = await extractAttachmentText(readFixture('report.doc'), '实验报告.doc', 'doc');
  assert.equal(r.kind, 'doc');
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('操作系统'));
});

await test('extractAttachmentText 把 OLE2 误标为 docx 也能兜底', async () => {
  if (!HAS_DOC) return;
  // 学习通有时 filetype 给错，应以魔数为准
  const r = await extractAttachmentText(readFixture('report.doc'), '实验报告.doc', 'docx');
  assert.equal(r.kind, 'doc', '魔数为 OLE2 时应走 doc 解析');
  assert.equal(r.ok, true);
});

await test('空/非法数据不崩溃', async () => {
  const r = await extractAttachmentText(new ArrayBuffer(16), 'x.doc', 'doc');
  assert.equal(r.ok, false);
  const r2 = await extractAttachmentText(new ArrayBuffer(16), 'x.pdf', 'pdf');
  assert.equal(r2.ok, false);
});

await test('PDF 文本提取（无样本时跳过）', async () => {
  let buffer;
  try {
    buffer = readFixture('report.pdf');
  } catch {
    console.log('     （跳过：缺少 report.pdf 样本）');
    return;
  }
  const text = extractPdfText(buffer);
  assert.ok(typeof text === 'string', '应返回字符串');
  console.log('     PDF 文本长度:', text.length);
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
