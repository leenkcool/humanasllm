/**
 * 集成测试：三权分立落库 + 路由门禁
 * - sys_admin 能建用户，不能改分级规则
 * - sec_admin 能改规则，不能建用户
 * - audit_admin 只读：能看用户列表，任何写操作 403
 * - sys_admin 不能授予 admin 角色（防越权自升）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-rbac';

const { initDatabase, getDb } = require('../../db');

let seq = 0;
const unique = () => `rba${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, '权限租户']);
  const ids = {};
  for (const role of ['sys_admin', 'sec_admin', 'audit_admin', 'engineer']) {
    ids[role] = (await db.run(
      'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
      [mk + '-' + role, 'x', role, role, tenantId])).lastId;
  }
  return { db, mk, tenantId, users: ids };
}

function tokenFor(userId, role, tenantId) {
  return jwt.sign({ id: userId, username: 'u' + userId, role, tenant_id: tenantId }, process.env.JWT_SECRET);
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', require('../../routes/users'));
  app.use('/api/rules', require('../../routes/rules'));
  app.use('/api/backup', require('../../routes/backup'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function cleanup(s, extra) {
  for (const uname of extra.usernames || []) {
    await s.db.run('DELETE FROM users WHERE username = ?', [uname]);
  }
  for (const rid of extra.ruleIds || []) {
    await s.db.run('DELETE FROM task_rules WHERE id = ?', [rid]);
  }
  await s.db.run('DELETE FROM users WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM tenants WHERE id = ?', [s.tenantId]);
}

test('sys_admin 建用户通过，改规则 403；不能授予 admin 角色', async () => {
  const s = await seed();
  const { server, base } = await startApp();
  const extra = { usernames: [] };
  try {
    const tok = tokenFor(s.users.sys_admin, 'sys_admin', s.tenantId);
    const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
    const uname = s.mk + '-neweng';
    extra.usernames.push(uname);
    const created = await fetch(`${base}/api/users`, {
      method: 'POST', headers: h, body: JSON.stringify({ username: uname, password: 'admin123', role: 'engineer' }),
    });
    assert.strictEqual(created.status, 200, '系统管理员可建工程师账户');

    const rules = await fetch(`${base}/api/rules`, {
      method: 'POST', headers: h, body: JSON.stringify({ name: 'x', category: 'general', keywords: 'x' }),
    });
    assert.strictEqual(rules.status, 403, '分级规则归安全管理员');

    const escalate = await fetch(`${base}/api/users`, {
      method: 'POST', headers: h, body: JSON.stringify({ username: s.mk + '-evil', password: 'x', role: 'admin' }),
    });
    assert.strictEqual(escalate.status, 403, '不能自行授予 admin');
  } finally {
    server.close();
    await cleanup(s, extra);
  }
});

test('sec_admin 建规则通过，建用户 403', async () => {
  const s = await seed();
  const { server, base } = await startApp();
  const extra = { ruleIds: [] };
  try {
    const tok = tokenFor(s.users.sec_admin, 'sec_admin', s.tenantId);
    const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
    const r = await fetch(`${base}/api/rules`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ name: s.mk + '-rule', category: 'general', keywords: 'rbac-test' }),
    });
    assert.strictEqual(r.status, 200, '安全管理员可维护分级规则');
    const id = (await r.json()).data.id;
    extra.ruleIds.push(id);

    const u = await fetch(`${base}/api/users`, {
      method: 'POST', headers: h, body: JSON.stringify({ username: s.mk + '-x', password: 'x' }),
    });
    assert.strictEqual(u.status, 403, '用户管理归系统管理员');

    const bk = await fetch(`${base}/api/backup/list`, { headers: { Authorization: 'Bearer ' + tok } });
    assert.strictEqual(bk.status, 403, '备份归系统管理员');
  } finally {
    server.close();
    await cleanup(s, extra);
  }
});

test('audit_admin 只读：可看用户列表，任何写操作 403', async () => {
  const s = await seed();
  const { server, base } = await startApp();
  try {
    const tok = tokenFor(s.users.audit_admin, 'audit_admin', s.tenantId);
    const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
    const list = await fetch(`${base}/api/users`, { headers: { Authorization: 'Bearer ' + tok } });
    assert.strictEqual(list.status, 200, '审计管理员可读');
    const data = await list.json();
    assert.ok(Array.isArray(data.data));

    for (const [method, url, body] of [
      ['POST', '/api/users', { username: s.mk + '-a', password: 'x' }],
      ['POST', '/api/rules', { name: 'x', category: 'general', keywords: 'x' }],
      ['POST', '/api/backup/run', {}],
    ]) {
      const r = await fetch(base + url, { method, headers: h, body: JSON.stringify(body) });
      assert.strictEqual(r.status, 403, `${method} ${url} 应被拒绝`);
    }
  } finally {
    server.close();
    await cleanup(s, {});
  }
});

test('engineer 无任何管理权限', async () => {
  const s = await seed();
  const { server, base } = await startApp();
  try {
    const tok = tokenFor(s.users.engineer, 'engineer', s.tenantId);
    const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
    for (const [method, url, body] of [
      ['POST', '/api/users', { username: s.mk + '-b', password: 'x' }],
      ['POST', '/api/rules', { name: 'x', category: 'general', keywords: 'x' }],
      ['GET', '/api/backup/list', null],
    ]) {
      const r = await fetch(base + url, {
        method, headers: h, body: body ? JSON.stringify(body) : undefined,
      });
      assert.strictEqual(r.status, 403, `${method} ${url} 应被拒绝`);
    }
  } finally {
    server.close();
    await cleanup(s, {});
  }
});
