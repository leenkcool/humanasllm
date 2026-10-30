/**
 * 审计 / 合规报告路由
 *  - GET /api/audit/report   数据不出网关合规证明（分级保护 / AI 兜底核查 / 审计链健康 / 审批统计）
 *                            ?format=html → 自包含报告页（浏览器打印为 PDF）；缺省 json（向后兼容）
 *  - GET /api/audit/dataset  质量数据资产导出（JSONL）
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');
const queue = require('../services/queueService');
const report = require('../services/reportService');

// 合规报告：数据不出网关证明（治理层「留痕是人的证据」的对外证据）
// 全部指标按租户过滤（原先全表聚合属跨租户越权，已修复）
router.get('/report', authenticate, async (req, res) => {
  try {
    const data = await report.collectReportData({ tenantId: req.tenant_id });
    if (req.query.format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(report.renderHtml(data, { lang: req.query.lang === 'en' ? 'en' : 'zh' }));
    }
    res.json({ success: true, data });
  } catch (e) {
    console.error('[合规报告失败]', e.message);
    res.status(500).json({ success: false, message: '生成合规报告失败' });
  }
});

// 质量数据资产导出（阶段三）：completed 人工产出 → JSONL 评测集
// 合规：默认 general 类（涉密/运维数据不出网关）；confidential/ops 需显式指定 + admin
router.get('/dataset', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const category = req.query.category || 'general';
    if (!['general', 'confidential', 'ops'].includes(category)) {
      return res.status(400).json({ success: false, message: 'category 非法' });
    }
    if (category !== 'general' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: '涉密/运维数据仅管理员可导出' });
    }
    const tasks = queue.rows(await db.exec(
      `SELECT id, category, rule_id, request_payload, result_text, result_payload, completed_at
         FROM tasks WHERE status = 'completed' AND tenant_id = ? AND category = ? ORDER BY id`,
      [req.tenant_id, category]));
    const lines = tasks.map(t => {
      const msgs = (t.request_payload && t.request_payload.messages) || [];
      const prompt = msgs.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const rp = t.result_payload;
      return JSON.stringify({
        task_id: t.id, category: t.category, rule_id: t.rule_id || null,
        prompt, completion: t.result_text || '',
        completion_note: (rp && rp.completion_note) || null,
        completed_at: t.completed_at,
      });
    });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=p390-dataset-${category}.jsonl`);
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('[数据资产导出失败]', e.message);
    res.status(500).json({ success: false, message: '导出数据资产失败' });
  }
});

module.exports = router;
