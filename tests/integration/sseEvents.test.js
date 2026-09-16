/**
 * 回归测试：/v1 SSE 中途状态推送（opt-in stream_events:true）
 * - 受理事件 → 接单(task.processing) → 完成(task.completed) → [DONE]
 * - 不传 stream_events 时行为不变（立即受理 + [DONE]，不阻塞）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');

async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 30));
  }
  return fn();
}

/** 只挂 /v1 的最小应用 */
async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use('/v1', require('../../routes/v1'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(r => server.close(r));
  }
}

/** 读取 SSE 流，收集事件（遇 [DONE] 结束） */
async function readSse(res, events) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!frame.startsWith('data: ')) continue; // 保活注释行
      const payload = frame.slice(6);
      if (payload === '[DONE]') { events.push({ done: true }); return; }
      try { events.push(JSON.parse(payload)); } catch (e) { /* 忽略非 JSON */ }
    }
  }
}

test('SSE 中途状态推送：受理→接单→完成→[DONE]', async () => {
  await initDatabase();
  const db = getDb();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['sse-a', 'SSE租户']);
  const { lastId: engineerId } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ['sse-engineer', 'x', 'engineer', 'SSE工程师', tenantId]);
  let taskId = null;
  try {
    await withApp(async (base) => {
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'human-llm', stream: true, stream_events: true, priority: 'low',
          messages: [{ role: 'user', content: 'SSE 事件流验证任务' }],
        }),
      });
      assert.strictEqual(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));

      const events = [];
      const readLoop = readSse(res, events);

      // 等受理事件 → 拿到 task_id
      assert.ok(await waitFor(() => events.length >= 1), '应收到受理事件');
      assert.strictEqual(events[0].event, 'task.accepted');
      assert.strictEqual(events[0].status, 'pending');
      taskId = events[0].task_id;
      assert.ok(taskId, '受理事件应含 task_id');

      // 人工：接单 → 完成（走真实业务方法，触发事件总线）
      await q.claimTask(taskId, engineerId, 'SSE工程师');
      const done = await q.completeTask(taskId, '足够长的产出内容，用于通过质量校验的验证。', { id: engineerId, name: 'SSE工程师' });
      assert.strictEqual(done.ok, true);

      await readLoop; // 读到 [DONE]

      const names = events.filter(e => e.event).map(e => e.event);
      assert.ok(names.includes('task.processing'), '应收到接单事件，实际: ' + names.join(','));
      assert.ok(names.includes('task.completed'), '应收到完成事件，实际: ' + names.join(','));
      assert.ok(events[events.length - 1].done, '应以 [DONE] 结束');

      const completed = events.find(e => e.event === 'task.completed');
      assert.ok(completed.content.includes('产出内容'), '完成事件应含人工产出');
      assert.strictEqual(completed.assignee, 'SSE工程师');
    });
  } finally {
    if (taskId) {
      await db.run('DELETE FROM task_logs WHERE task_id = ?', [taskId]);
      await db.run('DELETE FROM request_logs WHERE task_id = ?', [taskId]);
      await db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
    }
    await db.run('DELETE FROM users WHERE id = ?', [engineerId]);
    await db.run('DELETE FROM tenants WHERE id = ?', [tenantId]);
  }
});

test('SSE 默认行为不变：不传 stream_events 立即受理并结束', async () => {
  await initDatabase();
  const db = getDb();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['sse-b', 'SSE租户B']);
  let taskId = null;
  try {
    await withApp(async (base) => {
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'human-llm', stream: true, priority: 'low',
          messages: [{ role: 'user', content: '默认流式行为验证' }],
        }),
      });
      const events = [];
      await readSse(res, events); // 应立即读到 [DONE]，不挂起
      assert.ok(events[events.length - 1].done, '默认流式应立即以 [DONE] 结束');
      const accepted = events.find(e => e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.content);
      assert.ok(accepted, '默认流式应返回受理内容');
      taskId = accepted.task_id;
    });
  } finally {
    if (taskId) {
      await db.run('DELETE FROM task_logs WHERE task_id = ?', [taskId]);
      await db.run('DELETE FROM request_logs WHERE task_id = ?', [taskId]);
      await db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
    }
    await db.run('DELETE FROM tenants WHERE id = ?', [tenantId]);
  }
});
