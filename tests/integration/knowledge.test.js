/**
 * 集成测试：项目成员 + 知识库作用域隔离
 * 核心保证：项目知识库只有项目成员 + admin 可见；涉密条目永不进入共享池
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { initDatabase, getDb } = require('../../db');
const members = require('../../services/projectMemberService');
const knowledge = require('../../services/knowledgeService');
const projectSvc = require('../../services/projectService');

let seq = 0;
const unique = () => `kbtest-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, '知识租户']);
  const mkUser = async (suffix, role) => (await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [mk + '-' + suffix, 'x', role, '知识' + suffix, tenantId])).lastId;
  const admin = await mkUser('admin', 'admin');
  const uA = await mkUser('a', 'engineer');
  const uB = await mkUser('b', 'engineer');

  // 两个项目：P1（uA 是成员）、P2（uB 是成员）
  await projectSvc.createProject({ code: mk + '-P1', name: '项目一', createdBy: admin, tenantId });
  await projectSvc.createProject({ code: mk + '-P2', name: '项目二', createdBy: admin, tenantId });
  await members.addMember({ projectCode: mk + '-P1', userId: uA, role: 'owner', tenantId });
  await members.addMember({ projectCode: mk + '-P2', userId: uB, role: 'owner', tenantId });

  return { db, mk, tenantId, admin, uA, uB, p1: mk + '-P1', p2: mk + '-P2' };
}

async function cleanup(s, ids) {
  for (const id of ids.entries) await s.db.run('DELETE FROM knowledge_entries WHERE id = ?', [id]);
  await s.db.run('DELETE FROM knowledge_entries WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM project_members WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM task_reviews WHERE task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)', [s.tenantId]);
  await s.db.run('DELETE FROM tasks WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM projects WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM users WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM tenants WHERE id = ?', [s.tenantId]);
}

test('项目成员：建项目者自动成为 owner', async () => {
  const s = await seed();
  const ids = { entries: [] };
  try {
    const list = await members.listMembers(s.p1, s.tenantId);
    assert.ok(list.some(m => m.user_id === s.admin && m.role === 'owner'), '创建者应为 owner');
    assert.ok(list.some(m => m.user_id === s.uA && m.role === 'owner'), '显式添加的成员应为 owner');
    assert.ok(!list.some(m => m.user_id === s.uB), 'uB 不属于 P1');
  } finally {
    await cleanup(s, ids);
  }
});

test('项目知识库：仅项目成员 + admin 可见', async () => {
  const s = await seed();
  const ids = { entries: [] };
  try {
    const r = await knowledge.create({
      title: 'P1 专有排障经验', category: 'ops', scope: 'project', project_code: s.p1,
      problem: 'HIS 系统夜间批处理超时如何排查？', solution: '查看执行计划与资源占用，重点看 autovacuum 与索引膨胀。',
    }, { id: s.uA }, s.tenantId);
    assert.strictEqual(r.ok, true);
    ids.entries.push(r.id);

    // uA（P1 owner）可见
    assert.ok(await knowledge.get({ id: r.id, user: { id: s.uA, role: 'engineer' }, tenantId: s.tenantId }));
    // uB（只属于 P2）不可见
    assert.strictEqual(
      await knowledge.get({ id: r.id, user: { id: s.uB, role: 'engineer' }, tenantId: s.tenantId }),
      null, '非项目成员不可见');
    // admin 可见
    assert.ok(await knowledge.get({ id: r.id, user: { id: s.admin, role: 'admin' }, tenantId: s.tenantId }));

    // 列表同理
    const listB = await knowledge.list({ user: { id: s.uB, role: 'engineer' }, tenantId: s.tenantId });
    assert.ok(!listB.data.some(x => x.id === r.id), 'uB 列表不含 P1 条目');
    const listA = await knowledge.list({ user: { id: s.uA, role: 'engineer' }, tenantId: s.tenantId });
    assert.ok(listA.data.some(x => x.id === r.id), 'uA 列表含 P1 条目');
  } finally {
    await cleanup(s, ids);
  }
});

test('租户知识库：同租户全员可见；其他租户不可见', async () => {
  const s = await seed();
  const ids = { entries: [] };
  const db = s.db;
  const { lastId: otherTenant } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [s.mk + '-other', '其他租户']);
  const { lastId: outsider } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [s.mk + '-outsider', 'x', 'engineer', '外部', otherTenant]);
  try {
    const r = await knowledge.create({
      title: '通用等保流程', category: 'general', scope: 'tenant',
      problem: '等保二级备案需要哪些材料？', solution: '定级报告、备案表、测评报告、整改记录。',
    }, { id: s.uA }, s.tenantId);

    assert.ok(await knowledge.get({ id: r.id, user: { id: s.uB, role: 'engineer' }, tenantId: s.tenantId }), '同租户可见');
    assert.strictEqual(
      await knowledge.get({ id: r.id, user: { id: outsider, role: 'engineer' }, tenantId: otherTenant }),
      null, '跨租户不可见');
  } finally {
    await db.run('DELETE FROM knowledge_entries WHERE tenant_id = ?', [s.tenantId]);
    await db.run('DELETE FROM users WHERE id = ?', [outsider]);
    await db.run('DELETE FROM tenants WHERE id = ?', [otherTenant]);
    await cleanup(s, ids);
  }
});

test('涉密条目：只能作为项目知识库，拒绝 tenant/global', async () => {
  const s = await seed();
  const ids = { entries: [] };
  try {
    const bad1 = await knowledge.create({
      title: '涉密内容', category: 'confidential', scope: 'tenant',
      problem: 'x', solution: 'y',
    }, { id: s.uA }, s.tenantId);
    assert.strictEqual(bad1.ok, false);
    assert.ok(bad1.message.includes('confidential'));

    const bad2 = await knowledge.create({
      title: '涉密内容2', category: 'confidential', scope: 'global',
      problem: 'x', solution: 'y',
    }, { id: s.uA }, s.tenantId);
    assert.strictEqual(bad2.ok, false);

    // project 作用域允许
    const ok = await knowledge.create({
      title: '涉密排障', category: 'confidential', scope: 'project', project_code: s.p1,
      problem: '敏感数据库迁移方案', solution: '先备份再迁移。',
    }, { id: s.uA }, s.tenantId);
    assert.strictEqual(ok.ok, true, ok.message);
    assert.strictEqual(ok.scope, 'project');
  } finally {
    await cleanup(s, ids);
  }
});

test('相似检索：只在可见范围内命中', async () => {
  const s = await seed();
  const ids = { entries: [] };
  try {
    const r = await knowledge.create({
      title: 'P1 死锁排查', category: 'ops', scope: 'project', project_code: s.p1,
      problem: 'PostgreSQL 出现死锁如何定位阻塞链？', solution: '查 pg_stat_activity 与 pg_blocking_pids。',
    }, { id: s.uA }, s.tenantId);
    ids.entries.push(r.id);

    const hitA = await knowledge.similar({
      text: 'PostgreSQL 死锁定位阻塞链', user: { id: s.uA, role: 'engineer' }, tenantId: s.tenantId,
    });
    assert.ok(hitA.length > 0, 'uA 应命中');
    const hitB = await knowledge.similar({
      text: 'PostgreSQL 死锁定位阻塞链', user: { id: s.uB, role: 'engineer' }, tenantId: s.tenantId,
    });
    assert.strictEqual(hitB.length, 0, 'uB 不应命中 P1 条目');
  } finally {
    await cleanup(s, ids);
  }
});

test('权限：仅作者或 admin 可编辑删除', async () => {
  const s = await seed();
  const ids = { entries: [] };
  try {
    const r = await knowledge.create({
      title: '通用流程', category: 'general', scope: 'tenant',
      problem: 'p', solution: 's',
    }, { id: s.uA }, s.tenantId);
    const deny = await knowledge.update(r.id, { title: '改名' }, { id: s.uB, role: 'engineer' }, s.tenantId);
    assert.strictEqual(deny.ok, false);
    assert.ok(deny.message.includes('作者'));
    const allow = await knowledge.update(r.id, { title: '改名' }, { id: s.uA, role: 'engineer' }, s.tenantId);
    assert.strictEqual(allow.ok, true);
    const adminOk = await knowledge.remove(r.id, { id: s.admin, role: 'admin' }, s.tenantId);
    assert.strictEqual(adminOk.ok, true);
  } finally {
    await cleanup(s, ids);
  }
});
