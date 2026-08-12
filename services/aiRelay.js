/**
 * AI 降级中继服务（借鉴 puppetllm 跨 provider 中继思路）
 * 把请求中继转发到真实 LLM provider（默认 DeepSeek），支持一次性与 stream 透传
 *
 * 两种触发方式：
 *  1) 模型名路由：请求 model 匹配 AI_RELAY_MODELS → 直接中继到真实 LLM
 *  2) 人工超时降级：待接单任务超时无人接单 → 用任务上下文调 AI 代答
 */
require('dotenv').config();

const AI_RELAY_ENABLED = process.env.AI_RELAY_ENABLED !== 'false';
const AI_BASE = process.env.AI_RELAY_BASE_URL || 'https://api.deepseek.com';
const AI_KEY = process.env.AI_RELAY_API_KEY || '';
const AI_MODELS = (process.env.AI_RELAY_MODELS || 'deepseek-v4-flash')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/** 中继是否可用（启用 + 已配 key） */
function enabled() {
  return AI_RELAY_ENABLED && !!AI_KEY;
}

/** 该 model 是否走 AI 中继路由 */
function shouldRelay(model) {
  return enabled() && AI_MODELS.includes(model);
}

/** AI 中继暴露的模型列表（供 /v1/models 聚合） */
function getModels() {
  return AI_MODELS;
}

/**
 * 一次性调用真实 LLM，返回 OpenAI 结构 JSON
 * @param {Object} body  OpenAI 请求体（messages/params）
 * @param {number} timeoutMs
 */
async function chat(body, timeoutMs = 120000) {
  if (!AI_KEY) throw new Error('未配置 AI_RELAY_API_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${AI_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify({ ...body, stream: false, model: body.model || AI_MODELS[0] }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error((data && data.error && data.error.message) || `AI provider 返回 ${resp.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式透传：把上游 SSE 流原样 pipe 给客户端
 * 调用方需处理上游 fetch 失败的异常
 */
async function relayStream(req, res) {
  if (!AI_KEY) throw new Error('未配置 AI_RELAY_API_KEY');
  const upstream = await fetch(`${AI_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
    body: JSON.stringify(req.body),
  });
  res.status(upstream.status);
  const ct = upstream.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);
  // Node ReadableStream → Express 响应
  const reader = upstream.body.getReader();
  res.flushHeaders();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

module.exports = { enabled, shouldRelay, getModels, chat, relayStream };
