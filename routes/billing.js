/**
 * 计费计量路由（人力成本可核算 + 租户账单）
 *  - GET    /api/billing/overview          工作台概览（当月）
 *  - GET    /api/billing/statement         租户账单（按分级/项目/工程师/来源汇总）
 *  - GET    /api/billing/ledger            计费明细（分页）
 *  - GET    /api/billing/export            CSV 导出（utf-8 BOM）
 *  - GET    /api/billing/rates             费率列表（全局 + 本租户）
 *  - POST   /api/billing/rates             admin：新建/覆盖费率
 *  - DELETE /api/billing/rates/:id         admin：删除（仅本租户）
 *  - POST   /api/billing/settle            admin：手工触发批量补结算
 *
 * 租户隔离：所有查询按 req.tenant_id；全局费率（tenant_id IS NULL）只读可见。
 */
const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const billing = require('../services/billingService');
const { toCSV } = require('../services/csv');

const admin = [authenticate, requireRole('admin')];

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 期间参数校验：非法 / 缺省回退当月 */
function periodOf(v) {
  return PERIOD_RE.test(String(v || '')) ? String(v) : billing.periodOf(new Date());
}

// 概览：当月总额 / 任务数 / 日均费用 / 人工时价均值 / 分级分布 / 项目 Top5
router.get('/overview', authenticate, async (req, res) => {
  try {
    const data = await billing.overview({ tenantId: req.tenant_id });
    res.json({ success: true, data });
  } catch (e) {
    console.error('[计费概览失败]', e.message);
    res.status(500).json({ success: false, message: '获取计费概览失败' });
  }
});

// 租户账单
router.get('/statement', authenticate, async (req, res) => {
  try {
    const data = await billing.tenantStatement({ tenantId: req.tenant_id, period: periodOf(req.query.period) });
    res.json({ success: true, data });
  } catch (e) {
    console.error('[计费账单失败]', e.message);
    res.status(500).json({ success: false, message: '获取账单失败' });
  }
});

// 计费明细（分页）
router.get('/ledger', authenticate, async (req, res) => {
  try {
    const data = await billing.listLedger({
      tenantId: req.tenant_id,
      period: periodOf(req.query.period),
      page: req.query.page,
      size: req.query.size,
    });
    res.json({ success: true, data });
  } catch (e) {
    console.error('[计费明细失败]', e.message);
    res.status(500).json({ success: false, message: '获取计费明细失败' });
  }
});

// CSV 导出（utf-8 BOM，Excel 兼容）
router.get('/export', authenticate, async (req, res) => {
  try {
    const period = periodOf(req.query.period);
    // 分页拉取（单页上限 500），最多导出 10000 条，避免一次性吃满内存
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const r = await billing.listLedger({ tenantId: req.tenant_id, period, page, size: 500 });
      all.push(...r.data);
      if (all.length >= r.total || !r.data.length) break;
    }
    const list = all.map(r => ({
      task_id: r.task_id,
      period: r.period,
      category: r.category,
      priority: r.priority,
      project_code: r.project_code || '',
      assignee_name: r.assignee_name || r.assignee_username || '',
      billable_minutes: r.billable_minutes,
      unit_price_yuan: r.unit_price_yuan,
      amount_yuan: r.amount_yuan,
      source: r.source,
      created_at: r.created_at,
    }));
    const cols = ['task_id', 'period', 'category', 'priority', 'project_code', 'assignee_name',
      'billable_minutes', 'unit_price_yuan', 'amount_yuan', 'source', 'created_at'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=billing-${period}.csv`);
    res.send('﻿' + toCSV(list, cols));
  } catch (e) {
    console.error('[计费导出失败]', e.message);
    res.status(500).json({ success: false, message: '导出失败' });
  }
});

// 费率列表（全局 + 本租户）
router.get('/rates', authenticate, async (req, res) => {
  try {
    const list = await billing.listRates({ tenantId: req.tenant_id });
    res.json({ success: true, data: list });
  } catch (e) {
    console.error('[费率列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取费率失败' });
  }
});

// 新建 / 覆盖费率（admin）
router.post('/rates', admin, async (req, res) => {
  try {
    const body = req.body || {};
    // 租户隔离：只允许写本租户或全局（tenant_id=null）；不允许替别的租户写
    const tenantId = body.tenant_id === null || body.tenant_id === undefined
      ? (body.global === true && req.user.role === 'admin' ? null : req.tenant_id)
      : parseInt(body.tenant_id, 10);
    if (tenantId !== null && tenantId !== req.tenant_id) {
      return res.status(403).json({ success: false, message: '不能修改其他租户的费率' });
    }
    const r = await billing.upsertRate({ ...body, tenant_id: tenantId });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[保存费率失败]', e.message);
    res.status(500).json({ success: false, message: '保存费率失败' });
  }
});

// 删除费率（admin，仅本租户；全局不可删）
router.delete('/rates/:id', admin, async (req, res) => {
  try {
    const r = await billing.deleteRate(req.params.id, req.tenant_id);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true });
  } catch (e) {
    console.error('[删除费率失败]', e.message);
    res.status(500).json({ success: false, message: '删除费率失败' });
  }
});

// 手工触发批量补结算（admin）
router.post('/settle', admin, async (req, res) => {
  try {
    const limit = parseInt((req.body || {}).limit, 10) || 200;
    const r = await billing.settlePendingTasks({ limit });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[计费补结算失败]', e.message);
    res.status(500).json({ success: false, message: '补结算失败' });
  }
});

module.exports = router;
