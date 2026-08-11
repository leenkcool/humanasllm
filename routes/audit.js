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
    const aiFallback = tasks.filter(t => {
      const rp = t.result_payload;
      return !!(rp && rp.source === 'ai-relay');
    }).length;

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
      ai_fallback_used: aiFallback,
      compliance: aiFallback === 0
        ? 'PASS：无任务被 AI 兜底，涉密/运维数据未出网关'
        : `FAIL：${aiFallback} 个任务走 AI 兜底，需核查是否含涉密/运维内容`,
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

module.exports = router;
