/**
 * 回归测试：tools / function calling
 * - 只允许调用本任务声明过的函数（未声明拒绝）
 * - arguments 必须是合法 JSON
 * - 产出按 OpenAI tool_calls 结构返回（content=null / finish_reason=tool_calls）
 * - 有函数调用时允许 content 为空；无函数调用时空内容仍拦截
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-toolcalls';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const taskView = require('../../services/taskView');
const toolCalls = require('../../services/toolCalls');

const TOOLS = [{
  type: 'function',
  function: {
    name: 'restart_service',
    description: '重启指定服务',
    parameters: { type: 'object', properties: { name: { type: 'string' }, force: { type: 'boolean' } }, required: ['name'] },
  },
}, {
  type: 'function',
  function: { name: 'query_metrics', description: '查询监控指标', parameters: { type: 'object', properties: { metric: { type: 'string' } } } },
}];

async function seed() {
  await initDatabase();
  const db = getDb();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['tc-a', '函数租户']);
  const { lastId: engineerId } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ['tc-engineer', 'x', 'engineer', '函数工程师', tenantId]);
  const { taskId } = await q.createTaskFromRequest({
    parsed: { model: 'human-llm', stream: false, messages: [{ role: 'user', content: '请重启服务' }], extra: { priority: 'low' }, tools: TOOLS },
    chatId: 'tc-1', created: 1, tenantId,
  });
  return { db, tenantId, engineerId, taskId };
}

async function cleanup(db, tenantId, engineerId, taskIds) {
  for (const id of taskIds) {
    await db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
  }
  for (const id of taskIds) await db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await db.run('DELETE FROM users WHERE id = ?', [engineerId]);
  await db.run('DELETE FROM tenants WHERE id = ?', [tenantId]);
}

test('函数调用：声明校验 + OpenAI tool_calls 产出结构', async () => {
  const { db, tenantId, engineerId, taskId } = await seed();
  try {
    const task = await q.getTask(taskId);
    // 声明的函数落库
    assert.deepStrictEqual(toolCalls.declaredNames(task), ['restart_service', 'query_metrics']);

    // 1) 未声明的函数 → 拒绝
    await q.claimTask(taskId, engineerId, '函数工程师');
    const bad = await q.completeTask(taskId, '', { id: engineerId, name: '函数工程师' }, { tool_call: { name: 'delete_everything', arguments: {} } });
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.message.includes('未声明'), '应提示未声明: ' + bad.message);

    // 2) arguments 非法 JSON → 拒绝
    const badJson = await q.completeTask(taskId, '', { id: engineerId, name: '函数工程师' }, { tool_call: { name: 'restart_service', arguments: '{not json' } });
    assert.strictEqual(badJson.ok, false);
    assert.ok(badJson.message.includes('JSON'), '应提示 JSON 非法: ' + badJson.message);

    // 3) 空内容 + 无函数调用 → 仍按质量校验拦截
    const empty = await q.completeTask(taskId, '', { id: engineerId, name: '函数工程师' }, {});
    assert.strictEqual(empty.ok, false, '空产出应被质量校验拦截');

    // 4) 合法函数调用 → 成功（content 允许为空）
    const done = await q.completeTask(taskId, '', { id: engineerId, name: '函数工程师' },
      { tool_call: { name: 'restart_service', arguments: { name: 'nginx', force: true } } });
    assert.strictEqual(done.ok, true, '合法函数调用应成功: ' + (done.message || ''));

    const out = done.task.result_payload.tool_calls;
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, 'function');
    assert.ok(out[0].id.startsWith('call_'));
    assert.strictEqual(out[0].function.name, 'restart_service');
    assert.deepStrictEqual(JSON.parse(out[0].function.arguments), { name: 'nginx', force: true });

    // 5) 上游视图：content=null + finish_reason=tool_calls（OpenAI 语义）
    const view = await taskView.buildTaskView(await q.getTask(taskId));
    assert.strictEqual(view.content, null);
    assert.strictEqual(view.finish_reason, 'tool_calls');
    assert.strictEqual(view.tool_calls[0].function.name, 'restart_service');
    assert.strictEqual(view.status, 'completed');
  } finally {
    await cleanup(db, tenantId, engineerId, [taskId]);
  }
});

test('函数调用：/api/tasks/:id/complete 接受 tool_call（HTTP 路由级）', async () => {
  const { db, tenantId, engineerId, taskId } = await seed();
  try {
    await q.claimTask(taskId, engineerId, '函数工程师');

    const app = express();
    app.use(express.json());
    app.use('/api/tasks', require('../../routes/tasks'));
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const token = jwt.sign({ id: engineerId, username: 'tc-engineer', role: 'engineer', name: '函数工程师', tenant_id: tenantId }, process.env.JWT_SECRET);
      const res = await fetch(`${base}/api/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ content: '', tool_call: { name: 'query_metrics', arguments: { metric: 'cpu' } } }),
      });
      const j = await res.json();
      assert.strictEqual(res.status, 200, JSON.stringify(j));
      assert.strictEqual(j.success, true);
      assert.strictEqual(j.data.result_payload.tool_calls[0].function.name, 'query_metrics');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await cleanup(db, tenantId, engineerId, [taskId]);
  }
});
