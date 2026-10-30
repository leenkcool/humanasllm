/**
 * 工单模板路由（工作台可视化维护 + 一键建单）
 *  - GET    /api/templates        列表（当前租户可见：全局 + 租户专属）
 *  - POST   /api/templates        新建（admin）
 *  - PUT    /api/templates/:id    更新（admin）
 *  - DELETE /api/templates/:id    软删（admin，置 enabled=false）
 *  - POST   /api/templates/:id/apply  用模板建一条任务（不经 /v1）
 */
const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const tpl = require('../services/templateService');
const queue = require('../services/queueService');
const encoder = require('../services/openaiEncoder');

const admin = [authenticate, requireRole('admin')];

// 列表
router.get('/', authenticate, async (req, res) => {
  try {
    const includeDisabled = req.query.include_disabled === '1' && req.user.role === 'admin';
    const list = await tpl.listTemplates({ tenantId: req.tenant_id, includeDisabled });
    res.json({ success: true, data: list });
  } catch (e) {
    console.error('[模板列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取模板失败' });
  }
});

// 详情
router.get('/:id', authenticate, async (req, res) => {
  try {
    const t = await tpl.getTemplate(parseInt(req.params.id));
    if (!tpl.templateVisible(t, req.tenant_id)) return res.status(404).json({ success: false, message: '模板不存在' });
    res.json({ success: true, data: t });
  } catch (e) {
    console.error('[模板详情失败]', e.message);
    res.status(500).json({ success: false, message: '获取模板失败' });
  }
});

// 新建（tenant_id 缺省=全局模板，由管理员创建；租户专属可显式指定）
router.post('/', admin, async (req, res) => {
  try {
    const tenantId = req.body.tenant_id !== undefined ? req.body.tenant_id : req.tenant_id;
    const r = await tpl.createTemplate(req.body || {}, req.user, tenantId);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: { id: r.id } });
  } catch (e) {
    console.error('[新建模板失败]', e.message);
    res.status(500).json({ success: false, message: '新建模板失败' });
  }
});

// 更新
router.put('/:id', admin, async (req, res) => {
  try {
    const t = await tpl.getTemplate(parseInt(req.params.id));
    if (!tpl.templateVisible(t, req.tenant_id)) return res.status(404).json({ success: false, message: '模板不存在' });
    const r = await tpl.updateTemplate(t.id, req.body || {});
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, data: { id: t.id } });
  } catch (e) {
    console.error('[更新模板失败]', e.message);
    res.status(500).json({ success: false, message: '更新模板失败' });
  }
});

// 软删
router.delete('/:id', admin, async (req, res) => {
  try {
    const t = await tpl.getTemplate(parseInt(req.params.id));
    if (!tpl.templateVisible(t, req.tenant_id)) return res.status(404).json({ success: false, message: '模板不存在' });
    await tpl.deleteTemplate(t.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[删除模板失败]', e.message);
    res.status(500).json({ success: false, message: '删除模板失败' });
  }
});

// 一键建单：工作台直接用模板建任务（工程师也可用，行为等同人工录入需求）
router.post('/:id/apply', authenticate, async (req, res) => {
  try {
    const t = await tpl.getTemplate(parseInt(req.params.id));
    if (!tpl.templateVisible(t, req.tenant_id) || !t.enabled) {
      return res.status(404).json({ success: false, message: '模板不存在或已停用' });
    }
    const overrides = (req.body && req.body.overrides) || {};
    const tplPayload = (t.payload_template && typeof t.payload_template === 'object') ? t.payload_template : {};
    // messages 必填：调用方给的非空则优先，否则回退模板预置，最后由 mergeIntoParsed 补 system_prompt
    const messages = (Array.isArray(overrides.messages) && overrides.messages.length)
      ? overrides.messages
      : (Array.isArray(tplPayload.messages) ? tplPayload.messages : []);
    if (!messages.length) {
      return res.status(400).json({ success: false, message: '模板缺少 messages，且未提供 overrides.messages' });
    }
    const parsed = encoder.parseChatRequest({
      model: process.env.HUMAN_LLM_MODEL || 'human-llm',
      messages,
      priority: overrides.priority,
      skills: overrides.skills,
      project_code: overrides.project_code,
      meta_tags: overrides.meta_tags,
      category: overrides.category,
      tools: overrides.tools || tplPayload.tools,
    });
    const merged = tpl.mergeIntoParsed(t, parsed);
    const created = await queue.createTaskFromRequest({
      parsed: merged,
      chatId: 'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      created: Math.floor(Date.now() / 1000),
      tenantId: req.tenant_id,
      templateId: t.id,
      origin: `模板建单：#${t.id} ${t.name}`,
    });
    await tpl.bumpUseCount(t.id);
    res.json({ success: true, data: { task_id: created.taskId, template_id: t.id } });
  } catch (e) {
    console.error('[模板建单失败]', e.message);
    res.status(500).json({ success: false, message: '模板建单失败' });
  }
});

module.exports = router;
