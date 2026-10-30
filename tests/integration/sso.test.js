/**
 * 集成测试：企业 SSO（OAuth2 授权码）
 * 用本地 mock IdP 跑通完整链路：start → 302 授权页 → callback 换 token → 取用户 → 签发 JWT
 * - 首次登录自动建号（engineer，永不是 admin）
 * - 同邮箱已有账户时绑定而非重复建号
 * - state 重放被拒；SSO_AUTO_CREATE=false 时未开通账户给出明确错误
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sso';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');

const MARK = 'ssotest';
let seq = 0;
const unique = () => `${MARK}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

/** 本地 mock IdP：/token 换令牌、/userinfo 返回用户 */
async function startIdp(profile) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.post('/token', (req, res) => {
    if (req.body.code !== 'good-code') return res.status(400).json({ error: 'invalid_grant' });
    res.json({ access_token: 'at-123', token_type: 'Bearer' });
  });
  app.get('/userinfo', (req, res) => {
    if (req.headers.authorization !== 'Bearer at-123') return res.status(401).json({ error: 'bad token' });
    res.json(profile);
  });
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth/sso', require('../../routes/sso'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function configure(idpBase) {
  process.env.SSO_PROVIDERS = 'corp';
  process.env.SSO_CORP_LABEL = '公司统一登录';
  process.env.SSO_CORP_CLIENT_ID = 'cid';
  process.env.SSO_CORP_CLIENT_SECRET = 'secret';
  process.env.SSO_CORP_AUTH_URL = 'https://id.example.com/authorize';
  process.env.SSO_CORP_TOKEN_URL = idpBase + '/token';
  process.env.SSO_CORP_USERINFO_URL = idpBase + '/userinfo';
  process.env.SSO_CORP_DEFAULT_ROLE = 'engineer';
  delete process.env.SSO_AUTO_CREATE;
  delete process.env.SSO_LINK_BY_EMAIL;
}

function clearConfig() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SSO_')) delete process.env[k];
  }
}

/** 走一遍 start → 拿到 state */
async function startFlow(base) {
  const r = await fetch(`${base}/api/auth/sso/corp/start?next=/queue`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  return { loc, state: loc.searchParams.get('state') };
}

async function callback(base, state, code = 'good-code', token) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  return fetch(`${base}/api/auth/sso/corp/callback?code=${code}&state=${state}`, { redirect: 'manual', headers });
}

async function cleanup(s, extraUsers) {
  for (const id of extraUsers) await s.db.run('DELETE FROM users WHERE id = ?', [id]);
  await s.db.run('DELETE FROM users WHERE username LIKE ?', [s.mk + '%']);
  await s.db.run('DELETE FROM tenants WHERE id = ?', [s.tenantId]);
}

test('SSO 首次登录：自动建号 + 签发 JWT + state 重放被拒', async () => {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, 'SSO 租户']);
  const profile = { sub: mk + '-subject', email: mk + '@corp.com', name: '单点用户', preferred_username: mk };
  const idp = await startIdp(profile);
  configure(idp.base);
  const { server, base } = await startApp();
  const created = [];
  try {
    const { loc, state } = await startFlow(base);
    assert.strictEqual(loc.origin + loc.pathname, 'https://id.example.com/authorize');
    assert.strictEqual(loc.searchParams.get('client_id'), 'cid');
    assert.ok(state && state.length >= 32, 'state 足够随机');

    const cb = await callback(base, state);
    assert.strictEqual(cb.status, 302);
    const frag = new URL(cb.headers.get('location'), 'http://x');
    assert.strictEqual(frag.pathname, '/sso.html');
    const params = new URLSearchParams(frag.hash.replace(/^#/, ''));
    const token = params.get('token');
    assert.ok(token, '应把 JWT 放在 fragment');
    assert.strictEqual(params.get('next'), '/queue');
    assert.strictEqual(params.get('created'), '1');

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = q.rows(await db.exec('SELECT * FROM users WHERE id = ?', [decoded.id]))[0];
    created.push(user.id);
    assert.strictEqual(user.username, mk);
    assert.strictEqual(user.email, profile.email);
    assert.strictEqual(user.sso_provider, 'corp');
    assert.strictEqual(user.sso_subject, profile.sub);
    assert.strictEqual(user.role, 'engineer', 'SSO 建号默认 engineer');
    const defTenant = q.rows(await db.exec("SELECT id FROM tenants WHERE code = 'default'"))[0];
    assert.strictEqual(user.tenant_id, defTenant ? defTenant.id : null, '新号落在默认租户');

    // state 重放
    const again = await callback(base, state);
    assert.strictEqual(again.status, 400, 'state 只能使用一次');
  } finally {
    server.close();
    idp.server.close();
    await cleanup({ db, mk, tenantId }, created);
    clearConfig();
  }
});

