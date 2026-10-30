/**
 * 答复审核路由
 *  - GET  /api/reviews/pending      待审核队列
 *  - GET  /api/reviews/spot-check   待抽检队列（confidential 已放行）
 *  - GET  /api/reviews/stats        审核统计
 *  - GET  /api/reviews/:taskId      某任务的审核记录
 *  - POST /api/reviews/:taskId/approve       审核通过（带四维评分）
 *  - POST /api/reviews/:taskId/revision      退回修改
 *  - POST /api/reviews/:taskId/resubmit      工程师重新提交
 *  - POST /api/reviews/:taskId/spot-check    admin 抽检
 */
const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { assertTaskAccess } = require('../middleware/taskAccess');
const review = require('../services/reviewService');

router.get('/pending', authenticate, async (req, res) => {
  try {
    const r = await review.listPending({
      tenantId: req.tenant_id,
      page: Math.max(1, parseInt(req.query.page) || 1),
      size: Math.min(100, Math.max(1, parseInt(req.query.size) || 20)),
    });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[待审核队列失败]', e.message);
    res.status(500).json({ success: false, message: '获取待审核队列失败' });
  }
});

router.get('/spot-check', authenticate, requireRole('admin'), async (req, res) => {
  try {
    res.json({ success: true, data: await review.listSpotCheck({ tenantId: req.tenant_id }) });
  } catch (e) {
    console.error('[待抽检队列失败]', e.message);
    res.status(500).json({ success: false, message: '获取待抽检队列失败' });
  }
});

router.get('/stats', authenticate, async (req, res) => {
  try {
    res.json({ success: true, data: await review.stats({ tenantId: req.tenant_id }) });
  } catch (e) {
    console.error('[审核统计失败]', e.message);
    res.status(500).json({ success: false, message: '获取审核统计失败' });
  }
});

router.get('/:taskId', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.taskId);
    const { error } = await assertTaskAccess(req, res, id);
    if (error) return error;
    res.json({ success: true, data: await review.getByTask(id) });
  } catch (e) {
    console.error('[审核记录查询失败]', e.message);
    res.status(500).json({ success: false, message: '获取审核记录失败' });
  }
});

router.post('/:taskId/approve', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.taskId);
    const { error } = await assertTaskAccess(req, res, id);
    if (error) return error;
    const r = await review.approve({
      taskId: id, actor: { id: req.user.id, name: req.user.name || req.user.username },
      scores: req.body.scores || {}, note: req.body.note, tenantId: req.tenant_id,
    });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[审核通过失败]', e.message);
    res.status(500).json({ success: false, message: '审核通过失败' });
  }
});

router.post('/:taskId/revision', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.taskId);
    const { error } = await assertTaskAccess(req, res, id);
    if (error) return error;
    const r = await review.requestRevision({
      taskId: id, actor: { id: req.user.id, name: req.user.name || req.user.username },
      reason: req.body.reason, tenantId: req.tenant_id,
    });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[退回修改失败]', e.message);
    res.status(500).json({ success: false, message: '退回修改失败' });
  }
});

router.post('/:taskId/resubmit', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.taskId);
    const { error, task } = await assertTaskAccess(req, res, id, { ownerOnly: true });
    if (error) return error;
    void task;
    const r = await review.resubmit({ taskId: id });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[重新提交失败]', e.message);
    res.status(500).json({ success: false, message: '重新提交失败' });
  }
});

router.post('/:taskId/spot-check', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.taskId);
    const { error } = await assertTaskAccess(req, res, id);
    if (error) return error;
    const r = await review.spotCheck({
      taskId: id, actor: { id: req.user.id, name: req.user.name || req.user.username },
      pass: !!req.body.pass, note: req.body.note,
    });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[抽检失败]', e.message);
    res.status(500).json({ success: false, message: '抽检失败' });
  }
});

module.exports = router;
