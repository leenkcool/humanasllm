/**
 * 回归测试：日志接口多租户隔离（Issue #3）
 * /api/logs/requests、/api/logs/tasks、/api/logs/tasks/:id/audit 必须按调用方租户过滤，
 * 且无任务的中继/漂移日志靠 request_logs.tenant_id 归属（无 task_id 可关联）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-log-scope';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');

/** 只挂载 logs 路由的最小应用，直接测试真实路由 SQL */
async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/logs', require('../../routes/logs'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

async function getJson(base, path, tenantId) {
  const token = jwt.sign({ id: 9000 + tenantId, username: `u${tenantId}`, role: 'engineer', tenant_id: tenantId }, process.env.JWT_SECRET);
  const res = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
  return { status: res.status, body: await res.json() };
}

test('日志接口按租户隔离：B 不可列举/审计 A 的日志（Issue #3）', async () => {
  await initDatabase();
  const db = getDb();
  const { lastId: ta } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['log-iso-a', '日志租户A']);
  const { lastId: tb } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['log-iso-b', '日志租户B']);
  const taskIds = [];
  try {
    // 各建一个任务（createTaskFromRequest 会自动写一条 task_logs）
    const { taskId: taskA } = await q.createTaskFromRequest({
      parsed: { model: 'human-llm', stream: false, messages: [{ role: 'user', content: 'A任务' }], extra: { priority: 'low' } },
      chatId: 'log-iso-a', created: 1, tenantId: ta,
    });
    const { taskId: taskB } = await q.createTaskFromRequest({
      parsed: { model: 'human-llm', stream: false, messages: [{ role: 'user', content: 'B任务' }], extra: { priority: 'low' } },
      chatId: 'log-iso-b', created: 1, tenantId: tb,
    });
    taskIds.push(taskA, taskB);

    // 挂任务的请求日志 + 无任务的中继日志（模拟 /v1 中继/漂移：task_id 为 NULL）
    await q.logRequest(taskA, 'in', { messages: [{ role: 'user', content: 'A私有prompt' }] }, 'human-llm', ta);
    await q.logRequest(null, 'in', { messages: [{ role: 'user', content: 'A中继prompt' }] }, 'deepseek-v4-flash', ta);
    await q.logRequest(null, 'in', { messages: [{ role: 'user', content: 'B中继prompt' }] }, 'deepseek-v4-flash', tb);

    await withApp(async (base) => {
      // 1) 请求日志：A 只能看到本租户（含无任务的中继日志），看不到 B 的无任务日志
      const reqA = await getJson(base, '/api/logs/requests?size=100', ta);
      assert.strictEqual(reqA.status, 200);
      const rowsA = reqA.body.data.data;
      assert.ok(rowsA.length > 0, 'A 应能看到本租户日志');
      for (const r of rowsA) assert.strictEqual(r.tenant_id, ta, '请求日志泄露了非本租户行');

      const reqB = await getJson(base, '/api/logs/requests?size=100', tb);
      const contentsB = reqB.body.data.data.map(r => JSON.stringify(r.payload || {}));
      assert.ok(contentsB.some(c => c.includes('B中继prompt')), 'B 应能看到自己的中继日志');
      assert.ok(!contentsB.some(c => c.includes('A私有prompt')), 'B 不应看到 A 的任务日志');
      assert.ok(!contentsB.some(c => c.includes('A中继prompt')), 'B 不应看到 A 的无任务中继日志');

      // 2) 任务审计日志：A 只看本租户任务的流转留痕
      const taskLogsA = await getJson(base, '/api/logs/tasks?size=100', ta);
      assert.strictEqual(taskLogsA.status, 200);
      const tlA = taskLogsA.body.data.data;
      assert.ok(tlA.length > 0);
      for (const l of tlA) assert.ok(taskIds.slice(0, 1).includes(l.task_id), '任务日志泄露了非本租户任务');

      // 3) 审计链：跨租户审计返回 404，不泄露存在性
      const crossAudit = await getJson(base, `/api/logs/tasks/${taskB}/audit`, ta);
      assert.strictEqual(crossAudit.status, 404);
      const ownAudit = await getJson(base, `/api/logs/tasks/${taskA}/audit`, ta);
      assert.strictEqual(ownAudit.status, 200);
      assert.strictEqual(ownAudit.body.data.task.id, taskA);
    });
  } finally {
    await db.run('DELETE FROM task_logs WHERE task_id IN (?, ?)', taskIds);
    await db.run('DELETE FROM request_logs WHERE task_id IN (?, ?)', taskIds);
    await db.run('DELETE FROM request_logs WHERE tenant_id IN (?, ?)', [ta, tb]);
    await db.run('DELETE FROM tasks WHERE id IN (?, ?)', taskIds);
    await db.run('DELETE FROM tenants WHERE id IN (?, ?)', [ta, tb]);
  }
});
