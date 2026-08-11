const { test } = require('node:test');
const assert = require('node:assert');
const { initDatabase, getDb } = require('../../db');
const { addLog, verifyAuditChain } = require('../../services/queueService');

test('审计哈希链：完整 + 篡改检测', async () => {
  await initDatabase();
  const db = getDb();
  const { lastId } = await db.run(
    'INSERT INTO tasks (upstream_request_id, model, status) VALUES (?, ?, ?)',
    ['t-hash', 'human-llm', 'pending']);
  try {
    await addLog(lastId, 'create', null, { status: 'pending' }, null, '上游接入');
    await addLog(lastId, 'claim', { status: 'pending' }, { status: 'processing' }, { id: 1, name: '工程师' }, '接单');

    let v = await verifyAuditChain(lastId);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.count, 2);

    // 篡改一条日志 → 链应失效
    await db.run(
      'UPDATE task_logs SET remark = ? WHERE task_id = ? AND id = (SELECT MIN(id) FROM task_logs WHERE task_id = ?)',
      ['被篡改', lastId, lastId]);
    v = await verifyAuditChain(lastId);
    assert.strictEqual(v.valid, false);
    assert.ok(v.broken_at != null);
  } finally {
    await db.run('DELETE FROM task_logs WHERE task_id = ?', [lastId]);
    await db.run('DELETE FROM tasks WHERE id = ?', [lastId]);
  }
});
