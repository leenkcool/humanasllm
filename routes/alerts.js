/**
 * 告警中心路由（超时升级序列的可视化处理面）
 *  - GET  /api/alerts               告警列表（默认为 active，支持 level/kind/task_id/分页）
 *  - GET  /api/alerts/stats         告警统计（按状态 / 级别 / 类型 / 最早未处理时间）
 *  - POST /api/alerts/:id/ack       确认告警（admin 或该任务处理人）
 *  - POST /api/alerts/:id/resolve   解决告警（admin）
 *
 * 租户隔离：全部查询按 req.tenant_id；跨租户一律 404（不泄露存在性）。
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const alerts = require('../services/alertService');

const VALID_STATUS = ['active', 'acked', 'resolved', 'all'];

function isAdmin(req) {
  return req.user && req.user.role === 'admin';
}

// 列表（注意：/stats 必须先于 /:id 注册，避免被参数路由吞掉）
router.get('/', authenticate, async (req, res) => {
  try {
    const status = VALID_STATUS.includes(req.query.status) ? req.query.status : 'active';
    const data = await alerts.listAlerts({
      tenantId: req.tenant_id,
      status,
      level: req.query.level,
      kind: req.query.kind,
      taskId: req.query.task_id,
      page: req.query.page,
      size: req.query.size,
    });
    res.json({ success: true, data });
  } catch (e) {
    console.error('[告警列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取告警列表失败' });
  }
});

// 统计
router.get('/stats', authenticate, async (req, res) => {
  try {
    res.json({ success: true, data: await alerts.alertStats({ tenantId: req.tenant_id }) });
  } catch (e) {
    console.error('[告警统计失败]', e.message);
    res.status(500).json({ success: false, message: '获取告警统计失败' });
  }
});

// 确认（admin 或该任务处理人）
router.post('/:id/ack', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '告警 id 非法' });
    const alert = await alerts.getAlert(id, req.tenant_id);
    if (!alert) return res.status(404).json({ success: false, message: '告警不存在' });
    // 权限：管理员，或该告警所属任务的接单人本人
    const isAssignee = !!(alert.task_assignee_id && alert.task_assignee_id === req.user.id);
    if (!isAdmin(req) && !isAssignee) {
      return res.status(403).json({ success: false, message: '无权限确认该告警' });
    }
    if (alert.status !== 'active') {
      return res.status(400).json({ success: false, message: `告警当前状态为 ${alert.status}，无需确认` });
    }
    const ok = await alerts.ackAlert(id, req.user, req.tenant_id);
    if (!ok) return res.status(409).json({ success: false, message: '告警状态已变更，请刷新后重试' });
    res.json({ success: true });
  } catch (e) {
    console.error('[确认告警失败]', e.message);
    res.status(500).json({ success: false, message: '确认告警失败' });
  }
});

// 解决（admin）
router.post('/:id/resolve', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '告警 id 非法' });
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: '仅管理员可解决告警' });
    const alert = await alerts.getAlert(id, req.tenant_id);
    if (!alert) return res.status(404).json({ success: false, message: '告警不存在' });
    const ok = await alerts.resolveAlert(id, req.user, req.tenant_id);
    if (!ok) return res.status(409).json({ success: false, message: '告警已解决，无需重复操作' });
    res.json({ success: true });
  } catch (e) {
    console.error('[解决告警失败]', e.message);
    res.status(500).json({ success: false, message: '解决告警失败' });
  }
});

module.exports = router;
