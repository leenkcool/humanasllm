/**
 * 集成测试：智能派单 + 告警中心
 * - 派单：技能匹配排序 / dry_run 不改状态 / assign 落审计 / 跨租户 404 / 工程师 403
 * - 告警：L2 告警写入 + 去重 / 终态收起 / 跨租户隔离 / 审批超时不重复发信
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-dispatch-alerts';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const dispatch = require('../../services/dispatchService');
const alert = require('../../services/alertService');

const MARK = 'dalert';
let seq = 0;
const unique = () => `${MARK}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tA } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk + '-a', '派单租户A']);
  const { lastId: tB } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk + '-b', '派单租户B']);
  const { lastId: adminA } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [mk + '-admin', 'x', 'admin', '派单管理员', tA]);
  // 技能匹配者（空闲）
  const { lastId: engMatch } = await db.run(
    'INSERT INTO users (username, password, role, name, skills, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
    [mk + '-match', 'x', 'engineer', '匹配工程师', 'postgres,ops', tA]);
  // 技能不匹配、负载高者
  const { lastId: engBusy } = await db.run(
    'INSERT INTO users (username, password, role, name, skills, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
    [mk + '-busy', 'x', 'engineer', '繁忙工程师', 'frontend', tA]);
  return { db, mk, tA, tB, adminA, engMatch, engBusy };
}

async function newTask(tenantId, { skills, content } = {}) {
  const { taskId } = await q.createTaskFromRequest({
    parsed: {
      model: 'human-llm', stream: false,
      messages: [{ role: 'user', content: content || '派单测试任务' }],
      extra: { priority: 'low', ...(skills ? { skills } : {}) }, tools: null,
    },
    chatId: 'da-' + Math.random().toString(36).slice(2, 9), created: 1, tenantId,
  });
  return taskId;
}

async function cleanup(s, taskIds) {
  for (const id of taskIds) {
    await s.db.run('DELETE FROM alerts WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM billing_ledger WHERE task_id = ?', [id]);
  }
  for (const id of taskIds) await s.db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await s.db.run('DELETE FROM alerts WHERE tenant_id IN (?, ?)', [s.tA, s.tB]);
  await s.db.run('DELETE FROM users WHERE id IN (?, ?, ?)', [s.adminA, s.engMatch, s.engBusy]);
  await s.db.run('DELETE FROM tenants WHERE id IN (?, ?)', [s.tA, s.tB]);
}

test('派单：技能匹配者排第一，dry_run 不改状态，assign 落审计', async () => {
  const s = await seed();
  const ids = [];
  try {
    const tid = await newTask(s.tA, { skills: 'postgres,ops' });
    ids.push(tid);
    // 给 busy 制造负载
    const busyTask = await newTask(s.tA, { skills: 'frontend' });
    ids.push(busyTask);
    await q.claimTask(busyTask, s.engBusy, '繁忙工程师');

    const sug = await dispatch.suggest({ taskId: tid, limit: 5 });
    assert.strictEqual(sug.ok, true);
    assert.strictEqual(sug.data.assignable, true);
    assert.strictEqual(sug.data.candidates.length, 2);
    assert.strictEqual(sug.data.recommended.user_id, s.engMatch, '技能匹配 + 空闲者应排第一');
    assert.ok(sug.data.recommended.reasons.length >= 3, '应给出打分理由');

    // dry_run 不改状态
    const dry = await dispatch.assign({ taskId: tid, dryRun: true });
    assert.strictEqual(dry.ok, true);
    assert.strictEqual((await q.getTask(tid)).status, 'pending', 'dry_run 不影响任务状态');

    // 真正派单
    const r = await dispatch.assign({ taskId: tid, actor: { id: s.adminA, name: '派单管理员' } });
    assert.strictEqual(r.ok, true);
    const after = await q.getTask(tid);
    assert.strictEqual(after.status, 'processing');
    assert.strictEqual(after.assignee_id, s.engMatch);

    // 审计：dispatch 日志进入哈希链，链路仍完整
    const logs = q.rows(await s.db.exec('SELECT action FROM task_logs WHERE task_id = ? ORDER BY id', [tid]));
    assert.ok(logs.some(l => l.action === 'dispatch'), '应有 dispatch 审计记录');
    const chain = await q.verifyAuditChain(tid);
    assert.strictEqual(chain.valid, true, '派单后哈希链仍完整');

    // 已处理中的任务不可再派
    const again = await dispatch.assign({ taskId: tid });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.status, 409);
  } finally {
    await cleanup(s, ids);
  }
});

test('派单：跨租户 404 / 工程师角色 403 / 无候选人 409', async () => {
  const s = await seed();
  const ids = [];
  const app = express();
  app.use(express.json());
  app.use('/api/dispatch', require('../../routes/dispatch'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const tid = await newTask(s.tA, { skills: 'postgres' });
    ids.push(tid);
    const adminTok = jwt.sign({ id: s.adminA, username: 'a', role: 'admin', tenant_id: s.tA }, process.env.JWT_SECRET);
    const engTok = jwt.sign({ id: s.engMatch, username: 'e', role: 'engineer', tenant_id: s.tA }, process.env.JWT_SECRET);
    const otherTok = jwt.sign({ id: s.adminA, username: 'a', role: 'admin', tenant_id: s.tB }, process.env.JWT_SECRET);

    // 跨租户 → 404（不泄露存在性）
    const cross = await fetch(`${base}/api/dispatch/tasks/${tid}/suggest`, { headers: { Authorization: 'Bearer ' + otherTok } });
    assert.strictEqual(cross.status, 404);

    // 工程师不能派单
    const forbidden = await fetch(`${base}/api/dispatch/tasks/${tid}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + engTok }, body: '{}',
    });
    assert.strictEqual(forbidden.status, 403);

    // admin 可看建议
    const sug = await fetch(`${base}/api/dispatch/tasks/${tid}/suggest`, { headers: { Authorization: 'Bearer ' + adminTok } });
    assert.strictEqual(sug.status, 200);
    const sj = await sug.json();
    assert.ok(sj.data.recommended, '应有推荐人选');
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s, ids);
  }
});

test('告警：SLA 达 80% 写 L2 告警且不重复，终态自动收起', async () => {
  const s = await seed();
  const ids = [];
  try {
    const tid = await newTask(s.tA);
    ids.push(tid);
    // 构造已用时 170 / 总 200 分钟 = 85%（避开 80% 边界的毫秒级抖动）
    // 注意：slaStart 取 max(claimed_at, created_at, updated_at)，三者都要回拨
    await s.db.run(
      `UPDATE tasks SET created_at = NOW() - interval '170 minutes',
         claimed_at = NOW() - interval '170 minutes', updated_at = NOW() - interval '170 minutes',
         timeout_at = NOW() + interval '30 minutes', status = 'processing', assignee_id = ? WHERE id = ?`,
      [s.engMatch, tid]);

    const r1 = await alert.scanOnce();
    assert.ok(r1.escalated >= 1, '应产生告警: ' + JSON.stringify(r1));
    const a1 = q.rows(await s.db.exec('SELECT * FROM alerts WHERE task_id = ? ORDER BY id', [tid]));
    assert.strictEqual(a1.length, 1, '同一任务同一时刻只应有一条活跃告警');
    assert.strictEqual(a1[0].level, 2, '80% 应为 L2');
    assert.strictEqual(a1[0].status, 'active');

    // 再扫一次：不新增（去重）
    await alert.scanOnce();
    const a2 = q.rows(await s.db.exec(`SELECT * FROM alerts WHERE task_id = ? AND status = 'active'`, [tid]));
    assert.strictEqual(a2.length, 1, '重复扫描不应新增告警');

    // 任务进入终态 → 告警收起
    await q.transition(tid, 'completed', { id: s.engMatch, name: '匹配工程师' }, '派单测试完成', {
      result_text: '派单与告警测试的完整产出内容', completed_at: { __expr: 'NOW()' },
    });
    await alert.resolveAlerts(tid);
    const a3 = q.rows(await s.db.exec(`SELECT status FROM alerts WHERE task_id = ?`, [tid]));
    assert.ok(a3.every(x => x.status === 'resolved'), '终态后告警应为 resolved');
  } finally {
    await cleanup(s, ids);
  }
});

test('告警：跨租户隔离 + 驳回滞留升级 L4', async () => {
  const s = await seed();
  const ids = [];
  try {
    const tid = await newTask(s.tA);
    ids.push(tid);
    const staleMin = alert.levelsConfig().return_stale_min;
    await s.db.run(
      `UPDATE tasks SET status = 'returned', escalation_level = 3, timeout_at = NULL,
         updated_at = NOW() - interval '${parseInt(staleMin) + 5} minutes' WHERE id = ?`, [tid]);

    await alert.scanOnce();
    const row = q.rows(await s.db.exec('SELECT level, tenant_id FROM alerts WHERE task_id = ? ORDER BY id DESC LIMIT 1', [tid]))[0];
    assert.ok(row, '应产生滞留告警');
    assert.strictEqual(row.level, 4, '滞留一个间隔应为 L4');
    assert.strictEqual(row.tenant_id, s.tA, '告警归属任务租户');

    const aList = await alert.listAlerts({ tenantId: s.tA });
    assert.ok(aList.data.some(x => x.task_id === tid));
    const bList = await alert.listAlerts({ tenantId: s.tB });
    assert.ok(!bList.data.some(x => x.task_id === tid), '其他租户看不到该告警');
  } finally {
    await cleanup(s, ids);
  }
});

test('审批超时：连续两次扫描只提醒一次（回归每分钟重复发信）', async () => {
  const s = await seed();
  try {
    const { lastId: apId } = await s.db.run(
      `INSERT INTO approvals (approval_no, resource, status, tenant_id, created_at)
       VALUES (?, ?, 'pending', ?, NOW() - interval '25 hours')`,
      [s.mk + '-ap', '超时审批', s.tA]);
    try {
      await alert.scanOverdueApprovals();
      const first = q.rows(await s.db.exec(
        `SELECT remind_count, last_reminded_at FROM approvals WHERE id = ?`, [apId]))[0];
      assert.strictEqual(first.remind_count, 1, '首次扫描应提醒一次');
      assert.ok(first.last_reminded_at, '应记录提醒时间');

      await alert.scanOverdueApprovals();
      const second = q.rows(await s.db.exec(
        `SELECT remind_count FROM approvals WHERE id = ?`, [apId]))[0];
      assert.strictEqual(second.remind_count, 1, '再次扫描不应重复提醒');

      const alerts = q.rows(await s.db.exec(
        `SELECT * FROM alerts WHERE approval_id = ? AND status = 'active'`, [apId]));
      assert.strictEqual(alerts.length, 1, '审批超时告警只应有一条活跃');
    } finally {
      await s.db.run('DELETE FROM alerts WHERE approval_id = ?', [apId]);
      await s.db.run('DELETE FROM approvals WHERE id = ?', [apId]);
    }
  } finally {
    await cleanup(s, []);
  }
});
