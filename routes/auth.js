/**
 * 认证路由：登录 / 当前用户 / 改密码 / 登出
 */
const express = require('express');
const router = express.Router();
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

// 忘记密码：向注册邮箱发送新密码
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: '请输入注册邮箱' });
    const db = getDb();
    const list = rows(await db.exec('SELECT id, username, email FROM users WHERE email = ?', [email]));
    const user = list[0];
    if (!user) return res.status(404).json({ success: false, message: '该邮箱未注册' });

    const newPwd = 'pwd' + Math.random().toString(36).slice(2, 8) + 'A1';
    const hash = await bcrypt.hash(newPwd, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);

    const mail = await sendMail({
      to: email,
      subject: 'p390 人工代理网关 - 密码重置',
      text: `你的新密码：${newPwd}\n请登录后尽快在「个人资料」中修改密码。`,
    });
    res.json({
      success: true,
      message: mail.delivered ? '新密码已发送至你的邮箱' : '邮件服务未配置，密码已重置（见响应 demoPassword）',
      data: { delivered: mail.delivered, ...(mail.delivered ? {} : { demoPassword: newPwd }) },
    });
  } catch (err) {
    console.error('[重置密码失败]', err.message);
    res.status(500).json({ success: false, message: '重置密码失败' });
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
          id: user.id, username: user.username, role: user.role, name: user.name,
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
