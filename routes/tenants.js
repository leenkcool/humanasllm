/**
 * 租户管理路由（多租户 v1）
 *  - GET  /api/tenants   列表（admin 全部；engineer 自己的租户）
 *  - POST /api/tenants   新建租户（admin）
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { rows } = require('../services/queueService');

// 列表
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    if (req.user.role === 'admin') {
      const list = rows(await db.exec('SELECT id, code, name, created_at FROM tenants ORDER BY id', []));
      return res.json({ success: true, data: list });
    }
    const list = rows(await db.exec('SELECT id, code, name, created_at FROM tenants WHERE id = ? ORDER BY id', [req.tenant_id]));
    res.json({ success: true, data: list });
  } catch (e) {
    console.error('[租户列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取租户失败' });
  }
});

// 新建租户（admin）
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { code, name } = req.body || {};
    if (!code || !name) return res.status(400).json({ success: false, message: 'code 与 name 必填' });
    const db = getDb();
    const dup = rows(await db.exec('SELECT id FROM tenants WHERE code = ?', [code]));
    if (dup[0]) return res.status(400).json({ success: false, message: '租户 code 已存在' });
    const { lastId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [code, name]);
    res.json({ success: true, data: { id: lastId } });
  } catch (e) {
    console.error('[创建租户失败]', e.message);
    res.status(500).json({ success: false, message: '创建租户失败' });
  }
});

module.exports = router;
