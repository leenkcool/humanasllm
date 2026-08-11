/**
 * 日志路由
 * 请求日志（request_logs）：上游入参 + 人工输出
 * 任务审计日志（task_logs）：状态流转留痕
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');
const queue = require('../services/queueService');

// 请求出入日志（in/out）
router.get('/requests', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 20));
    const offset = (page - 1) * size;
    const where = [];
    const params = [];
    if (req.query.task_id) { where.push('task_id = ?'); params.push(parseInt(req.query.task_id)); }
    if (['in', 'out'].includes(req.query.direction)) { where.push('direction = ?'); params.push(req.query.direction); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const count = await db.exec(`SELECT COUNT(*) AS c FROM request_logs ${whereSql}`, params);
    const total = count[0].values[0][0];
    const list = queue.rows(await db.exec(
      `SELECT r.*, t.model AS task_model
         FROM request_logs r LEFT JOIN tasks t ON r.task_id = t.id
         ${whereSql} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    ));
    res.json({ success: true, data: { data: list, total, page, size } });
  } catch (err) {
    console.error('[请求日志失败]', err.message);
    res.status(500).json({ success: false, message: '获取请求日志失败' });
  }
});

// 任务审计日志（状态流转）
router.get('/tasks', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 20));
    const offset = (page - 1) * size;
    const where = [];
    const params = [];
    if (req.query.task_id) { where.push('task_id = ?'); params.push(parseInt(req.query.task_id)); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const count = await db.exec(`SELECT COUNT(*) AS c FROM task_logs ${whereSql}`, params);
    const total = count[0].values[0][0];
    const list = queue.rows(await db.exec(
      `SELECT * FROM task_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    ));
    res.json({ success: true, data: { data: list, total, page, size } });
  } catch (err) {
    console.error('[任务日志失败]', err.message);
    res.status(500).json({ success: false, message: '获取任务日志失败' });
  }
});

// 审计哈希链验证 + 治理链路（分级/rule_id/完整性）
router.get('/tasks/:id/audit', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = getDb();
    const task = await queue.getTask(id);
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });
    const chain = await queue.verifyAuditChain(id);
    res.json({ success: true, data: {
      valid: chain.valid,
      broken_at: chain.broken_at,
      log_count: chain.count,
      category: task.category || 'general',
      rule_id: task.rule_id || null,
      task: { id: task.id, status: task.status, created_at: task.created_at, completed_at: task.completed_at },
    } });
  } catch (err) {
    console.error('[审计验证失败]', err.message);
    res.status(500).json({ success: false, message: '审计验证失败' });
  }
});

module.exports = router;
