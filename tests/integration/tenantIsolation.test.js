const { test } = require('node:test');
const assert = require('node:assert');
const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');

test('createTaskFromRequest 按 tenantId 落库（多租户隔离基础）', async () => {
  await initDatabase();
  const db = getDb();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['iso-a', '租户A']);
  try {
    const { taskId } = await q.createTaskFromRequest({
      parsed: { model: 'human-llm', stream: false, messages: [{ role: 'user', content: '租户A任务' }], extra: { priority: 'low' } },
      chatId: 't-iso', created: 1, tenantId,
    });
    const t = await q.getTask(taskId);
    assert.strictEqual(t.tenant_id, tenantId);
    await db.run('DELETE FROM task_logs WHERE task_id = ?', [taskId]);
    await db.run('DELETE FROM request_logs WHERE task_id = ?', [taskId]);
    await db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
  } finally {
    await db.run('DELETE FROM tenants WHERE id = ?', [tenantId]);
  }
});

test('不同租户任务互不可见（读隔离数据层面）', async () => {
  await initDatabase();
  const db = getDb();
  const { lastId: ta } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['iso-b', '租户B']);
  const { lastId: tb } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['iso-c', '租户C']);
  try {
    const { taskId } = await q.createTaskFromRequest({
      parsed: { model: 'human-llm', stream: false, messages: [{ role: 'user', content: 'B任务' }], extra: { priority: 'low' } },
      chatId: 't-iso2', created: 1, tenantId: ta,
    });
    // 查询按租户过滤：B 能见，C 不能见
    const rows = q.rows(await db.exec('SELECT id FROM tasks WHERE id = ? AND tenant_id = ?', [taskId, ta]));
    assert.strictEqual(rows.length, 1);
    const rowsC = q.rows(await db.exec('SELECT id FROM tasks WHERE id = ? AND tenant_id = ?', [taskId, tb]));
    assert.strictEqual(rowsC.length, 0);
    await db.run('DELETE FROM task_logs WHERE task_id = ?', [taskId]);
    await db.run('DELETE FROM request_logs WHERE task_id = ?', [taskId]);
    await db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
  } finally {
    await db.run('DELETE FROM tenants WHERE id IN (?, ?)', [ta, tb]);
  }
});
