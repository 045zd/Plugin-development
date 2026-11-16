/**
 * 语法检查：用 Node 的 vm.SourceTextModule 解析 ES 模块（只解析、不执行），
 * 可发现 import/export 与语法错误。
 *
 * 用法：node --experimental-vm-modules tools/check_syntax.mjs <files...>
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node --experimental-vm-modules check_syntax.mjs <files...>');
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    console.log('MISSING', file, e.message);
    failed += 1;
    continue;
  }
  try {
    // 只解析，不执行
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(src, { identifier: file });
    console.log('OK  ', file);
  } catch (e) {
    failed += 1;
    console.log('FAIL', file);
    console.log('     ', e.message);
  }
}

console.log(failed ? `\n${failed} 个文件有语法错误` : '\n全部通过');
process.exit(failed ? 1 : 0);
