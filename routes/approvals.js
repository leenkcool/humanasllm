/**
 * 审批路由
 *  - POST /v1/approvals       AI 发起审批（挂起等待人类批准/驳回，返回结果）
 *  - GET/POST /api/approvals*  工作台审批列表 / 详情 / 批准 / 驳回
 */
const express = require('express');
const router = express.Router();
const approval = require('../services/approvalService');
const project = require('../services/projectService');
const { authenticate } = require('../middleware/auth');
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

// ===== OpenAI 兼容：AI 发起审批请求（挂起等待人类审批） =====
router.post('/approvals', requireUpstreamKey, async (req, res) => {
  try {
    const { resource, amount, purpose, detail, requester, project_code, meta_tags } = req.body || {};
    if (!resource) return res.status(400).json(encoder.makeError(400, 'resource 不能为空'));

    const created = await approval.createApproval({
      resource, amount, purpose, detail, requester, project_code, meta_tags,
    });

    const waitMs = parseInt(process.env.TASK_WAIT_MS) || 5 * 60 * 1000;
    const result = await approval.waitForApproval(created.id, waitMs);

    if (result.timedOut || !result.approval) {
      const a = await approval.getApproval(created.id);
      return res.json({ ...toResult(a), status: a.status, message: result.message || '审批等待超时' });
    }
    res.json(toResult(result.approval));
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
    const r = await approval.listApprovals({ status: req.query.status, page, size });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[审批列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取审批列表失败' });
  }
});

// 审批详情
router.get('/:id', authenticate, async (req, res) => {
  try {
    const a = await approval.getApproval(parseInt(req.params.id));
    if (!a) return res.status(404).json({ success: false, message: '审批单不存在' });
    res.json({ success: true, data: a });
  } catch (e) {
    console.error('[审批详情失败]', e.message);
    res.status(500).json({ success: false, message: '获取审批详情失败' });
  }
});

// 批准 + 提供资源
router.post('/:id/approve', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
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
