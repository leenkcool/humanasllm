/**
 * 工作台路由
 * 任务统计 / 我的任务 / 待接单任务
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');
const queue = require('../services/queueService');

// 工作台统计（各状态计数 + 待接单队列）
router.get('/summary', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const stats = { pending: 0, processing: 0, completed: 0, returned: 0, paused: 0, cancelled: 0 };
    const rows = queue.rows(await db.exec('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status'));
    for (const r of rows) {
      if (stats[r.status] !== undefined) stats[r.status] = parseInt(r.c) || 0;
    }
    const engineers = queue.rows(await db.exec(
      "SELECT id, username, name FROM users WHERE role = 'engineer' AND is_active = true ORDER BY id"
    ));
    res.json({ success: true, data: { stats, engineers } });
  } catch (err) {
    console.error('[统计失败]', err.message);
    res.status(500).json({ success: false, message: '获取统计失败' });
  }
});

// 我的任务（当前用户负责的处理中任务 + 历史）
router.get('/mine', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const list = queue.rows(await db.exec(
      `SELECT t.*, u.name AS assignee_name, p.name AS project_name
         FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
         LEFT JOIN projects p ON p.code = t.project_code
        WHERE t.assignee_id = ? ORDER BY t.id DESC LIMIT 100`,
      [req.user.id]
    ));
    res.json({ success: true, data: list });
  } catch (err) {
    console.error('[我的任务失败]', err.message);
    res.status(500).json({ success: false, message: '获取我的任务失败' });
  }
});

// 待接单任务（pending 队列，按优先级 + 时间排序）
router.get('/queue', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const list = queue.rows(await db.exec(
      `SELECT t.*, u.name AS assignee_name, p.name AS project_name
         FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
         LEFT JOIN projects p ON p.code = t.project_code
        WHERE t.status = 'pending'
        ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.created_at
        LIMIT 100`
    ));
    res.json({ success: true, data: list });
  } catch (err) {
    console.error('[待接单失败]', err.message);
    res.status(500).json({ success: false, message: '获取待接单任务失败' });
  }
});

module.exports = router;
