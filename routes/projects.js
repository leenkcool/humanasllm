/**
 * 项目管理路由
 *  - GET/POST /api/projects        项目列表 / 管理员直接创建
 *  - PUT /:id POST /:id/archive    管理员更新 / 归档启用
 *  - POST /api/projects/apply      申请建项目（复用审批体系，管理员批准后自动建项目）
 */
const express = require('express');
const router = express.Router();
const project = require('../services/projectService');
const approval = require('../services/approvalService');
const { authenticate, requireRole } = require('../middleware/auth');

// 项目列表
router.get('/', authenticate, async (req, res) => {
  try {
    const list = await project.listProjects({ status: req.query.status, tenantId: req.tenant_id });
    res.json({ success: true, data: list });
  } catch (e) {
    console.error('[项目列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取项目列表失败' });
  }
});

// 管理员直接创建项目
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const p = await project.createProject({
      code: req.body.code, name: req.body.name, description: req.body.description, createdBy: req.user.id, tenantId: req.tenant_id,
    });
    res.json({ success: true, data: p });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// 申请建项目（走审批）
router.post('/apply', authenticate, async (req, res) => {
  try {
    const { code, name, description } = req.body;
    if (!code || !name) return res.status(400).json({ success: false, message: '项目编码和名称不能为空' });
    const exists = await project.getProjectByCode(code);
    if (exists && exists.tenant_id === req.tenant_id) return res.status(400).json({ success: false, message: '项目编码已存在' });

    const created = await approval.createApproval({
      type: 'project',
      resource: `项目创建申请：${code}`,
      purpose: name,
      detail: JSON.stringify({ code, name, desc: description || null }),
      requester: req.user.username || String(req.user.id),
      project_code: code,
      tenant_id: req.tenant_id,
    });
    res.json({ success: true, data: created, message: '申请已提交，待管理员审批' });
  } catch (e) {
    console.error('[项目申请失败]', e.message);
    res.status(500).json({ success: false, message: '申请失败' });
  }
});

// 管理员更新项目
router.put('/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const p0 = await project.getProject(parseInt(req.params.id));
    if (!p0 || p0.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '项目不存在' });
    const p = await project.updateProject(parseInt(req.params.id), { name: req.body.name, description: req.body.description });
    res.json({ success: true, data: p });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// 管理员归档 / 启用
router.post('/:id/archive', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const p0 = await project.getProject(parseInt(req.params.id));
    if (!p0 || p0.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '项目不存在' });
    const p = await project.archiveProject(parseInt(req.params.id));
    res.json({ success: true, data: p });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

module.exports = router;
