/**
 * 认证路由：登录 / 当前用户 / 改密码 / 登出
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { authenticate, signToken } = require('../middleware/auth');
const { createLoginLimiter } = require('../middleware/security');
const { rows } = require('../services/queueService');
const { sendMail } = require('../services/mailer');

// 注册（open 模式注册即用；audit 模式待管理员审核启用，.env 的 USER_REGISTER_MODE 控制）
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, name } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: '用户名、邮箱、密码不能为空' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: '邮箱格式不正确' });
    }
    const db = getDb();
    const dup = rows(await db.exec('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]));
    if (dup[0]) return res.status(400).json({ success: false, message: '用户名或邮箱已存在' });

    const hash = await bcrypt.hash(password, 10);
    const mode = process.env.USER_REGISTER_MODE || 'open';
    const isActive = mode !== 'audit';
    // 注册归默认租户（多租户 v1；企业版租户归属由管理员分配）
    const defTenant = rows(await db.exec('SELECT id FROM tenants WHERE code = ?', ['default']))[0];
    const tenantId = defTenant ? defTenant.id : null;
    const { lastId } = await db.run(
      'INSERT INTO users (username, email, password, role, name, is_active, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [username, email, hash, 'engineer', name || username, isActive, tenantId]
    );

    if (!isActive) {
      return res.json({ success: true, data: { id: lastId, active: false, message: '注册成功，待管理员审核启用' } });
    }
    const token = signToken({ id: lastId, username, role: 'engineer', name: name || username, tenant_id: tenantId });
    res.json({ success: true, data: { token, user: { id: lastId, username, email, role: 'engineer', name: name || username, tenant_id: tenantId } } });
  } catch (err) {
    console.error('[注册失败]', err.message);
    res.status(500).json({ success: false, message: '注册失败' });
  }
});

// 忘记密码：生成一次性重置 token 并发送重置链接（SMTP 未配置时链接写入服务端日志，绝不回显凭据）
router.post('/forgot-password', createLoginLimiter(), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: '请输入注册邮箱' });
    const db = getDb();
    const list = rows(await db.exec('SELECT id, username, email FROM users WHERE email = ?', [email]));
    const user = list[0];
    if (!user) return res.status(404).json({ success: false, message: '该邮箱未注册' });

    // 一次性 token（30 分钟有效），仅用于换取重置表单，不直接携带凭据
    const token = crypto.randomBytes(32).toString('hex');
    await db.run(
      `UPDATE users SET reset_token = ?, reset_expires = NOW() + interval '30 minutes' WHERE id = ?`,
      [token, user.id]
    );

    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const link = `${base}/forgot-reset.html?token=${token}`;
    const text = `你好 ${user.username}，\n\n请点击以下链接重置密码（30 分钟内有效，仅可使用一次）：\n${link}\n\n如非本人操作请忽略本邮件。`;
    const mail = await sendMail({ to: email, subject: 'p390 人工代理网关 - 重置密码', text });

    // SMTP 未配置/失败：重置链接写入服务端日志（管理员可见），响应绝不回显 token
    if (!mail.delivered) {
      console.log(`[密码重置] SMTP 未配置，重置链接（30 分钟有效，仅管理员可查日志获取）:\n${link}`);
      return res.json({ success: true, message: '邮件服务未配置，重置链接已写入服务端日志，请联系管理员获取' });
    }
    res.json({ success: true, message: '重置链接已发送至你的邮箱' });
  } catch (err) {
    console.error('[重置密码失败]', err.message);
    res.status(500).json({ success: false, message: '重置密码失败' });
  }
});

// 通过一次性 token 重置密码（forgot-reset.html 调用）
router.post('/reset-password', createLoginLimiter(), async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ success: false, message: '缺少 token 或新密码' });
    if (String(newPassword).length < 6) return res.status(400).json({ success: false, message: '新密码至少 6 位' });
    const db = getDb();
    const list = rows(await db.exec(
      'SELECT id FROM users WHERE reset_token = ? AND reset_expires > NOW()',
      [token]
    ));
    const user = list[0];
    if (!user) return res.status(400).json({ success: false, message: '重置链接无效或已过期' });

    const hash = await bcrypt.hash(newPassword, 10);
    // 一次性：重置后清空 token，防止重复使用
    await db.run(
      'UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?',
      [hash, user.id]
    );
    res.json({ success: true, message: '密码重置成功，请用新密码登录' });
  } catch (err) {
    console.error('[密码重置失败]', err.message);
    res.status(500).json({ success: false, message: '密码重置失败' });
  }
});

// 登录
router.post('/login', createLoginLimiter(), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    }
    const db = getDb();
    const list = rows(await db.exec('SELECT * FROM users WHERE username = ?', [username]));
    const user = list[0];
    if (!user) return res.status(401).json({ success: false, message: '用户名或密码错误' });
    if (!user.is_active) return res.status(403).json({ success: false, message: '账户已被禁用' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, message: '用户名或密码错误' });

    const tenant = user.tenant_id
      ? rows(await db.exec('SELECT name FROM tenants WHERE id = ?', [user.tenant_id]))[0]
      : null;
    const token = signToken({ id: user.id, username: user.username, role: user.role, name: user.name, tenant_id: user.tenant_id });
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id, username: user.username, role: user.role, name: user.name, skills: user.skills || null,
          tenant_id: user.tenant_id, tenant_name: tenant ? tenant.name : null,
        },
      },
    });
  } catch (err) {
    console.error('[登录失败]', err.message);
    res.status(500).json({ success: false, message: '登录失败' });
  }
});

// 当前用户信息
router.get('/me', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const list = rows(
      await db.exec('SELECT id, username, role, name, is_active, created_at FROM users WHERE id = ?', [req.user.id])
    );
    if (!list[0]) return res.status(404).json({ success: false, message: '用户不存在' });
    res.json({ success: true, data: list[0] });
  } catch (err) {
    console.error('[获取用户失败]', err.message);
    res.status(500).json({ success: false, message: '获取用户失败' });
  }
});

// 修改密码
router.put('/password', authenticate, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: '旧密码和新密码不能为空' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: '新密码至少 6 位' });
    }
    const db = getDb();
    const list = rows(await db.exec('SELECT password FROM users WHERE id = ?', [req.user.id]));
    if (!list[0]) return res.status(404).json({ success: false, message: '用户不存在' });
    const valid = await bcrypt.compare(oldPassword, list[0].password);
    if (!valid) return res.status(400).json({ success: false, message: '旧密码不正确' });

    const hash = await bcrypt.hash(newPassword, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id]);
    res.json({ success: true, message: '密码修改成功' });
  } catch (err) {
    console.error('[改密失败]', err.message);
    res.status(500).json({ success: false, message: '修改密码失败' });
  }
});

// 登出
router.post('/logout', (req, res) => {
  res.json({ success: true, message: '已登出' });
});

module.exports = router;
