/**
 * 集成测试：合规报告
 * - 租户隔离（回归原 audit/report 全表聚合的越权缺陷）
 * - format=html 返回自包含报告页；format=json 向后兼容
 * - 哈希链一次 join 复核口径
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-audit-report';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const report = require('../../services/reportService');

const MARK = 'audittest';
let seq = 0;
const unique = () => `${MARK}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tA } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk + '-a', '报告租户A']);
  const { lastId: tB } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk + '-b', '报告租户B']);
  const { lastId: adminA } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [mk + '-admin', 'x', 'admin', '报告管理员A', tA]);

  // 租户 A：general + ops + confidential 各一条
  const mkTask = async (tenantId, category, status, source) => {
    const { taskId } = await q.createTaskFromRequest({
      parsed: { model: 'human-llm', stream: false, messages: [{ role: 'user', content: '报告测试任务' }], extra: { priority: 'low', category }, tools: null },
      chatId: mk + '-t' + Math.random().toString(36).slice(2, 7), created: 1, tenantId,
    });
    if (status === 'completed' || source) {
      await db.run('UPDATE tasks SET status = ?, result_payload = ?::jsonb WHERE id = ?',
        [status || 'completed', JSON.stringify(source ? { content: 'x', source } : { content: 'x' }), taskId]);
    }
    return taskId;
  };
  const a1 = await mkTask(tA, 'general', 'completed', null);
  const a2 = await mkTask(tA, 'ops', 'completed', null);
  const a3 = await mkTask(tA, 'confidential', 'pending', null);
  // 租户 A 一条违规 AI 兜底（用于 FAIL 分支与合规结论）
  const a4 = await mkTask(tA, 'ops', 'completed', 'ai-relay');
  const a5 = await mkTask(tA, 'general', 'completed', 'ai-relay');
  // 租户 B：2 条
  const b1 = await mkTask(tB, 'general', 'completed', null);
  const b2 = await mkTask(tB, 'ops', 'completed', null);

  await db.run(
    `INSERT INTO approvals (approval_no, resource, status, tenant_id) VALUES (?, ?, 'pending', ?)`,
    [mk + '-ap1', 'A 审批', tA]);
  await db.run(
    `INSERT INTO approvals (approval_no, resource, status, tenant_id) VALUES (?, ?, 'approved', ?)`,
    [mk + '-ap2', 'B 审批', tB]);

  return { db, mk, tA, tB, adminA, taskIds: [a1, a2, a3, a4, a5, b1, b2] };
}

async function cleanup(s) {
  const { db, tA, tB, adminA, taskIds } = s;
  for (const id of taskIds) {
    await db.run('DELETE FROM alerts WHERE task_id = ?', [id]);
    await db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
    await db.run('DELETE FROM billing_ledger WHERE task_id = ?', [id]);
  }
  for (const id of taskIds) await db.run('DELETE FROM task_reviews WHERE task_id = ?', [id]);
  for (const id of taskIds) await db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await db.run('DELETE FROM approvals WHERE tenant_id IN (?, ?)', [tA, tB]);
  await db.run('DELETE FROM users WHERE id = ?', [adminA]);
  await db.run('DELETE FROM tenants WHERE id IN (?, ?)', [tA, tB]);
}

test('collectReportData 按租户隔离（回归跨租户统计）', async () => {
  const s = await seed();
  try {
    const a = await report.collectReportData({ tenantId: s.tA });
    assert.strictEqual(a.total_tasks, 5, 'A 只统计自己的 5 条任务');
    assert.strictEqual(a.categories.general, 2);
    assert.strictEqual(a.categories.confidential, 1);
    assert.strictEqual(a.categories.ops, 2);
    assert.strictEqual(a.approvals.total, 1, 'A 只统计自己的审批');
    assert.strictEqual(a.audit_chains.checked > 0, true, '哈希链按 A 的任务分组校验');
    assert.strictEqual(a.compliance_pass, false, '存在受保护任务被 AI 兜底 → FAIL');
    assert.strictEqual(a.ai_fallback.protected, 1);

    const b = await report.collectReportData({ tenantId: s.tB });
    assert.strictEqual(b.total_tasks, 2, 'B 只统计自己的 2 条任务');
    assert.strictEqual(b.approvals.total, 1);
    assert.strictEqual(b.compliance_pass, true, 'B 无违规兜底 → PASS');
  } finally {
    await cleanup(s);
  }
});

test('GET /api/audit/report: json 向后兼容 + format=html 自包含 + 未授权 401', async () => {
  const s = await seed();
  const app = express();
  app.use(express.json());
  app.use('/api/audit', require('../../routes/audit'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ id: s.adminA, username: 'audit-admin', role: 'admin', tenant_id: s.tA }, process.env.JWT_SECRET);
  try {
    // 默认 JSON（既有前端 / 冒烟测试依赖）
    const jr = await fetch(`${base}/api/audit/report`, { headers: { Authorization: 'Bearer ' + token } });
    const jj = await jr.json();
    assert.strictEqual(jr.status, 200);
    assert.ok(jr.headers.get('content-type').includes('application/json'));
    assert.ok(jj.data.compliance, '保留原有 compliance 字段');
    assert.strictEqual(jj.data.total_tasks, 5);
    assert.strictEqual(jj.data.scope.tenant_id, s.tA);

    // HTML 报告
    const hr = await fetch(`${base}/api/audit/report?format=html`, { headers: { Authorization: 'Bearer ' + token } });
    const html = await hr.text();
    assert.strictEqual(hr.status, 200);
    assert.ok(hr.headers.get('content-type').includes('text/html'));
    assert.ok(hr.headers.get('cache-control').includes('no-store'));
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('window.print()'));
    assert.ok(html.includes('@media print'));
    assert.ok(html.includes('报告租户A'), '含本租户名');
    assert.ok(!html.includes('报告租户B'), '不含其他租户名');

    // 英文版
    const er = await fetch(`${base}/api/audit/report?format=html&lang=en`, { headers: { Authorization: 'Bearer ' + token } });
    const ehtml = await er.text();
    assert.ok(ehtml.includes('Compliance Report'));
    assert.ok(!ehtml.includes('合规报告'));

    // 未授权
    const noAuth = await fetch(`${base}/api/audit/report`);
    assert.strictEqual(noAuth.status, 401);
    const noAuthHtml = await fetch(`${base}/api/audit/report?format=html`);
    assert.strictEqual(noAuthHtml.status, 401);
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(s);
  }
});

test('哈希链被篡改时报告标记 invalid', async () => {
  const s = await seed();
  try {
    const before = await report.collectReportData({ tenantId: s.tA });
    assert.strictEqual(before.audit_chains.invalid, 0);
    const target = s.taskIds[0];
    await s.db.run(`UPDATE task_logs SET hash = 'tampered' WHERE task_id = ? AND id = (SELECT MIN(id) FROM task_logs WHERE task_id = ?)`, [target, target]);
    const after = await report.collectReportData({ tenantId: s.tA });
    assert.strictEqual(after.audit_chains.invalid, 1, '篡改后应有 1 条异常链');
    assert.strictEqual(after.audit_chains.broken[0].task_id, target);
  } finally {
    await cleanup(s);
  }
});
