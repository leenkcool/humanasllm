/**
 * 项目管理路由
 *  - GET/POST /api/projects        项目列表 / 管理员直接创建
 *  - PUT /:id POST /:id/archive    管理员更新 / 归档启用
 *  - POST /api/projects/apply      申请建项目（复用审批体系，管理员批准后自动建项目）
 */
const express = require('express');
const router = express.Router();
const project = require('../services/projectService');
const members = require('../services/projectMemberService');
const approval = require('../services/approvalService');
const { authenticate, requirePermission } = require('../middleware/auth');

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
router.post('/', authenticate, requirePermission('projects.manage'), async (req, res) => {
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
router.put('/:id', authenticate, requirePermission('projects.manage'), async (req, res) => {
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
router.post('/:id/archive', authenticate, requirePermission('projects.manage'), async (req, res) => {
  try {
    const p0 = await project.getProject(parseInt(req.params.id));
    if (!p0 || p0.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '项目不存在' });
    const p = await project.archiveProject(parseInt(req.params.id));
    res.json({ success: true, data: p });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// ===== 项目成员（项目级权限，知识库作用域依赖此判定） =====

/** 当前用户是否为该项目成员（admin 视为全部可访问） */
async function ensureProjectAccess(req, res, id) {
  const p = await project.getProject(parseInt(id));
  if (!p || p.tenant_id !== req.tenant_id) {
    res.status(404).json({ success: false, message: '项目不存在' });
    return null;
  }
  const ok = await members.isMember({
    projectCode: p.code, userId: req.user.id, role: req.user.role, tenantId: req.tenant_id,
  });
  if (!ok) {
    res.status(403).json({ success: false, message: '你不是该项目成员' });
    return null;
  }
  return p;
}

// 成员列表
router.get('/:id/members', authenticate, async (req, res) => {
  try {
    const p = await ensureProjectAccess(req, res, req.params.id);
    if (!p) return;
    res.json({ success: true, data: await members.listMembers(p.code, req.tenant_id) });
  } catch (e) {
    console.error('[成员列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取项目成员失败' });
  }
});

// 添加/更新成员（admin 或项目 owner）
router.post('/:id/members', authenticate, async (req, res) => {
  try {
    const p = await project.getProject(parseInt(req.params.id));
    if (!p || p.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '项目不存在' });
    const isAdmin = req.user.role === 'admin';
    const mine = (await members.listMembers(p.code, req.tenant_id))
      .find(m => m.user_id === req.user.id && m.role === 'owner');
    if (!isAdmin && !mine) return res.status(403).json({ success: false, message: '仅管理员或项目 owner 可管理成员' });
    const r = await members.addMember({
      projectCode: p.code, userId: parseInt(req.body.user_id),
      role: req.body.role || 'member', tenantId: req.tenant_id,
      actor: { id: req.user.id, name: req.user.name || req.user.username },
    });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[添加成员失败]', e.message);
    res.status(500).json({ success: false, message: '添加项目成员失败' });
  }
});

// 移除成员
router.delete('/:id/members/:userId', authenticate, async (req, res) => {
  try {
    const p = await project.getProject(parseInt(req.params.id));
    if (!p || p.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '项目不存在' });
    const isAdmin = req.user.role === 'admin';
    const mine = (await members.listMembers(p.code, req.tenant_id))
      .find(m => m.user_id === req.user.id && m.role === 'owner');
    // 允许成员移除自己
    const self = parseInt(req.params.userId) === req.user.id;
    if (!isAdmin && !mine && !self) return res.status(403).json({ success: false, message: '无权限移除该项目成员' });
    await members.removeMember({ projectCode: p.code, userId: parseInt(req.params.userId), tenantId: req.tenant_id });
    res.json({ success: true });
  } catch (e) {
    console.error('[移除成员失败]', e.message);
    res.status(500).json({ success: false, message: '移除项目成员失败' });
  }
});

module.exports = router;
