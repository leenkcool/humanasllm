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
    const rows = queue.rows(await db.exec('SELECT status, COUNT(*) AS c FROM tasks WHERE tenant_id = ? GROUP BY status', [req.tenant_id]));
    for (const r of rows) {
      if (stats[r.status] !== undefined) stats[r.status] = parseInt(r.c) || 0;
    }
    const engineers = queue.rows(await db.exec(
      "SELECT id, username, name FROM users WHERE role = 'engineer' AND is_active = true AND tenant_id = ? ORDER BY id",
      [req.tenant_id]
    ));
    // 未完成聚合：所有尚未结束的人肉任务（防遗忘，人工为小时级节奏）
    stats.unfinished = (stats.pending || 0) + (stats.processing || 0) + (stats.returned || 0) + (stats.paused || 0);
    // 一次通过率（质量治理）：completed 中未被 reopen 打回的比例
    const qa = queue.rows(await db.exec(
      `SELECT (SELECT COUNT(*) FROM tasks WHERE status = 'completed' AND tenant_id = ?) AS completed,
              (SELECT COUNT(*) FROM task_logs l JOIN tasks t ON l.task_id = t.id WHERE l.action = 'reopen' AND t.tenant_id = ?) AS reopened`,
      [req.tenant_id, req.tenant_id]
    ));
    const q = qa[0] || {};
    const completed = parseInt(q.completed) || 0;
    const reopened = parseInt(q.reopened) || 0;
    stats.qa = {
      completed,
      reopened,
      rate: completed > 0 ? Math.max(0, Math.round((1 - reopened / completed) * 1000) / 10) : null,
    };
    res.json({ success: true, data: { stats, engineers } });
  } catch (err) {
    console.error('[统计失败]', err.message);
    res.status(500).json({ success: false, message: '获取统计失败' });
  }
});

// 治理概览（阶段二：可度量——分级分布 / 一次通过率 / 审批时效 / 超时率）
router.get('/governance', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const cats = queue.rows(await db.exec('SELECT category, COUNT(*) AS c FROM tasks WHERE tenant_id = ? GROUP BY category', [req.tenant_id]));
    const categories = (cats || []).map(r => ({ category: r.category, count: parseInt(r.c) || 0 }));
    const qa = queue.rows(await db.exec(
      `SELECT (SELECT COUNT(*) FROM tasks WHERE status = 'completed' AND tenant_id = ?) AS completed,
              (SELECT COUNT(*) FROM task_logs l JOIN tasks t ON l.task_id = t.id WHERE l.action = 'reopen' AND t.tenant_id = ?) AS reopened`,
      [req.tenant_id, req.tenant_id]
    ))[0] || {};
    const completed = parseInt(qa.completed) || 0;
    const reopened = parseInt(qa.reopened) || 0;
    const appr = queue.rows(await db.exec(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE decided_at IS NOT NULL) AS decided,
              AVG(EXTRACT(EPOCH FROM (decided_at - created_at)) / 60) AS avg_min
         FROM approvals`
    ))[0] || {};
    const tz = queue.rows(await db.exec(
      `SELECT (SELECT COUNT(*) FROM tasks WHERE tenant_id = ?) AS total,
              (SELECT COUNT(*) FROM task_logs l JOIN tasks t ON l.task_id = t.id WHERE l.remark LIKE '%超时%' AND t.tenant_id = ?) AS timeout`,
      [req.tenant_id, req.tenant_id]
    ))[0] || {};
    const total = parseInt(tz.total) || 0;
    const timeoutCount = parseInt(tz.timeout) || 0;
    // 工程师治理：per-engineer 一次通过率 + 技能标签
    const engineers = queue.rows(await db.exec(
      `SELECT u.id, u.username, u.name, u.skills,
              COUNT(DISTINCT t.id) AS total,
              COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'completed') AS completed,
              COUNT(DISTINCT t.id) FILTER (WHERE EXISTS (SELECT 1 FROM task_logs l WHERE l.task_id = t.id AND l.action = 'reopen')) AS reopened
         FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id
        WHERE u.role = 'engineer' AND u.tenant_id = ? AND (t.tenant_id IS NULL OR t.tenant_id = ?)
        GROUP BY u.id, u.username, u.name, u.skills
        ORDER BY completed DESC`,
      [req.tenant_id, req.tenant_id]
    ));
    const engineerStats = (engineers || []).map(e => {
      const c = parseInt(e.completed) || 0;
      const r = parseInt(e.reopened) || 0;
      return {
        id: e.id, name: e.name || e.username, username: e.username, skills: e.skills || null,
        total: parseInt(e.total) || 0, completed: c, reopened: r,
        rate: c > 0 ? Math.max(0, Math.round((1 - r / c) * 1000) / 10) : null,
      };
    });
    res.json({ success: true, data: {
      categories,
      qa: { completed, reopened, rate: completed > 0 ? Math.max(0, Math.round((1 - reopened / completed) * 1000) / 10) : null },
      approval: { total: parseInt(appr.total) || 0, decided: parseInt(appr.decided) || 0, avg_min: appr.avg_min != null ? Math.round(parseFloat(appr.avg_min) * 10) / 10 : null },
      timeout: { count: timeoutCount, rate: total > 0 ? Math.round((timeoutCount / total) * 1000) / 10 : 0 },
      total_tasks: total,
      engineers: engineerStats,
    } });
  } catch (err) {
    console.error('[治理概览失败]', err.message);
    res.status(500).json({ success: false, message: '获取治理概览失败' });
  }
});

// 未完成任务聚合（待接单/处理中/驳回可重派/暂停 → 长期可见，防遗忘）
router.get('/unfinished', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const list = queue.rows(await db.exec(
      `SELECT t.*, u.name AS assignee_name, p.name AS project_name
         FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
         LEFT JOIN projects p ON p.code = t.project_code
        WHERE t.status IN ('pending','processing','returned','paused') AND t.tenant_id = ?
        ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'returned' THEN 2 ELSE 3 END,
                 CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.created_at
        LIMIT 100`,
      [req.tenant_id]
    ));
    res.json({ success: true, data: list });
  } catch (err) {
    console.error('[未完成聚合失败]', err.message);
    res.status(500).json({ success: false, message: '获取未完成列表失败' });
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
        WHERE t.assignee_id = ? AND t.tenant_id = ? ORDER BY t.id DESC LIMIT 100`,
      [req.user.id, req.tenant_id]
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
        WHERE t.status = 'pending' AND t.tenant_id = ?
        ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.created_at
        LIMIT 100`,
      [req.tenant_id]
    ));
    res.json({ success: true, data: list });
  } catch (err) {
    console.error('[待接单失败]', err.message);
    res.status(500).json({ success: false, message: '获取待接单任务失败' });
  }
});

module.exports = router;
