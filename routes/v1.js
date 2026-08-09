/**
 * OpenAI 兼容接口（/v1）
 * GET  /v1/models
 * POST /v1/chat/completions   （支持 stream 与一次性返回）
 *
 * 上游 Agent / 调度池新增一条模型路由指向此处即可，无需改动代码。
 */
const express = require('express');
const router = express.Router();
const encoder = require('../services/openaiEncoder');
const queue = require('../services/queueService');

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
  res.json({
    object: 'list',
    data: [{ id: encoder.MODEL, object: 'model', owned_by: 'p390', permission: [] }],
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

  const chatId = encoder.makeId();
  const created = Math.floor(Date.now() / 1000);

  // 接入 → 创建人工任务（pending）→ 推送工作台
  let taskId;
  try {
    const createdRes = await queue.createTaskFromRequest({ parsed, chatId, created });
    taskId = createdRes.taskId;
  } catch (e) {
    console.error('[创建任务失败]', e.message);
    return res.status(500).json(encoder.makeError(500, '任务创建失败', 'server_error'));
  }
  await queue.logRequest(taskId, 'in', req.body, parsed.model);

  // 挂起等待人工结果（超时兜底）
  const waitMs = parseInt(process.env.TASK_WAIT_MS) || 5 * 60 * 1000;
  const result = await queue.waitForTask(taskId, waitMs);
  const content = result.content || '';

  if (parsed.stream) {
    // SSE 流式输出
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    for (const line of encoder.makeStreamChunks({ id: chatId, model: parsed.model, created, content })) {
      res.write(line);
    }
    res.end();
    return;
  }

  // 一次性返回：完成 / 驳回 / 超时统一按 OpenAI 结构返回，content 携带结果或说明
  res.json(encoder.makeChatCompletion({ id: chatId, model: parsed.model, created, content }));
});

module.exports = router;
