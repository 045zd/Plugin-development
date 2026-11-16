/**
 * storage.js 配置读写往返测试（mock chrome.storage）。
 * 运行：node tests/test_storage.mjs
 */
import assert from 'node:assert/strict';

function createArea() {
  const data = new Map();
  return {
    __data: data,
    async get(keys) {
      const out = {};
      if (keys == null) {
        for (const [k, v] of data) out[k] = v;
        return out;
      }
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      for (const k of list) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      for (const k of list) data.delete(k);
    }
  };
}

globalThis.chrome = { storage: { local: createArea() } };

const { saveConfig, getConfig, normalizeConfig } = await import(
  '../extension/background/storage.js'
);

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

await test('默认配置包含课表字段', async () => {
  const cfg = await getConfig();
  assert.equal(cfg.courseFilterEnabled, false);
  assert.deepEqual(cfg.scheduleCourses, []);
});

await test('保存课表课程后能读回（用户反馈场景）', async () => {
  const saved = await saveConfig({
    scheduleCourses: ['机器学习', '操作系统', '计算机组成原理'],
    courseFilterEnabled: true
  });
  assert.equal(saved.scheduleCourses.length, 3);
  const cfg = await getConfig();
  assert.deepEqual(cfg.scheduleCourses, ['机器学习', '操作系统', '计算机组成原理']);
  assert.equal(cfg.courseFilterEnabled, true);
});

await test('重复保存不会丢课程', async () => {
  await saveConfig({ scanIntervalMinutes: 30 });
  const cfg = await getConfig();
  assert.equal(cfg.scheduleCourses.length, 3, '只改扫描间隔不应清空课程');
});

await test('课程去重与归一化', async () => {
  await saveConfig({
    scheduleCourses: ['高等数学', ' 高等数学 ', '高等数学（上）', '大学英语', '']
  });
  const cfg = await getConfig();
  assert.deepEqual(cfg.scheduleCourses, ['高等数学', '大学英语']);
});

await test('normalizeConfig 处理非法字段', () => {
  const cfg = normalizeConfig({ scheduleCourses: 'not-an-array', courseFilterEnabled: 'yes' });
  assert.deepEqual(cfg.scheduleCourses, []);
  assert.equal(cfg.courseFilterEnabled, true);
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed ? 1 : 0);
