const { test } = require('node:test');
const assert = require('node:assert');
const { initDatabase, getDb } = require('../../db');
const a = require('../../services/approvalService');
const project = require('../../services/projectService');

const ADMIN = { id: 1, name: '管理员' };

test('审批流：创建→批准→回查', async () => {
  await initDatabase();
  const db = getDb();
  const created = await a.createApproval({ resource: '测试服务器', amount: '2C4G', purpose: '测试', requester: 't-flow', tenant_id: null });
  try {
    assert.strictEqual((await a.getApprovalByNo(created.approval_no)).status, 'pending');
    const ok = await a.approve(created.id, '已提供 192.168.168.60', ADMIN);
    assert.strictEqual(ok.approval.status, 'approved');
    assert.strictEqual(ok.approval.provided, '已提供 192.168.168.60');
    assert.strictEqual((await a.getApprovalByNo(created.approval_no)).status, 'approved');
  } finally {
    await db.run('DELETE FROM approvals WHERE id = ?', [created.id]);
  }
});

test('审批流：驳回 + 项目申请自动建项目', async () => {
  await initDatabase();
  const db = getDb();
  const rej = await a.createApproval({ resource: 'x', purpose: 'x', requester: 't-rej', tenant_id: null });
  await a.reject(rej.id, '不批准', ADMIN);
  assert.strictEqual((await a.getApproval(rej.id)).status, 'rejected');
  assert.strictEqual((await a.getApproval(rej.id)).reject_reason, '不批准');

  const appr = await a.createApproval({
    type: 'project', resource: '项目申请:testproj', purpose: '测试项目',
    detail: JSON.stringify({ code: 'testproj', name: '测试项目', desc: '' }),
    requester: 't-proj', tenant_id: null,
  });
  await a.approve(appr.id, '已批准', ADMIN);
  try {
    const p = await project.createFromApproval(await a.getApproval(appr.id));
    assert.strictEqual(p.code, 'testproj');
  } finally {
    await db.run("DELETE FROM projects WHERE code = 'testproj'", []);
    await db.run('DELETE FROM approvals WHERE id IN (?, ?)', [rej.id, appr.id]);
  }
});