test('SSO 绑定既有账户（按邮箱），不重复建号、不夺权', async () => {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, 'SSO 租户']);
  const { lastId: userId } = await db.run(
    'INSERT INTO users (username, email, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
    [mk, mk + '@corp.com', 'x', 'sys_admin', '既有系统管理员', tenantId]);
  const profile = { sub: mk + '-sub2', email: mk + '@corp.com', name: '既有用户' };
  const idp = await startIdp(profile);
  configure(idp.base);
  const { server, base } = await startApp();
  try {
    const { state } = await startFlow(base);
    const cb = await callback(base, state);
    assert.strictEqual(cb.status, 302);
    const params = new URLSearchParams(new URL(cb.headers.get('location'), 'http://x').hash.replace(/^#/, ''));
    const token = params.get('token');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    assert.strictEqual(decoded.id, userId, '应绑定到既有账户');
    assert.strictEqual(decoded.role, 'sys_admin', '既有角色不被 SSO 降级或提升');
    assert.strictEqual(params.get('created'), null, '不是新建');

    const row = q.rows(await db.exec('SELECT sso_provider, sso_subject FROM users WHERE id = ?', [userId]))[0];
    assert.strictEqual(row.sso_provider, 'corp');
    assert.strictEqual(row.sso_subject, profile.sub);
  } finally {
    server.close();
    idp.server.close();
    await cleanup({ db, mk, tenantId }, []);
    clearConfig();
  }
});

test('SSO_AUTO_CREATE=false：未开通账户给出明确提示，不建号', async () => {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, 'SSO 租户']);
  const profile = { sub: mk + '-sub3', email: mk + '-nobody@corp.com', name: '陌生人' };
  const idp = await startIdp(profile);
  configure(idp.base);
  process.env.SSO_AUTO_CREATE = 'false';
  const { server, base } = await startApp();
  try {
    const { state } = await startFlow(base);
    const cb = await callback(base, state);
    assert.strictEqual(cb.status, 302);
    const params = new URLSearchParams(new URL(cb.headers.get('location'), 'http://x').hash.replace(/^#/, ''));
    assert.ok(params.get('error'), '应带错误提示');
    assert.strictEqual(params.get('token'), null);
    const rows = q.rows(await db.exec('SELECT id FROM users WHERE email = ?', [profile.email]));
    assert.strictEqual(rows.length, 0, '不得自动建号');
  } finally {
    server.close();
    idp.server.close();
    await cleanup({ db, mk, tenantId }, []);
    clearConfig();
  }
});

test('授权码错误 / 缺 state：拒绝且不签发令牌', async () => {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, 'SSO 租户']);
  const idp = await startIdp({ sub: 'x' });
  configure(idp.base);
  const { server, base } = await startApp();
  try {
    const { state } = await startFlow(base);
    const bad = await callback(base, state, 'bad-code');
    assert.strictEqual(bad.status, 302);
    const params = new URLSearchParams(new URL(bad.headers.get('location'), 'http://x').hash.replace(/^#/, ''));
    assert.ok(params.get('error'));
    assert.strictEqual(params.get('token'), null);

    const noState = await callback(base, 'not-a-real-state');
    assert.strictEqual(noState.status, 400);

    const noProvider = await fetch(`${base}/api/auth/sso/nope/start`, { redirect: 'manual' });
    assert.strictEqual(noProvider.status, 404);
  } finally {
    server.close();
    idp.server.close();
    await cleanup({ db, mk, tenantId }, []);
    clearConfig();
  }
});
