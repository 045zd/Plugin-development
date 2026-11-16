/**
 * 静态检查：options.html 定义的 id 与 options.js 中 $('...') 引用是否匹配。
 * 运行：node tools/check_ids.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'extension/options/options.html'), 'utf8');
const js = readFileSync(join(root, 'extension/options/options.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

const missingInHtml = [...jsIds].filter((id) => !htmlIds.has(id));
const unusedInJs = [...htmlIds].filter((id) => !jsIds.has(id));

console.log('HTML id 数量:', htmlIds.size, '| JS 引用数量:', jsIds.size);
if (missingInHtml.length) {
  console.log('FAIL JS 引用但 HTML 不存在:', missingInHtml.join(', '));
} else {
  console.log('OK 所有 JS 引用的 id 都存在于 options.html');
}
if (unusedInJs.length) {
  console.log('提示 未被 JS 引用的 id（可能是静态元素）:', unusedInJs.join(', '));
}
process.exit(missingInHtml.length ? 1 : 0);
