/**
 * 审批路由
 *  - POST /v1/approvals       AI 发起审批（挂起等待人类批准/驳回，返回结果）
 *  - GET/POST /api/approvals*  工作台审批列表 / 详情 / 批准 / 驳回
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const approval = require('../services/approvalService');
const project = require('../services/projectService');
const { authenticate } = require('../middleware/auth');
const { getTenantByUpstreamKey } = require('../middleware/auth');
const encoder = require('../services/openaiEncoder');
const { toCSV } = require('../services/csv');

// 上游 API-Key 校验（同 /v1/chat/completions）
function requireUpstreamKey(req, res, next) {
  const key = process.env.UPSTREAM_API_KEY;
  if (!key) return next();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.api_key || '');
  if (token !== key) return res.status(401).json(encoder.makeError(401, 'Invalid API key provided.'));
  next();
}

/** 双认证：上游 API-Key 或工作台 JWT（/v1/approvals/:id 回查 + /api/approvals/:id 详情） */
function authAny(req, res, next) {
  const key = process.env.UPSTREAM_API_KEY;
  const auth = req.headers.authorization || '';
  if (key && (auth.startsWith('Bearer ') && auth.slice(7) === key || req.query.api_key === key)) return next();
  authenticate(req, res, next);
}

/** 审批单 → 返回给 AI 的结果结构 */
function toResult(a) {
  return {
    id: a.approval_no,
    object: 'approval',
    resource: a.resource,
    amount: a.amount,
    purpose: a.purpose,
    requester: a.requester,
    status: a.status,
    provided: a.provided || null,
    reject_reason: a.reject_reason || null,
    decided_at: a.decided_at || null,
  };
}

// ===== OpenAI 兼容：AI 发起审批请求（异步受理 → 凭 approval_no 回查） =====
router.post('/approvals', requireUpstreamKey, async (req, res) => {
  try {
    const { resource, amount, purpose, detail, requester, project_code, meta_tags } = req.body || {};
    if (!resource) return res.status(400).json(encoder.makeError(400, 'resource 不能为空'));

    // 上游 /v1 无 JWT：API key 路由租户，无则默认租户
    const auth = req.headers.authorization || '';
    const upKey = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.api_key || '');
    let tenantId = await getTenantByUpstreamKey(upKey);
    if (!tenantId) {
      const defTenant = (await getDb().exec('SELECT id FROM tenants WHERE code = ?', ['default']))[0];
      tenantId = defTenant && defTenant.values[0] ? defTenant.values[0][0] : null;
    }
    const created = await approval.createApproval({
      resource, amount, purpose, detail, requester, project_code, meta_tags, tenant_id: tenantId,
    });
    const a = await approval.getApproval(created.id);
    // 异步受理：AI 提审批立即返回 approval_no，人类批准/驳回后凭 GET /v1/approvals/:id 回查
    res.json({ ...toResult(a), message: '审批已受理，可通过 GET /v1/approvals/' + a.approval_no + ' 查询结果' });
  } catch (e) {
    console.error('[审批发起失败]', e.message);
    res.status(500).json(encoder.makeError(500, '审批发起失败: ' + e.message, 'server_error'));
  }
});

// ===== 工作台 =====

// 导出审批 CSV（utf-8 BOM，Excel 兼容）
router.get('/export', authenticate, async (req, res) => {
  try {
    const { data } = await approval.listApprovals({ status: req.query.status });
    const cols = ['id', 'approval_no', 'type', 'resource', 'amount', 'purpose', 'requester', 'project_code', 'status', 'provider_name', 'provided', 'reject_reason', 'created_at', 'decided_at'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=approvals.csv');
    res.send('﻿' + toCSV(data, cols));
  } catch (e) {
    console.error('[导出失败]', e.message);
    res.status(500).json({ success: false, message: '导出失败' });
  }
});

// 审批列表
router.get('/', authenticate, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 20));
    const r = await approval.listApprovals({ status: req.query.status, page, size, tenantId: req.tenant_id });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[审批列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取审批列表失败' });
  }
});

/** 按 db id 或 approval_no 查审批单 */
async function getApprovalHandler(req, res) {
  try {
    const idStr = req.params.id;
    let a = /^\d+$/.test(idStr) ? await approval.getApproval(parseInt(idStr)) : null;
    if (!a) a = await approval.getApprovalByNo(idStr);
    if (!a) return res.status(404).json({ success: false, message: '审批单不存在' });
    if (req.tenant_id && a.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '审批单不存在' });
    res.json({ success: true, data: a });
  } catch (e) {
    console.error('[审批详情失败]', e.message);
    res.status(500).json({ success: false, message: '获取审批详情失败' });
  }
}

// 工作台详情：GET /api/approvals/:id（JWT）
router.get('/:id', authenticate, getApprovalHandler);
// 上游回查：GET /v1/approvals/:id（双认证，凭 approval_no 或 db id）
router.get('/approvals/:id', authAny, getApprovalHandler);

// 批准 + 提供资源
router.post('/:id/approve', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const a0 = await approval.getApproval(id);
    if (!a0 || a0.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '审批单不存在' });
    const provided = (req.body.provided || '').toString();
    const r = await approval.approve(id, provided, { id: req.user.id, name: req.user.name || req.user.username });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    // 项目创建申请批准后自动建项目
    if (r.approval.type === 'project' && r.approval.status === 'approved') {
      try {
        const created = await project.createFromApproval(r.approval);
        r.approval.project = created;
      } catch (e) {
        console.error('[批准建项目失败]', e.message);
        r.approval.project_error = e.message;
      }
    }
    res.json({ success: true, data: r.approval });
  } catch (e) {
    console.error('[批准失败]', e.message);
    res.status(500).json({ success: false, message: '批准失败' });
  }
});

// 驳回
router.post('/:id/reject', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const a0 = await approval.getApproval(id);
    if (!a0 || a0.tenant_id !== req.tenant_id) return res.status(404).json({ success: false, message: '审批单不存在' });
    const reason = (req.body.reason || '').toString().trim();
    if (!reason) return res.status(400).json({ success: false, message: '请填写驳回原因' });
    const r = await approval.reject(id, reason, { id: req.user.id, name: req.user.name || req.user.username });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.approval });
  } catch (e) {
    console.error('[驳回失败]', e.message);
    res.status(500).json({ success: false, message: '驳回失败' });
  }
});

module.exports = router;
