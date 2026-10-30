/**
 * 产出标注 + 私有评测集路由
 *  - GET  /api/annotations/candidates     待标注 / 已标注队列
 *  - GET  /api/annotations/stats          标注覆盖率与标签分布
 *  - GET  /api/annotations/eval-sets      评测集列表
 *  - POST /api/annotations/eval-sets      生成评测集快照（admin）
 *  - GET  /api/annotations/eval-sets/:id  评测集详情（含样本）
 *  - GET  /api/annotations/eval-sets/:id/export   导出 JSONL（sft / eval）
 *  - GET  /api/annotations/:taskId        某任务的标注
 *  - POST /api/annotations/:taskId        打标（admin 或该任务接单人）
 */
const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { assertTaskAccess } = require('../middleware/taskAccess');
const annotation = require('../services/annotationService');

const isAdmin = (req) => req.user && req.user.role === 'admin';

router.get('/candidates', authenticate, async (req, res) => {
  try {
    const r = await annotation.listCandidates({
      tenantId: req.tenant_id,
      filter: ['unannotated', 'annotated', 'all'].includes(req.query.filter) ? req.query.filter : 'unannotated',
      category: req.query.category,
      page: parseInt(req.query.page) || 1,
      size: parseInt(req.query.size) || 20,
    });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[待标注队列失败]', e.message);
    res.status(500).json({ success: false, message: '获取待标注队列失败' });
  }
});

router.get('/stats', authenticate, async (req, res) => {
  try {
    res.json({ success: true, data: await annotation.stats({ tenantId: req.tenant_id }) });
  } catch (e) {
    console.error('[标注统计失败]', e.message);
    res.status(500).json({ success: false, message: '获取标注统计失败' });
  }
});

router.get('/eval-sets', authenticate, async (req, res) => {
  try {
    res.json({ success: true, data: await annotation.listEvalSets({ tenantId: req.tenant_id }) });
  } catch (e) {
    console.error('[评测集列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取评测集列表失败' });
  }
});

router.post('/eval-sets', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const category = req.body.category || null;
    // 涉密 / 运维类快照留成数据集属敏感动作，仅 admin 可做（与导出同一门禁）
    const r = await annotation.createEvalSet({
      tenantId: req.tenant_id,
      actor: { id: req.user.id, name: req.user.name || req.user.username },
      name: req.body.name,
      category,
      labels: req.body.labels,
    });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.set });
  } catch (e) {
    console.error('[生成评测集失败]', e.message);
    res.status(500).json({ success: false, message: '生成评测集失败' });
  }
});

router.get('/eval-sets/:id', authenticate, async (req, res) => {
  try {
    const set = await annotation.getEvalSet({ id: parseInt(req.params.id), tenantId: req.tenant_id });
    if (!set) return res.status(404).json({ success: false, message: '评测集不存在' });
    res.json({ success: true, data: set });
  } catch (e) {
    console.error('[评测集详情失败]', e.message);
    res.status(500).json({ success: false, message: '获取评测集失败' });
  }
});

router.get('/eval-sets/:id/export', authenticate, async (req, res) => {
  try {
    const set = await annotation.getEvalSet({ id: parseInt(req.params.id), tenantId: req.tenant_id, withItems: false });
    if (!set) return res.status(404).json({ success: false, message: '评测集不存在' });
    // 涉密 / 运维 / 混合（category 为空即混合）评测集含敏感产出，仅 admin 可导出
    const sensitive = !set.category || set.category !== 'general';
    if (sensitive && !isAdmin(req)) {
      return res.status(403).json({ success: false, message: '涉密/运维类评测集仅管理员可导出' });
    }
    const r = await annotation.exportLines({
      id: set.id, tenantId: req.tenant_id,
      format: req.query.format === 'eval' ? 'eval' : 'sft',
    });
    if (!r.ok) return res.status(404).json({ success: false, message: r.message });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename=p390-${r.format}-${set.version}.jsonl`);
    res.send(r.lines.join('\n'));
  } catch (e) {
    console.error('[评测集导出失败]', e.message);
    res.status(500).json({ success: false, message: '导出评测集失败' });
  }
});

router.get('/:taskId', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.taskId);
    const { error, task } = await assertTaskAccess(req, res, id);
    if (error) return error;
    void task;
    res.json({ success: true, data: await annotation.getByTask(id) });
  } catch (e) {
    console.error('[标注查询失败]', e.message);
    res.status(500).json({ success: false, message: '获取标注失败' });
  }
});

router.post('/:taskId', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.taskId);
    const { error, task } = await assertTaskAccess(req, res, id);
    if (error) return error;
    // 标注是对「他人产出」的质量判定：仅 admin 或该任务接单人可打标
    if (!isAdmin(req) && task.assignee_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '仅管理员或该任务接单人可标注' });
    }
    const r = await annotation.annotate({
      taskId: id,
      actor: { id: req.user.id, name: req.user.name || req.user.username },
      label: req.body.label, tags: req.body.tags,
      note: req.body.note, expected: req.body.expected,
      tenantId: req.tenant_id,
    });
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r.annotation });
  } catch (e) {
    console.error('[标注失败]', e.message);
    res.status(500).json({ success: false, message: '标注失败' });
  }
});

module.exports = router;
