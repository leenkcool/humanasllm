/**
 * 智能派单路由（技能匹配 + 负载均衡 + 历史质量）
 *  - GET  /api/dispatch/tasks/:id/suggest   派单建议（只读，不落库）
 *  - POST /api/dispatch/tasks/:id/assign    派单（admin；支持 dry_run）
 *  - GET  /api/dispatch/workload            工程师负载概览（admin）
 *
 * 不改变默认的人工 claim 语义：没有任何自动触发，只在显式接口调用时执行。
 */
const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const { assertTaskAccess } = require('../middleware/taskAccess');
const dispatch = require('../services/dispatchService');

const admin = [authenticate, requirePermission('dispatch.assign')];

/** 派单未启用时统一 403（便于一键关闭，不影响既有 claim） */
function requireEnabled(req, res, next) {
  if (!dispatch.enabled()) return res.status(403).json({ success: false, message: '智能派单未启用' });
  next();
}

// 派单建议（工程师也可查看，了解谁更适合）
router.get('/tasks/:id/suggest', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { error } = await assertTaskAccess(req, res, id);
    if (error) return error;
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 5));
    const r = await dispatch.suggest({ taskId: id, limit });
    if (!r.ok) return res.status(r.status || 400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.data });
  } catch (e) {
    console.error('[派单建议失败]', e.message);
    res.status(500).json({ success: false, message: '获取派单建议失败' });
  }
});

// 派单（admin）
router.post('/tasks/:id/assign', admin, requireEnabled, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { error } = await assertTaskAccess(req, res, id);
    if (error) return error;
    const r = await dispatch.assign({
      taskId: id,
      actor: { id: req.user.id, name: req.user.name || req.user.username },
      userId: req.body && req.body.user_id,
      dryRun: !!(req.body && (req.body.dry_run || req.body.dryRun)),
    });
    if (!r.ok) return res.status(r.status || 400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.data, dry_run: !!r.dry_run });
  } catch (e) {
    console.error('[派单失败]', e.message);
    res.status(500).json({ success: false, message: '派单失败' });
  }
});

// 工程师负载概览（admin）
router.get('/workload', admin, async (req, res) => {
  try {
    res.json({ success: true, data: await dispatch.workload({ tenantId: req.tenant_id }) });
  } catch (e) {
    console.error('[负载概览失败]', e.message);
    res.status(500).json({ success: false, message: '获取负载概览失败' });
  }
});

module.exports = router;
