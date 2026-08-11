/**
 * 审计 / 合规报告路由
 *  - GET /api/audit/report   数据不出网关合规证明（分级保护 / AI 兜底核查 / 审计链健康 / 审批统计）
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticate } = require('../middleware/auth');
const queue = require('../services/queueService');

// 合规报告：数据不出网关证明（治理层「留痕是人的证据」的对外证据）
router.get('/report', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const tasks = queue.rows(await db.exec(
      'SELECT id, category, rule_id, status, result_payload, created_at, completed_at FROM tasks', []));
    const protectedConf = tasks.filter(t => t.category === 'confidential').length;
    const protectedOps = tasks.filter(t => t.category === 'ops').length;
    // AI 兜底核查：general 类兜底是设计允许（降级），受保护任务（confidential/ops）被兜底才是违规
    const aiRelayTasks = tasks.filter(t => {
      const rp = t.result_payload;
      return !!(rp && rp.source === 'ai-relay');
    });
    const aiFallback = aiRelayTasks.length;
    const protectedAi = aiRelayTasks.filter(t => t.category !== 'general').length;

    // 审计链健康（哈希链完整性）
    let validChains = 0, invalidChains = 0;
    for (const t of tasks) {
      const v = await queue.verifyAuditChain(t.id);
      if (v.valid) validChains++; else invalidChains++;
    }

    const appr = queue.rows(await db.exec(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'approved') AS approved,
              COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
         FROM approvals`
    ))[0] || {};

    res.json({ success: true, data: {
      generated_at: new Date().toISOString(),
      total_tasks: tasks.length,
      protected: { confidential: protectedConf, ops: protectedOps, total: protectedConf + protectedOps },
      ai_fallback: { total: aiFallback, general: aiFallback - protectedAi, protected: protectedAi },
      compliance: protectedAi === 0
        ? 'PASS：受保护任务（涉密/运维）无 AI 兜底，数据未出网关'
        : `FAIL：${protectedAi} 个受保护任务被 AI 兜底，涉密/运维数据可能出网关，需核查`,
      audit_chains: { valid: validChains, invalid: invalidChains },
      approvals: {
        total: parseInt(appr.total) || 0,
        approved: parseInt(appr.approved) || 0,
        rejected: parseInt(appr.rejected) || 0,
      },
    } });
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
