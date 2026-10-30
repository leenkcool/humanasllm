/**
 * 集成测试：答复效果回流
 * - 记录反馈（幂等）
 * - resolved=false 且 7 天内 → 自动重开同会话追问
 * - 有效率统计
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const fb = require('../../services/feedbackService');

let seq = 0;
const unique = () => `fbtest-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, '反馈租户']);
  await db.run('UPDATE tenants SET upstream_key = ? WHERE id = ?', [mk + '-key', tenantId]);
  const { lastId: eng } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [mk + '-eng', 'x', 'engineer', '反馈工程师', tenantId]);
  return { db, mk, tenantId, eng };
}

async function mkDoneTask(s, category = 'general') {
  const { taskId } = await q.createTaskFromRequest({
    parsed: {
      model: 'human-llm', stream: false,
      messages: [{ role: 'user', content: '反馈测试任务' }],
      extra: { priority: 'low', category }, tools: null,
    },
    chatId: 'fb-' + Math.random().toString(36).slice(2, 9), created: 1, tenantId: s.tenantId,
  });
  await q.claimTask(taskId, s.eng, '反馈工程师');
  await q.completeTask(taskId, '这是完整的答复内容，用于验证效果回流机制是否正常工作。',
    { id: s.eng, name: '反馈工程师' }, { completion_note: '已完成并自检' });
  return taskId;
}

async function cleanup(s, ids) {
  for (const id of ids) {
    await s.db.run('DELETE FROM task_feedback WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_reviews WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM alerts WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM billing_ledger WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
  }
  for (const id of ids) await s.db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await s.db.run('DELETE FROM task_feedback WHERE task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)', [s.tenantId]);
  await s.db.run('DELETE FROM task_reviews WHERE task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)', [s.tenantId]);
  await s.db.run('DELETE FROM users WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM tenants WHERE id = ?', [s.tenantId]);
}

test('反馈记录幂等：同一任务覆盖为最新一条', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkDoneTask(s);
    ids.push(id);
    await fb.record({ taskId: id, resolved: false, rating: 2, comment: '没解决问题', reporter: 'wb' });
    let r = await fb.getByTask(id);
    assert.strictEqual(r.resolved, false);
    assert.strictEqual(parseInt(r.rating, 10), 2);

    await fb.record({ taskId: id, resolved: true, rating: 5, comment: '已解决', reporter: 'wb' });
    const all = (await s.db.exec('SELECT COUNT(*) FROM task_feedback WHERE task_id = ?', [id]))[0].values[0][0];
    assert.strictEqual(parseInt(all, 10), 1, '仍然只有一条');
    r = await fb.getByTask(id);
    assert.strictEqual(r.resolved, true);
    assert.strictEqual(parseInt(r.rating, 10), 5);
  } finally {
    await cleanup(s, ids);
  }
});

test('resolved 非布尔值拒绝', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkDoneTask(s);
    ids.push(id);
    const r = await fb.record({ taskId: id, resolved: 'yes' });
    assert.strictEqual(r.ok, false);
  } finally {
    await cleanup(s, ids);
  }
});

test('shouldReopen：未解决 + 已完成 + 7 天内 → true；已解决或超期 → false', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkDoneTask(s);
    ids.push(id);
    assert.strictEqual(await fb.shouldReopen(await q.getTask(id)), false, '无反馈时不重开');

    await fb.record({ taskId: id, resolved: true });
    assert.strictEqual(await fb.shouldReopen(await q.getTask(id)), false, '已解决不重开');

    await fb.record({ taskId: id, resolved: false });
    assert.strictEqual(await fb.shouldReopen(await q.getTask(id)), true, '未解决应重开');

    // 超过 7 天
    await s.db.run(`UPDATE tasks SET completed_at = NOW() - interval '10 days' WHERE id = ?`, [id]);
    const expiredTask = await q.getTask(id);
    const expiredFb = await fb.getByTask(id);
    assert.strictEqual(await fb.shouldReopen(expiredTask), false,
      `超期不重开：completed_at=${expiredTask.completed_at} status=${expiredTask.status} resolved=${expiredFb && expiredFb.resolved}`);
  } finally {
    await cleanup(s, ids);
  }
});

test('POST /v1/tasks/:id/feedback：未解决自动重开同会话追问', async () => {
  const s = await seed();
  const ids = [];
  const app = express();
  app.use(express.json());
  app.use('/v1', require('../../routes/v1'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.mk + '-key' };
  try {
    const id = await mkDoneTask(s);
    ids.push(id);

    const res = await fetch(`${base}/v1/tasks/${id}/feedback`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ resolved: false, rating: 2, comment: '方案不可执行' }),
    });
    const j = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(j));
    assert.strictEqual(j.resolved, false);
    assert.ok(j.reopened_task_id, '应自动重开追问');
    ids.push(j.reopened_task_id);

    const followUp = await q.getTask(j.reopened_task_id);
    assert.strictEqual(followUp.status, 'pending');
    assert.strictEqual(followUp.parent_task_id, id, '追问挂到原任务');
    assert.ok(followUp.conversation_id, '应属同一会话');

    // 第二个反馈（已解决）不应再重开
    ids.push(await mkDoneTask(s));
    const id2 = ids[ids.length - 1];
    const res2 = await fetch(`${base}/v1/tasks/${id2}/feedback`, {
      method: 'POST', headers: H, body: JSON.stringify({ resolved: true, rating: 5 }),
    });
    const j2 = await res2.json();
    assert.strictEqual(j2.reopened_task_id, null, '已解决不重开');
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s, ids);
  }
});

test('有效率统计按分级与工程师拆分', async () => {
  const s = await seed();
  const ids = [];
  try {
    const a = await mkDoneTask(s, 'general');
    const b = await mkDoneTask(s, 'ops');
    ids.push(a, b);
    await fb.record({ taskId: a, resolved: true, rating: 5 });
    await fb.record({ taskId: b, resolved: false, rating: 2 });

    const st = await fb.stats({ tenantId: s.tenantId });
    assert.strictEqual(st.total, 2);
    assert.strictEqual(st.resolved, 1);
    assert.strictEqual(st.rate, 50);
    assert.ok(st.by_category.length >= 2);
    const general = st.by_category.find(x => x.category === 'general');
    assert.strictEqual(general.rate, 100);
    assert.ok(st.by_assignee.length >= 1);
  } finally {
    await cleanup(s, ids);
  }
});
