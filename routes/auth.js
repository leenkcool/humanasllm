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

    const token = signToken({ id: user.id, username: user.username, role: user.role, name: user.name });
    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, username: user.username, role: user.role, name: user.name },
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
