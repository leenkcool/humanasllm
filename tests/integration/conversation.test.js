/**
 * 集成测试：多轮追问（会话）
 * - 不带 conversation_id：新会话，行为与旧版完全一致
 * - 带 conversation_id：挂到同一会话，turn_index 递增，时间线可回查
 * - 受保护类会话追问不降级
 * - 非法/跨租户 conversation_id 拒绝
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-conv';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const conversations = require('../../services/conversationService');

const MARK = 'convtest';
let seq = 0;
const unique = () => `${MARK}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantA } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk + '-a', '会话租户A']);
  const { lastId: tenantB } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk + '-b', '会话租户B']);
  await db.run('UPDATE tenants SET upstream_key = ? WHERE id = ?', [mk + '-keyA', tenantA]);
  await db.run('UPDATE tenants SET upstream_key = ? WHERE id = ?', [mk + '-keyB', tenantB]);
  return { db, mk, tenantA, tenantB };
}

async function cleanup(s, taskIds) {
  for (const id of taskIds) {
    await s.db.run('DELETE FROM alerts WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM billing_ledger WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
  }
  for (const id of taskIds) await s.db.run('DELETE FROM task_reviews WHERE task_id = ?', [id]);
  for (const id of taskIds) await s.db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await s.db.run('DELETE FROM users WHERE tenant_id IN (?, ?)', [s.tenantA, s.tenantB]);
  await s.db.run('DELETE FROM tenants WHERE id IN (?, ?)', [s.tenantA, s.tenantB]);
}

function mkApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', require('../../routes/v1'));
  return app;
}

test('不带 conversation_id：新会话且返回会话 id', async () => {
  const s = await seed();
  const ids = [];
  const server = mkApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.mk + '-keyA' };
  const post = (body) => fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: H, body: JSON.stringify(body),
  }).then(r => r.json());
  try {
    const r = await post({ model: 'human-llm', messages: [{ role: 'user', content: '第一轮问题' }] });
    ids.push(r.task_id);
    assert.ok(r.task_id);
    assert.ok(r.conversation_id && r.conversation_id.startsWith('conv-'), '应返回会话 id');
    assert.strictEqual(r.turn_index, 0);
    const t = await q.getTask(r.task_id);
    assert.strictEqual(t.conversation_id, r.conversation_id);
    assert.strictEqual(parseInt(t.turn_index, 10), 0);
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s, ids);
  }
});

test('带 conversation_id：挂到同一会话，turn_index 递增，时间线完整', async () => {
  const s = await seed();
  const ids = [];
  const server = mkApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.mk + '-keyA' };
  const post = (body) => fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: H, body: JSON.stringify(body),
  }).then(r => r.json());
  try {
    const r1 = await post({ model: 'human-llm', project_code: 'convproj', messages: [{ role: 'user', content: '订单超卖如何排查？' }] });
    ids.push(r1.task_id);
    const r2 = await post({ model: 'human-llm', conversation_id: r1.conversation_id, messages: [{ role: 'user', content: '补充：MySQL RR 隔离级别' }] });
    ids.push(r2.task_id);
    assert.strictEqual(r2.conversation_id, r1.conversation_id, '同一会话');
    assert.strictEqual(r2.turn_index, 1, '第二轮 turn_index=1');

    const t2 = await q.getTask(r2.task_id);
    assert.strictEqual(t2.conversation_id, r1.conversation_id);
    assert.strictEqual(t2.parent_task_id, r1.task_id, 'parent 指向上轮');
    assert.strictEqual(t2.project_code, 'convproj', '项目继承');

    // 服务层时间线
    const turns = await conversations.listTurns(r1.conversation_id, s.tenantA);
    assert.strictEqual(turns.length, 2);
    assert.deepStrictEqual(turns.map(x => parseInt(x.turn_index, 10)), [0, 1]);

    // 上游回查带会话摘要
    const v = await (await fetch(base + '/v1/tasks/' + r2.task_id, { headers: H })).json();
    assert.ok(v.conversation, '回查应带会话');
    assert.strictEqual(v.conversation.turns.length, 2);
    assert.ok(v.conversation.turns[0].question.includes('订单超卖'));
    assert.strictEqual(v.turn_index, 1);
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s, ids);
  }
});

test('受保护类会话：追问不降级', async () => {
  const s = await seed();
  const ids = [];
  const server = mkApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.mk + '-keyA' };
  const post = (body) => fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: H, body: JSON.stringify(body),
  }).then(r => r.json());
  try {
    // 首轮命中涉密规则
    const r1 = await post({ model: 'human-llm', messages: [{ role: 'user', content: '等保备案整改，涉密数据不能外传' }] });
    ids.push(r1.task_id);
    const t1 = await q.getTask(r1.task_id);
    assert.strictEqual(t1.category, 'confidential');

    // 追问内容完全无害
    const r2 = await post({ model: 'human-llm', conversation_id: r1.conversation_id, messages: [{ role: 'user', content: '谢谢，请补充时间节奏' }] });
    ids.push(r2.task_id);
    const t2 = await q.getTask(r2.task_id);
    assert.strictEqual(t2.category, 'confidential', '追问不得把涉密会话降级为 general');
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s, ids);
  }
});

test('非法 / 跨租户 conversation_id 一律 400', async () => {
  const s = await seed();
  const ids = [];
  const server = mkApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (key, body) => fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    // 不存在的会话
    const bad = await post(s.mk + '-keyA', {
      model: 'human-llm', conversation_id: 'conv-does-not-exist',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.strictEqual(bad.status, 400);
    assert.ok(String(bad.body.error.message).includes('conversation_id'));

    // 跨租户：A 建会话，B 拿来追问应被拒
    const r1 = await post(s.mk + '-keyA', { model: 'human-llm', messages: [{ role: 'user', content: 'A 的会话' }] });
    ids.push(r1.body.task_id);
    const cross = await post(s.mk + '-keyB', {
      model: 'human-llm', conversation_id: r1.body.conversation_id,
      messages: [{ role: 'user', content: 'B 想接话' }],
    });
    assert.strictEqual(cross.status, 400, '跨租户会话应拒绝');
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s, ids);
  }
});
