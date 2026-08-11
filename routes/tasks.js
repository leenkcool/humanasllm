/**
 * 人工任务路由
 * 列表 / 详情 / 状态流转（接单、完成、驳回、暂停、恢复、重派、取消）
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');
const queue = require('../services/queueService');
const project = require('../services/projectService');
const { toCSV } = require('../services/csv');

const VALID_STATUS = ['pending', 'processing', 'completed', 'returned', 'paused', 'cancelled'];

// 导出任务 CSV（utf-8 BOM，Excel 兼容）
router.get('/export', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const list = queue.rows(await db.exec(
      `SELECT t.id, t.upstream_request_id, t.model, t.priority, t.category, t.project_code, t.status,
              u.name AS assignee_name, t.result_text, t.reject_reason, t.created_at, t.completed_at
         FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
        WHERE t.tenant_id = ? ORDER BY t.id`,
      [req.tenant_id]
    ));
    const cols = ['id', 'upstream_request_id', 'model', 'priority', 'category', 'project_code', 'status', 'assignee_name', 'result_text', 'reject_reason', 'created_at', 'completed_at'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=tasks.csv');
    res.send('﻿' + toCSV(list, cols));
  } catch (e) {
    console.error('[导出失败]', e.message);
    res.status(500).json({ success: false, message: '导出失败' });
  }
});

// 列表（状态/优先级/指派人筛选）
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 20));
    const offset = (page - 1) * size;
    const where = [];
    const params = [];
    if (VALID_STATUS.includes(req.query.status)) { where.push('t.status = ?'); params.push(req.query.status); }
    if (['high', 'medium', 'low'].includes(req.query.priority)) { where.push('t.priority = ?'); params.push(req.query.priority); }
    if (req.query.assignee) { where.push('t.assignee_id = ?'); params.push(parseInt(req.query.assignee)); }
    where.push('t.tenant_id = ?'); params.push(req.tenant_id);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const count = await db.exec(`SELECT COUNT(*) as c FROM tasks t ${whereSql}`, params);
    const total = count[0].values[0][0];
    const list = queue.rows(await db.exec(
      `SELECT t.*, u.name AS assignee_name, p.name AS project_name
         FROM tasks t
         LEFT JOIN users u ON t.assignee_id = u.id
         LEFT JOIN projects p ON p.code = t.project_code
         ${whereSql} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    ));
    res.json({ success: true, data: { data: list, total, page, size } });
  } catch (err) {
    console.error('[任务列表失败]', err.message);
    res.status(500).json({ success: false, message: '获取任务列表失败' });
  }
});

// 详情
router.get('/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const task = await queue.getTask(id);
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });
    if (task.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '任务不存在' });
    const db = getDb();
    let ruleName = null;
    if (task.rule_id) {
      const rn = await db.exec('SELECT name FROM task_rules WHERE id = ?', [task.rule_id]);
      if (rn[0] && rn[0].values[0]) ruleName = rn[0].values[0][0];
    }
    const logs = queue.rows(await db.exec(
      'SELECT * FROM task_logs WHERE task_id = ? ORDER BY id', [id]
    ));
    res.json({ success: true, data: { ...task, rule_name: ruleName, logs } });
  } catch (err) {
    console.error('[任务详情失败]', err.message);
    res.status(500).json({ success: false, message: '获取任务详情失败' });
  }
});

// 接单：pending/returned → processing
router.post('/:id/claim', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await queue.claimTask(id, req.user.id, req.user.name || req.user.username);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.task });
  } catch (err) {
    console.error('[接单失败]', err.message);
    res.status(500).json({ success: false, message: '接单失败' });
  }
});

// 提交结果：processing → completed
router.post('/:id/complete', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const content = (req.body.content || '').toString();
    if (!content.trim()) return res.status(400).json({ success: false, message: '提交内容不能为空' });
    const r = await queue.completeTask(id, content, { id: req.user.id, name: req.user.name || req.user.username }, { completion_note: req.body.completion_note });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.task });
  } catch (err) {
    console.error('[提交失败]', err.message);
    res.status(500).json({ success: false, message: '提交失败' });
  }
});

// 驳回重写：processing → returned
router.post('/:id/reject', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const reason = (req.body.reason || '').toString();
    if (!reason.trim()) return res.status(400).json({ success: false, message: '请填写驳回原因' });
    const r = await queue.rejectTask(id, reason, { id: req.user.id, name: req.user.name || req.user.username });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.task });
  } catch (err) {
    console.error('[驳回失败]', err.message);
    res.status(500).json({ success: false, message: '驳回失败' });
  }
});

// 暂停
router.post('/:id/pause', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const reason = (req.body.reason || '').toString();
    const r = await queue.pauseTask(id, reason || null, { id: req.user.id, name: req.user.name || req.user.username });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.task });
  } catch (err) {
    console.error('[暂停失败]', err.message);
    res.status(500).json({ success: false, message: '暂停失败' });
  }
});

// 恢复
router.post('/:id/resume', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await queue.resumeTask(id, { id: req.user.id, name: req.user.name || req.user.username });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.task });
  } catch (err) {
    console.error('[恢复失败]', err.message);
    res.status(500).json({ success: false, message: '恢复失败' });
  }
});

// 二次修改上下文后重新派发：returned/paused → pending
router.post('/:id/requeue', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await queue.requeueTask(id, req.body.request_payload || null, { id: req.user.id, name: req.user.name || req.user.username });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.task });
  } catch (err) {
    console.error('[重派失败]', err.message);
    res.status(500).json({ success: false, message: '重新派发失败' });
  }
});

// 取消
router.post('/:id/cancel', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const r = await queue.cancelTask(id, { id: req.user.id, name: req.user.name || req.user.username });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.task });
  } catch (err) {
    console.error('[取消失败]', err.message);
    res.status(500).json({ success: false, message: '取消失败' });
  }
});

// 打回重做：completed → returned（产出不合格/乱答，管理员或原处理人可打回）
router.post('/:id/reopen', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const task = await queue.getTask(id);
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });
    const isAdmin = req.user.role === 'admin';
    const isOwner = task.assignee_id === req.user.id;
    if (!isAdmin && !isOwner) return res.status(403).json({ success: false, message: '无权限打回该任务' });
    const reason = (req.body.reason || '').toString().trim();
    if (!reason) return res.status(400).json({ success: false, message: '请填写打回原因' });
    const r = await queue.reopenTask(id, reason, { id: req.user.id, name: req.user.name || req.user.username });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.task });
  } catch (err) {
    console.error('[打回失败]', err.message);
    res.status(500).json({ success: false, message: '打回失败' });
  }
});

// 设置任务归属项目（接单后把单子归到项目；project_code 为空则清除归属）
router.post('/:id/project', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const code = (req.body.project_code || '').toString().trim();
    const task = await queue.getTask(id);
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });
    if (code) {
      const p = await project.getProjectByCode(code);
      if (!p) return res.status(400).json({ success: false, message: '项目不存在' });
    }
    await getDb().run('UPDATE tasks SET project_code = ? WHERE id = ?', [code || null, id]);
    res.json({ success: true, data: await queue.getTask(id) });
  } catch (err) {
    console.error('[任务归属项目失败]', err.message);
    res.status(500).json({ success: false, message: '设置归属项目失败' });
  }
});

module.exports = router;
