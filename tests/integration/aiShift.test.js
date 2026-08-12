const { test } = require('node:test');
const assert = require('node:assert');

// 在 require aiShift/aiRelay 前设置环境（aiRelay 模块加载时读取）
process.env.AI_SHIFT_ENABLED = 'true';
process.env.AI_RELAY_API_KEY = 'test-key';

const { initDatabase } = require('../../db');
const { shouldShift } = require('../../services/aiShift');

test('智能漂移：general 普通任务可漂移', async () => {
  await initDatabase();
  const r = await shouldShift({ messages: [{ role: 'user', content: '普通开发任务' }], body: {} });
  assert.strictEqual(r, true);
});

test('智能漂移：confidential 规则锁死不漂移（白名单）', async () => {
  await initDatabase();
  const r = await shouldShift({ messages: [{ role: 'user', content: '整理等保备案材料' }], body: {} });
  assert.strictEqual(r, false);
});

test('智能漂移：显式 confidential 不漂移', async () => {
  await initDatabase();
  const r = await shouldShift({ messages: [{ role: 'user', content: '普通' }], body: { category: 'confidential' } });
  assert.strictEqual(r, false);
});
