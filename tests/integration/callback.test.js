/**
 * 回归测试：上游完成回调 webhook + /v1 任务视图进度字段
 * - callback_url 合法落库、非法丢弃
 * - 仅终态（completed/returned）POST，非终态跳过
 * - 回调体含事件名 + 进度字段（priority/assignee/sla_remaining_sec）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const callback = require('../../services/callback');

/** 轮询等待条件成立，避免依赖固定 sleep */
async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return fn();
}

test('完成回调：终态 POST 上游 callback_url，非法地址丢弃、非终态跳过', async () => {
  await initDatabase();
  const db = getDb();

  // 本地接收端（模拟上游 agent）
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['cb-a', '回调租户']);
  // tasks.assignee_id 有外键，需真实工程师账户
  const { lastId: engineerId } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ['cb-engineer', 'x', 'engineer', '回调工程师', tenantId]);
  const taskIds = [];
  try {
    // 1) 合法 callback_url 落库
    const { taskId } = await q.createTaskFromRequest({
      parsed: {
        model: 'human-llm', stream: false, messages: [{ role: 'user', content: '带回调的任务' }],
        extra: { priority: 'low', callback_url: `http://127.0.0.1:${port}/hook` },
      },
      chatId: 'cb-1', created: 1, tenantId,
    });
    taskIds.push(taskId);
    const t1 = await q.getTask(taskId);
    assert.strictEqual(t1.callback_url, `http://127.0.0.1:${port}/hook`, '合法 callback_url 应落库');

    // 2) 非法协议丢弃（不因回调地址影响建单）
    const { taskId: badId } = await q.createTaskFromRequest({
      parsed: {
        model: 'human-llm', stream: false, messages: [{ role: 'user', content: '非法回调地址' }],
        extra: { priority: 'low', callback_url: 'ftp://example.com/x' },
      },
      chatId: 'cb-2', created: 1, tenantId,
    });
    taskIds.push(badId);
    assert.strictEqual((await q.getTask(badId)).callback_url, null, '非法 callback_url 应被丢弃');

    // 3) 非终态不回调
    const pending = await q.getTask(taskId);
    assert.strictEqual((await callback.notify(pending)).skipped, true, 'pending 不应回调');

    // 4) 终态触发回调（claim → complete）
    await q.claimTask(taskId, engineerId, '回调工程师');
    const done = await q.completeTask(taskId, '这是足够长的完成产出内容，用于通过质量校验。', { id: engineerId, name: '回调工程师' });
    assert.strictEqual(done.ok, true, '完成任务应成功');

    assert.ok(await waitFor(() => received.length >= 1), '终态应投递回调');
    const got = received[0].body;
    assert.strictEqual(got.event, 'task.completed');
    assert.strictEqual(got.task_id, taskId);
    assert.strictEqual(got.status, 'completed');
    assert.ok(got.content.includes('完成产出内容'), '回调体应含人类产出');
    // 进度字段（与 /v1/tasks/:id 共用视图）
    assert.strictEqual(got.priority, 'low');
    assert.strictEqual(got.assignee, '回调工程师');
    assert.strictEqual(got.category, 'general');

    // 5) 打回重做 → returned 也是终态，事件名对应
    const reopened = await q.reopenTask(taskId, '产出不合格，打回重做', { id: engineerId, name: '回调工程师' });
    assert.strictEqual(reopened.ok, true);
    assert.ok(await waitFor(() => received.length >= 2), '返回态应再次投递回调');
    assert.strictEqual(received[1].body.event, 'task.returned');
  } finally {
    await new Promise(r => server.close(r));
    await db.run('DELETE FROM task_logs WHERE task_id IN (?, ?)', taskIds);
    await db.run('DELETE FROM request_logs WHERE task_id IN (?, ?)', taskIds);
    await db.run('DELETE FROM tasks WHERE id IN (?, ?)', taskIds);
    await db.run('DELETE FROM users WHERE id = ?', [engineerId]);
    await db.run('DELETE FROM tenants WHERE id = ?', [tenantId]);
  }
});
