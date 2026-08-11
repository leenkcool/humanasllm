/**
 * 用户管理路由（工程师账户）
 * 管理员可增删改；工程师仅可查看用户列表
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { rows } = require('../services/queueService');

// 列表（可筛选角色）
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const role = req.query.role;
    const sql = role
      ? 'SELECT id, username, email, role, name, skills, is_active, created_at FROM users WHERE role = ? ORDER BY id'
      : 'SELECT id, username, email, role, name, skills, is_active, created_at FROM users ORDER BY id';
    const list = rows(await db.exec(sql, role ? [role] : []));
    res.json({ success: true, data: list });
  } catch (err) {
    console.error('[用户列表失败]', err.message);
    res.status(500).json({ success: false, message: '获取用户列表失败' });
  }
});

// 新增
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { username, password, role, name } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    const r = role || 'engineer';
    if (!['engineer', 'admin'].includes(r)) return res.status(400).json({ success: false, message: '非法角色' });
    const db = getDb();
    const exists = rows(await db.exec('SELECT id FROM users WHERE username = ?', [username]));
    if (exists[0]) return res.status(400).json({ success: false, message: '用户名已存在' });

    const hash = await bcrypt.hash(password, 10);
    const { lastId } = await db.run(
      'INSERT INTO users (username, password, role, name, is_active) VALUES (?, ?, ?, ?, true)',
      [username, hash, r, name || username]
    );
    res.json({ success: true, data: { id: lastId } });
  } catch (err) {
    console.error('[创建用户失败]', err.message);
    res.status(500).json({ success: false, message: '创建用户失败' });
  }
});

// 更新（角色/姓名/启停/重置密码）
router.put('/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const list = rows(await db.exec('SELECT id FROM users WHERE id = ?', [id]));
    if (!list[0]) return res.status(404).json({ success: false, message: '用户不存在' });

    const { role, name, is_active, password, skills } = req.body;
    const sets = [];
    const params = [];
    if (role !== undefined) {
      if (!['engineer', 'admin'].includes(role)) return res.status(400).json({ success: false, message: '非法角色' });
      sets.push('role = ?'); params.push(role);
    }
    if (name !== undefined) { sets.push('name = ?'); params.push(name); }
    if (skills !== undefined) { sets.push('skills = ?'); params.push(String(skills)); }
    if (is_active !== undefined) { sets.push('is_active = ?'); params.push(is_active ? true : false); }
    if (password) { sets.push('password = ?'); params.push(await bcrypt.hash(password, 10)); }
    if (sets.length === 0) return res.status(400).json({ success: false, message: '没有可更新的字段' });
    params.push(id);
    await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, message: '用户已更新' });
  } catch (err) {
    console.error('[更新用户失败]', err.message);
    res.status(500).json({ success: false, message: '更新用户失败' });
  }
});

// 删除
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    if (id === req.user.id) return res.status(400).json({ success: false, message: '不能删除自己' });
    const list = rows(await db.exec('SELECT id FROM users WHERE id = ?', [id]));
    if (!list[0]) return res.status(404).json({ success: false, message: '用户不存在' });
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: '用户已删除' });
  } catch (err) {
    console.error('[删除用户失败]', err.message);
    res.status(500).json({ success: false, message: '删除用户失败' });
  }
});

module.exports = router;
