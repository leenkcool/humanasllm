/**
 * 知识库路由
 *  - GET    /api/knowledge              列表（作用域/分级/关键词筛选，按可见性过滤）
 *  - GET    /api/knowledge/:id          详情
 *  - POST   /api/knowledge              新建
 *  - PUT    /api/knowledge/:id          更新（作者或 admin）
 *  - DELETE /api/knowledge/:id          删除（作者或 admin）
 *  - GET    /api/knowledge/similar?task_id=  相似历史答复（答复任务时侧栏用）
 *  - GET    /api/knowledge/from-task/:taskId 完成任务的沉淀草稿（预填）
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const knowledge = require('../services/knowledgeService');
const queue = require('../services/queueService');

// 相似检索（放在 /:id 之前，避免被 :id 吞掉）
router.get('/similar', authenticate, async (req, res) => {
  try {
    let text = req.query.text || '';
    if (!text && req.query.task_id) {
      const task = await queue.getTask(parseInt(req.query.task_id));
      if (!task || task.tenant_id !== req.tenant_id) {
        return res.status(404).json({ success: false, message: '任务不存在' });
      }
      const msgs = (task.request_payload && task.request_payload.messages) || [];
      text = msgs.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n');
    }
    const data = await knowledge.similar({
      text, user: req.user, tenantId: req.tenant_id,
      limit: Math.min(20, Math.max(1, parseInt(req.query.limit) || 5)),
    });
    res.json({ success: true, data });
  } catch (e) {
    console.error('[相似知识检索失败]', e.message);
    res.status(500).json({ success: false, message: '检索相似答复失败' });
  }
});

// 完成任务的一键沉淀草稿
router.get('/from-task/:taskId', authenticate, async (req, res) => {
  try {
    const task = await queue.getTask(parseInt(req.params.taskId));
    if (!task || task.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, message: '任务不存在' });
    }
    if (task.status !== 'completed') {
      return res.status(400).json({ success: false, message: '仅已完成任务可沉淀为知识条目' });
    }
    res.json({ success: true, data: knowledge.draftFromTask(task) });
  } catch (e) {
    console.error('[沉淀草稿失败]', e.message);
    res.status(500).json({ success: false, message: '生成沉淀草稿失败' });
  }
});

// 列表
router.get('/', authenticate, async (req, res) => {
  try {
    const r = await knowledge.list({
      user: req.user, tenantId: req.tenant_id,
      scope: req.query.scope, category: req.query.category, keyword: req.query.keyword,
      page: Math.max(1, parseInt(req.query.page) || 1),
      size: Math.min(100, Math.max(1, parseInt(req.query.size) || 20)),
    });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[知识库列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取知识库失败' });
  }
});

// 详情
router.get('/:id', authenticate, async (req, res) => {
  try {
    const r = await knowledge.get({ id: parseInt(req.params.id), user: req.user, tenantId: req.tenant_id });
    if (!r) return res.status(404).json({ success: false, message: '知识条目不存在或无权访问' });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[知识详情失败]', e.message);
    res.status(500).json({ success: false, message: '获取知识详情失败' });
  }
});

// 新建
router.post('/', authenticate, async (req, res) => {
  try {
    const r = await knowledge.create(req.body || {}, req.user, req.tenant_id);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[新建知识失败]', e.message);
    res.status(500).json({ success: false, message: '新建知识条目失败' });
  }
});

// 更新
router.put('/:id', authenticate, async (req, res) => {
  try {
    const r = await knowledge.update(parseInt(req.params.id), req.body || {}, req.user, req.tenant_id);
    if (!r.ok) return res.status(r.message.includes('无权') ? 403 : 400).json({ success: false, message: r.message });
    res.json({ success: true, data: r });
  } catch (e) {
    console.error('[更新知识失败]', e.message);
    res.status(500).json({ success: false, message: '更新知识条目失败' });
  }
});

// 删除
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const r = await knowledge.remove(parseInt(req.params.id), req.user, req.tenant_id);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true });
  } catch (e) {
    console.error('[删除知识失败]', e.message);
    res.status(500).json({ success: false, message: '删除知识条目失败' });
  }
});

module.exports = router;
