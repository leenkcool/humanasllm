/**
 * 集成测试：工程师终端相关后端能力
 * - 定向推送：技能匹配者收到 task:matched，无技能任务不定向
 * - 起草接口：状态守卫（未接单不可起草）+ 归属守卫（非本人不可起草）+ 分级红线
 * - 提交留痕：drafted_by_ai 写入审计哈希链
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mobile';
process.env.AI_RELAY_API_KEY = ''; // 不真的调外部 LLM

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const ws = require('../../services/websocket');

const MARK = 'mobtest';
let seq = 0;
const unique = () => `${MARK}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

/** 捕获 websocket 推送（不依赖真实 Socket.IO） */
function captureWs() {
  const events = [];
  ws.setIO({
    to: (room) => ({
      emit: (event, data) => events.push({ room, event, data }),
    }),
  });
  return events;
}

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, '终端租户']);
  const mkUser = async (suffix, skills) => (await db.run(
    'INSERT INTO users (username, password, role, name, skills, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
    [mk + '-' + suffix, 'x', 'engineer', '终端' + suffix, skills, tenantId])).lastId;
  const uMatch = await mkUser('match', 'postgres,ops');
  const uOther = await mkUser('other', 'frontend');
  return { db, mk, tenantId, uMatch, uOther };
}

async function cleanup(s, taskIds) {
  for (const id of taskIds) {
    await s.db.run('DELETE FROM alerts WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM billing_ledger WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
  }
  for (const id of taskIds) await s.db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await s.db.run('DELETE FROM alerts WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM users WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM tenants WHERE id = ?', [s.tenantId]);
}

async function mkTask(tenantId, over = {}) {
  const { taskId } = await q.createTaskFromRequest({
    parsed: {
      model: 'human-llm', stream: false,
      messages: [{ role: 'user', content: over.content || '终端测试任务' }],
      extra: { priority: 'low', ...(over.extra || {}) }, tools: null,
    },
    chatId: 'mob-' + Math.random().toString(36).slice(2, 9), created: 1, tenantId,
  });
  return taskId;
}

test('定向推送：技能匹配者收到 task:matched，任务无技能时不定向', async () => {
  const s = await seed();
  const ids = [];
  try {
    const events = captureWs();
    // 带 skills 的任务：只有 skills 有交集的工程师收到 task:matched
    const t1 = await mkTask(s.tenantId, { extra: { skills: 'postgres' } });
    ids.push(t1);
    const matched = events.filter(e => e.event === 'task:matched');
    assert.ok(matched.length >= 1, '应有定向推送');
    const rooms = matched.map(e => e.room);
    assert.ok(rooms.includes(`user:${s.uMatch}`), '技能匹配者应收到');
    assert.ok(!rooms.includes(`user:${s.uOther}`), '技能不匹配者不应收到');
    // 全站负载事件总是发
    assert.ok(events.some(e => e.event === 'task:load' && e.room === 'system'));

    // 无技能任务：只广播，不定向
    events.length = 0;
    const t2 = await mkTask(s.tenantId);
    ids.push(t2);
    assert.strictEqual(events.filter(e => e.event === 'task:matched').length, 0, '无技能任务不应定向');
    assert.ok(events.some(e => e.event === 'task:load'), '仍应有全站负载事件');
  } finally {
    await cleanup(s, ids);
  }
});

test('起草接口：未接单不可起草 / 非本人不可起草', async () => {
  const s = await seed();
  const ids = [];
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', require('../../routes/tasks'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokMatch = jwt.sign({ id: s.uMatch, username: 'm', role: 'engineer', tenant_id: s.tenantId }, process.env.JWT_SECRET);
  const tokOther = jwt.sign({ id: s.uOther, username: 'o', role: 'engineer', tenant_id: s.tenantId }, process.env.JWT_SECRET);
  const post = (path, tok) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}',
  }).then(r => r.json().then(j => ({ status: r.status, body: j })));
  try {
    const tid = await mkTask(s.tenantId);
    ids.push(tid);

    // 未接单（pending）→ 400
    const r1 = await post(`/api/tasks/${tid}/draft`, tokMatch);
    assert.strictEqual(r1.status, 400);
    assert.ok(String(r1.body.message).includes('接单'), r1.body.message);

    // 接单后，非本人（ownerOnly）→ 403
    await q.claimTask(tid, s.uMatch, '终端match');
    const r2 = await post(`/api/tasks/${tid}/draft`, tokOther);
    assert.strictEqual(r2.status, 403);

    // 本人 + general 类 → 因 AI 未配置而失败（400），但已通过前置守卫
    const r3 = await post(`/api/tasks/${tid}/draft`, tokMatch);
    assert.strictEqual(r3.status, 400);
    assert.ok(String(r3.body.message).includes('中继'), r3.body.message);
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s, ids);
  }
});

test('提交留痕：drafted_by_ai 写入审计哈希链且链仍完整', async () => {
  const s = await seed();
  const ids = [];
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', require('../../routes/tasks'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = jwt.sign({ id: s.uMatch, username: 'm', role: 'engineer', tenant_id: s.tenantId }, process.env.JWT_SECRET);
  try {
    const tid = await mkTask(s.tenantId);
    ids.push(tid);
    await q.claimTask(tid, s.uMatch, '终端match');

    const res = await fetch(`${base}/api/tasks/${tid}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({
        content: '这是基于 AI 草稿人工修改后的完整答复内容，长度足够通过质量校验。',
        completion_note: 'AI 起草后人工修订，已验证命令可执行',
        drafted_by_ai: true, draft_model: 'deepseek-v4-flash',
      }),
    });
    const j = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(j));

    const logs = q.rows(await s.db.exec('SELECT action, new_value, remark FROM task_logs WHERE task_id = ? ORDER BY id', [tid]));
    const d = logs.find(l => l.action === 'draft');
    assert.ok(d, '应有 draft 留痕');
    assert.strictEqual(d.new_value.drafted_by_ai, true);
    assert.strictEqual(d.new_value.model, 'deepseek-v4-flash');

    const chain = await q.verifyAuditChain(tid);
    assert.strictEqual(chain.valid, true, '留痕后哈希链仍完整');
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s, ids);
  }
});

test('未标记 drafted_by_ai 时不写 draft 留痕', async () => {
  const s = await seed();
  const ids = [];
  try {
    const tid = await mkTask(s.tenantId);
    ids.push(tid);
    await q.claimTask(tid, s.uMatch, '终端match');
    await q.completeTask(tid, '完全由人工撰写的答复内容，没有任何 AI 参与，长度足够。',
      { id: s.uMatch, name: '终端match' }, { completion_note: '人工撰写' });
    const logs = q.rows(await s.db.exec('SELECT action FROM task_logs WHERE task_id = ?', [tid]));
    assert.ok(!logs.some(l => l.action === 'draft'), '无 AI 参与不应有 draft 留痕');
  } finally {
    await cleanup(s, ids);
  }
});
