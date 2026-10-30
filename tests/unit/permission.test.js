/**
 * 单元测试：三权分立权限矩阵（不连库）
 * 关键约束——审计管理员必须只读：新增权限点若误配给 audit_admin 会立即失败。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const perm = require('../../services/permissionService');

test('权限矩阵自洽：角色都在 ROLES、权限点都已声明', () => {
  for (const role of Object.keys(perm.ROLE_PERMISSIONS)) {
    assert.ok(perm.ROLES.includes(role), `未登记的角色：${role}`);
  }
  for (const role of perm.ROLES) {
    assert.ok(perm.ROLE_PERMISSIONS[role], `角色缺少权限表：${role}`);
  }
  for (const [role, list] of Object.entries(perm.ROLE_PERMISSIONS)) {
    for (const p of list) {
      if (p === '*') continue;
      assert.ok(perm.PERMISSIONS.includes(p), `${role} 引用了未声明的权限点：${p}`);
    }
  }
});

test('admin 拥有全部权限（通配）', () => {
  assert.deepStrictEqual(perm.permissionsOf('admin'), ['*']);
  for (const p of perm.PERMISSIONS) {
    assert.strictEqual(perm.can({ role: 'admin' }, p), true, p);
  }
});

test('系统管理员管人和资源，不碰安全策略', () => {
  const u = { role: 'sys_admin' };
  assert.strictEqual(perm.can(u, 'users.manage'), true);
  assert.strictEqual(perm.can(u, 'tenants.manage'), true);
  assert.strictEqual(perm.can(u, 'system.backup'), true);
  assert.strictEqual(perm.can(u, 'rules.manage'), false, '安全策略归安全管理员');
  assert.strictEqual(perm.can(u, 'reviews.spotcheck'), false);
});

test('安全管理员管策略和质量，不管用户', () => {
  const u = { role: 'sec_admin' };
  assert.strictEqual(perm.can(u, 'rules.manage'), true);
  assert.strictEqual(perm.can(u, 'reviews.spotcheck'), true);
  assert.strictEqual(perm.can(u, 'annotations.evalset'), true);
  assert.strictEqual(perm.can(u, 'users.manage'), false, '用户管理归系统管理员');
  assert.strictEqual(perm.can(u, 'system.backup'), false);
});

test('审计管理员只读：除 audit.read 外没有任何权限（长期锁死）', () => {
  const u = { role: 'audit_admin' };
  assert.strictEqual(perm.can(u, 'audit.read'), true);
  for (const p of perm.PERMISSIONS) {
    if (p === 'audit.read') continue;
    assert.strictEqual(perm.can(u, p), false, `审计管理员不得拥有 ${p}`);
  }
});

test('工程师无管理权限（保持既有行为）', () => {
  const u = { role: 'engineer' };
  for (const p of perm.PERMISSIONS) {
    assert.strictEqual(perm.can(u, p), false, p);
  }
  assert.deepStrictEqual(perm.permissionsOf('engineer'), []);
});

test('未知角色 / 空用户一律拒绝', () => {
  assert.strictEqual(perm.can({ role: 'hacker' }, 'users.manage'), false);
  assert.strictEqual(perm.can(null, 'users.manage'), false);
  assert.strictEqual(perm.can({}, 'users.manage'), false);
  assert.strictEqual(perm.isValidRole('hacker'), false);
  assert.strictEqual(perm.isValidRole('audit_admin'), true);
});

test('requirePermission 中间件：有权限放行，无权限 403', () => {
  const mw = perm.requirePermission('rules.manage');
  let called = false;
  const res = {
    statusCode: 0,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  mw({ user: { role: 'sec_admin' } }, res, () => { called = true; });
  assert.strictEqual(called, true);

  called = false;
  mw({ user: { role: 'engineer' } }, res, () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(res.statusCode, 403);
  assert.ok(res.body.message.includes('rules.manage'));
});

test('canAny：任一命中即可', () => {
  assert.strictEqual(perm.canAny({ role: 'sec_admin' }, ['users.manage', 'rules.manage']), true);
  assert.strictEqual(perm.canAny({ role: 'engineer' }, ['users.manage', 'rules.manage']), false);
});
