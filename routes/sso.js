/**
 * 企业 SSO 路由（授权码模式）
 *  - GET /api/auth/sso/providers              已配置的登录方式
 *  - GET /api/auth/sso/:name/start?next=/x    302 到 IdP 授权页（state 一次性）
 *  - GET /api/auth/sso/:name/callback?code&state 换取用户 → 签发 JWT → 302 到 /sso.html#token=...
 *
 * 安全要点：
 *   - state 一次性且 10 分钟过期，防止 CSRF 与重放；
 *   - next 只允许站内相对路径（防开放重定向）；
 *   - token 走 fragment，不进服务端访问日志与 Referer；
 *   - SSO 建号默认 engineer，**永不自动授予 admin**（提权必须由管理员在用户页操作）。
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb } = require('../db');
const { signToken } = require('../middleware/auth');
const { rows } = require('../services/queueService');
const sso = require('../services/ssoService');
const perm = require('../services/permissionService');

function baseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function redirectUriOf(req, name) {
  return `${baseUrl(req)}/api/auth/sso/${name}/callback`;
}

router.get('/providers', (req, res) => {
  res.json({ success: true, data: sso.listProviders() });
});

router.get('/:name/start', (req, res) => {
  const p = sso.getProvider(req.params.name);
  if (!p) return res.status(404).json({ success: false, message: '未配置该登录方式' });
  const state = sso.createState({ name: p.name, next: req.query.next });
  res.redirect(sso.buildAuthorizeUrl(p, { redirectUri: redirectUriOf(req, p.name), state }));
});

/** 按 subject 或邮箱找到本地账户；都没有时按开关自动建号 */
async function resolveUser(p, profile) {
  const db = getDb();
  if (profile.subject) {
    const bySubject = rows(await db.exec(
      'SELECT * FROM users WHERE sso_provider = ? AND sso_subject = ?', [p.name, profile.subject]))[0];
    if (bySubject) return { user: bySubject, created: false };
  }
  if (profile.email && sso.linkByEmailEnabled()) {
    const byEmail = rows(await db.exec('SELECT * FROM users WHERE email = ?', [profile.email]))[0];
    if (byEmail) {
      await db.run('UPDATE users SET sso_provider = ?, sso_subject = ? WHERE id = ?',
        [p.name, profile.subject || null, byEmail.id]);
      return { user: byEmail, created: false };
    }
  }
  if (!sso.autoCreateEnabled()) return { user: null, created: false };

  // 用户名冲突时追加数字后缀（SSO 用户名不可信，不能覆盖既有账户）
  let username = profile.username;
  for (let i = 2; i < 50; i++) {
    const dup = rows(await db.exec('SELECT id FROM users WHERE username = ?', [username]))[0];
    if (!dup) break;
    username = `${profile.username}${i}`;
  }
  const tenant = rows(await db.exec("SELECT id FROM tenants WHERE code = 'default'"))[0];
  // 角色来自 provider 配置，但**永不自动授予 admin**（提权必须由管理员在用户页操作）
  const wanted = String(p.defaultRole || 'engineer');
  const role = perm.isValidRole(wanted) && wanted !== 'admin' ? wanted : 'engineer';
  // 随机占位密码：SSO 账户不用于密码登录
  const placeholder = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const { lastId } = await db.run(
    `INSERT INTO users (username, email, password, role, name, is_active, tenant_id, sso_provider, sso_subject)
     VALUES (?, ?, ?, ?, ?, true, ?, ?, ?)`,
    [username, profile.email, placeholder, role, profile.name || username,
      tenant ? tenant.id : null, p.name, profile.subject || null]);
  const user = rows(await db.exec('SELECT * FROM users WHERE id = ?', [lastId]))[0];
  return { user, created: true };
}

router.get('/:name/callback', async (req, res) => {
  const p = sso.getProvider(req.params.name);
  if (!p) return res.status(404).json({ success: false, message: '未配置该登录方式' });
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.redirect(`/sso.html#error=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) return res.status(400).json({ success: false, message: '缺少授权码' });

  const rec = sso.consumeState(state, p.name);
  if (!rec) return res.status(400).json({ success: false, message: '登录状态无效或已过期，请重新登录' });

  try {
    const token = await sso.exchangeCode(p, { code, redirectUri: redirectUriOf(req, p.name) });
    const info = await sso.fetchUserinfo(p, token.access_token);
    const profile = sso.mapProfile(p, info || {});
    const { user, created } = await resolveUser(p, profile);
    if (!user) {
      return res.redirect(`/sso.html#error=${encodeURIComponent('该账户未开通，请联系管理员')}`);
    }
    if (!user.is_active) {
      return res.redirect(`/sso.html#error=${encodeURIComponent('账户已被禁用')}`);
    }
    const jwtToken = signToken({
      id: user.id, username: user.username, role: user.role, name: user.name, tenant_id: user.tenant_id,
    });
    // token 只放 fragment：不随请求发送到服务端，避免进日志
    const frag = new URLSearchParams({ token: jwtToken, next: rec.next });
    if (created) frag.set('created', '1');
    return res.redirect('/sso.html#' + frag.toString());
  } catch (e) {
    console.error('[SSO 回调失败]', e.message);
    return res.redirect(`/sso.html#error=${encodeURIComponent('单点登录失败，请重试或联系管理员')}`);
  }
});

module.exports = router;
module.exports.__resolveUser = resolveUser;
