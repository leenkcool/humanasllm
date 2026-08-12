const { test } = require('node:test');
const assert = require('node:assert');
const { initDatabase } = require('../../db');
const { classify } = require('../../services/categoryEngine');

test('classify 规则命中 confidential（真实种子规则，白名单锁死）', async () => {
  await initDatabase();
  const r = await classify({ messages: [{ role: 'user', content: '整理等保备案材料' }], body: { category: 'general' } });
  assert.strictEqual(r.category, 'confidential');
  assert.strictEqual(r.source, 'rule');
  assert.ok(r.rule_id != null);
});

test('classify 命中 ops 规则（数据库迁移）', async () => {
  await initDatabase();
  const r = await classify({ messages: [{ role: 'user', content: '执行数据库迁移与备份恢复' }], body: {} });
  assert.strictEqual(r.category, 'ops');
  assert.strictEqual(r.source, 'rule');
});

test('classify 无规则命中 + 显式 category', async () => {
  await initDatabase();
  const r = await classify({ messages: [{ role: 'user', content: '普通开发任务' }], body: { category: 'ops' } });
  assert.strictEqual(r.category, 'ops');
  assert.strictEqual(r.source, 'explicit');
});

test('classify 默认 general', async () => {
  await initDatabase();
  const r = await classify({ messages: [{ role: 'user', content: '普通开发任务' }], body: {} });
  assert.strictEqual(r.category, 'general');
  assert.strictEqual(r.source, 'default');
});
