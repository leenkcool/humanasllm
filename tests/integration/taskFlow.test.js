const { test } = require('node:test');
const assert = require('node:assert');
const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');

const LONG = '这是一段足够长的实际开发任务内容满足质量校验要求二十字以上';
const ACTOR = { id: 1, name: '测试工程师' };

async function createTask(content = LONG) {
  const { taskId } = await q.createTaskFromRequest({
    parsed: { model: 'human-llm', stream: false, messages: [{ role: 'user', content }], extra: { priority: 'medium' } },
    chatId: 't-flow-' + Date.now(), created: 1, tenantId: null,
  });
  return taskId;
}

test('任务状态机全链路 pending→processing→completed→returned→pending→cancelled', async () => {
  await initDatabase();
  const db = getDb();
  const taskId = await createTask();
  try {
    assert.strictEqual((await q.getTask(taskId)).status, 'pending');
    assert.strictEqual((await q.claimTask(taskId, 1, '测试工程师')).task.status, 'processing');
    assert.strictEqual((await q.completeTask(taskId, LONG, ACTOR, {})).task.status, 'completed');
    assert.strictEqual((await q.reopenTask(taskId, '产出不合格', ACTOR)).task.status, 'returned');
    assert.strictEqual((await q.requeueTask(taskId, null, ACTOR)).task.status, 'pending');
    assert.strictEqual((await q.cancelTask(taskId, ACTOR)).task.status, 'cancelled');

    // 审计哈希链全程完整
    const v = await q.verifyAuditChain(taskId);
    assert.strictEqual(v.valid, true);
    assert.ok(v.count >= 6);
  } finally {
    await db.run('DELETE FROM task_logs WHERE task_id = ?', [taskId]);
    await db.run('DELETE FROM request_logs WHERE task_id = ?', [taskId]);
    await db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
  }
});

test('任务：质量校验拦截 + 验收单（ops 类必填）', async () => {
  await initDatabase();
  const db = getDb();
  // general：占位/过短被拦
  assert.ok(q.qualityCheck('完成'));
  assert.ok(q.qualityCheck('太短'));
  // ops 类任务需验收单
  const taskId = await createTask('执行数据库迁移并验证备份恢复成功');
  try {
    await q.claimTask(taskId, 1, '测试工程师');
    const noNote = await q.completeTask(taskId, '已执行迁移', ACTOR, {});
    // ops 类：内容不足 10 或验收单缺失 → 拦截（category=ops 由规则命中）
    assert.strictEqual(noNote.ok, false);
  } finally {
    await db.run('DELETE FROM task_logs WHERE task_id = ?', [taskId]);
    await db.run('DELETE FROM request_logs WHERE task_id = ?', [taskId]);
    await db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
  }
});
