/**
 * OpenAI 兼容接口（/v1）
 * GET  /v1/models
 * POST /v1/chat/completions   （支持 stream 与一次性返回）
 *
 * 上游 Agent / 调度池新增一条模型路由指向此处即可，无需改动代码。
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const encoder = require('../services/openaiEncoder');
const queue = require('../services/queueService');
const aiRelay = require('../services/aiRelay');
const aiShift = require('../services/aiShift');
const { getTenantByUpstreamKey } = require('../middleware/auth');

// 可选：上游 API-Key 校验（配置 UPSTREAM_API_KEY 后生效）
function requireUpstreamKey(req, res, next) {
  const key = process.env.UPSTREAM_API_KEY;
  if (!key) return next();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.api_key || '');
  if (token !== key) {
    return res.status(401).json(encoder.makeError(401, 'Invalid API key provided.'));
  }
  next();
}

// GET /v1/models
router.get('/models', requireUpstreamKey, (req, res) => {
  const ids = [encoder.MODEL, ...aiRelay.getModels()];
  res.json({
    object: 'list',
    data: ids.map(id => ({
      id,
      object: 'model',
      owned_by: id === encoder.MODEL ? 'p390' : 'ai-relay',
      permission: [],
    })),
  });
});

// POST /v1/chat/completions
router.post('/chat/completions', requireUpstreamKey, async (req, res) => {
  let parsed;
  try {
    parsed = encoder.parseChatRequest(req.body);
  } catch (e) {
    return res.status(e.status || 400).json(encoder.makeError(e.status || 400, e.message));
  }

  // ===== AI 降级路由：模型名匹配 → 中继到真实 LLM（DeepSeek） =====
  if (aiRelay.shouldRelay(parsed.model)) {
    await queue.logRequest(null, 'in', req.body, parsed.model).catch(() => {});
    try {
      if (parsed.stream) {
        await queue.logRequest(null, 'out', { relay: parsed.model }, parsed.model).catch(() => {});
        return await aiRelay.relayStream(req, res);
      }
      const data = await aiRelay.chat(req.body);
      await queue.logRequest(null, 'out',
        { content: data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content },
        parsed.model).catch(() => {});
      return res.json(data);
    } catch (e) {
      console.error('[AI 中继失败]', e.message);
      return res.status(502).json(encoder.makeError(502, 'AI 中继失败: ' + e.message, 'server_error'));
    }
  }

  // ===== 智能漂移：general 简单任务由 AI 直接承接（AI_SHIFT_ENABLED=true 时；confidential/ops 锁死不漂移） =====
  if (await aiShift.shouldShift({ messages: parsed.messages, body: parsed.extra })) {
    await queue.logRequest(null, 'in', req.body, parsed.model);
    try {
      const data = await aiRelay.chat({ ...req.body, stream: false });
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      await queue.logRequest(null, 'out', { content, source: 'ai-shift' }, parsed.model);
      return res.json(data);
    } catch (e) {
      console.error('[AI 漂移失败，回落人工]', e.message);
    }
  }

  const chatId = encoder.makeId();
  const created = Math.floor(Date.now() / 1000);

  // 接入 → 创建人工任务（pending）→ 推送工作台（上游 API key 路由租户）
  let taskId;
  try {
    const auth = req.headers.authorization || '';
    const upKey = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.api_key || '');
    const upstreamTenant = await getTenantByUpstreamKey(upKey);
    const createdRes = await queue.createTaskFromRequest({ parsed, chatId, created, tenantId: upstreamTenant });
    taskId = createdRes.taskId;
  } catch (e) {
    console.error('[创建任务失败]', e.message);
    return res.status(500).json(encoder.makeError(500, '任务创建失败', 'server_error'));
  }
  await queue.logRequest(taskId, 'in', req.body, parsed.model);

  // 异步受理：人工接单为小时级，/v1 不阻塞等待（分钟级挂起与人工节奏不匹配）
  // 创建任务后立即返回 task_id，上游凭 GET /v1/tasks/:id 轮询取回人工处理结果
  const content = `任务已受理，task_id=${taskId}，待人工处理；可通过 GET /v1/tasks/${taskId} 查询结果`;

  if (parsed.stream) {
    // SSE 兼容：受理信息按流式块输出，上游按标准 SSE 解析正常结束
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    for (const line of encoder.makeStreamChunks({ id: chatId, model: parsed.model, created, content })) {
      res.write(line);
    }
    res.end();
    return;
  }

  // 一次性返回：OpenAI 结构 + task_id（上游可轮询取结果）
  const accepted = encoder.makeChatCompletion({ id: chatId, model: parsed.model, created, content });
  accepted.task_id = taskId;
  accepted.status = 'pending';
  res.json(accepted);
});

// GET /v1/governance/rules — 治理 API：上游可查分级规则（当前租户可见：全局 + 租户专属）
router.get('/governance/rules', requireUpstreamKey, async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const upKey = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.api_key || '');
    const tenant = await getTenantByUpstreamKey(upKey);
    const r = await getDb().exec(
      'SELECT id, name, category, match_field, keywords, priority FROM task_rules WHERE enabled = true AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY (tenant_id = ?) DESC, priority ASC, id ASC',
      [tenant || null, tenant || null]);
    const rules = r[0] ? r[0].values.map(row => { const o = {}; r[0].columns.forEach((c, i) => { o[c] = row[i]; }); return o; }) : [];
    res.json({ object: 'list', data: rules });
  } catch (e) {
    console.error('[治理规则查询失败]', e.message);
    res.status(500).json(encoder.makeError(500, '查询分级规则失败', 'server_error'));
  }
});

// GET /v1/tasks/:id — 上游凭 task_id 查询人工任务处理结果（异步受理后回查）
router.get('/tasks/:id', requireUpstreamKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const task = await queue.getTask(id);
    if (!task) return res.status(404).json(encoder.makeError(404, 'Task not found', 'invalid_request_error'));
    // 多租户隔离（越权/枚举防护）：调用方 key 路由到的租户与任务租户不一致则拒绝。
    // 无 key 或默认租户 key 可读默认租户任务（演示模式），跨租户一律 404 不泄露存在性。
    const auth = req.headers.authorization || '';
    const upKey = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.api_key || '');
    const callerTenant = await getTenantByUpstreamKey(upKey);
    const taskTenant = task.tenant_id || null;
    if (callerTenant && taskTenant && callerTenant !== taskTenant) {
      return res.status(404).json(encoder.makeError(404, 'Task not found', 'invalid_request_error'));
    }
    let content = '任务处理中，请稍后查询';
    if (task.status === 'completed') content = task.result_text || '';
    else if (task.status === 'returned') content = `任务被驳回: ${task.reject_reason || '未填写原因'}`;
    // 治理决策（阶段三：上游可查分级理由/质量验收/审计健康）
    const ruleRow = task.rule_id
      ? (await getDb().exec('SELECT name FROM task_rules WHERE id = ?', [task.rule_id]))[0]
      : null;
    const ruleName = ruleRow && ruleRow.values[0] ? ruleRow.values[0][0] : null;
    const rp = task.result_payload;
    const audit = await queue.verifyAuditChain(task.id);
    res.json({
      task_id: task.id,
      status: task.status,
      content,
      model: task.model,
      category: task.category || 'general',
      rule_id: task.rule_id || null,
      rule_name: ruleName,
      category_source: task.rule_id ? 'rule' : 'manual',
      quality: { completion_note: (rp && rp.completion_note) || null },
      audit: { valid: audit.valid },
      created_at: task.created_at,
      completed_at: task.completed_at,
    });
  } catch (e) {
    console.error('[任务回查失败]', e.message);
    res.status(500).json(encoder.makeError(500, '查询失败', 'server_error'));
  }
});

module.exports = router;
