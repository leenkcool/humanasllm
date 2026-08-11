/**
 * OpenAI 兼容编码器
 * 上游请求体解析、标准 Chat Completion 响应封装、SSE 流式 chunk 生成
 */
const { v4: uuidv4 } = require('uuid');

const MODEL = process.env.HUMAN_LLM_MODEL || 'human-llm';

/** 人工任务场景分类（涉密/运维类禁止 AI 兜底，见 queueService.timeoutTask） */
const CATEGORIES = ['general', 'confidential', 'ops'];

function makeId() {
  return 'chatcmpl-' + uuidv4().replace(/-/g, '').slice(0, 24);
}

/** 解析上游标准 Chat Completion 请求体 */
function parseChatRequest(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    throw Object.assign(new Error('Invalid \'messages\': must be a non-empty array.'), { status: 400 });
  }
  const extra = pickExtra(body);
  // category 最终定级交给分级策略引擎（categoryEngine.classify：规则白名单锁死 > 显式 > default）
  return {
    model: body.model || MODEL,
    stream: !!body.stream,
    messages,                    // 完整透传全部上下文
    max_tokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    stop: body.stop ?? null,
    user: body.user ?? null,
    extra,      // 元标签/项目编号/优先级/场景分类/文件描述等
  };
}

/** 提取业务扩展字段（全透传，工作台展示用） */
function pickExtra(body) {
  const keys = ['skills', 'category', 'project_code', 'project', 'meta_tags', 'meta', 'priority', 'files', 'attachments', 'metadata'];
  const out = {};
  for (const k of keys) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

/** 生成标准 Chat Completion 一次性响应 */
function makeChatCompletion({ id, model, created, content }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 生成 SSE 流式 chunk（模拟大模型逐段输出），末尾含 [DONE] */
function makeStreamChunks({ id, model, created, content }) {
  const chunk = (delta, finish) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  });
  const parts = [];
  parts.push('data: ' + JSON.stringify(chunk({ role: 'assistant' })) + '\n\n');
  const step = 40;
  for (let i = 0; i < content.length; i += step) {
    parts.push('data: ' + JSON.stringify(chunk({ content: content.slice(i, i + step) })) + '\n\n');
  }
  parts.push('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n');
  parts.push('data: [DONE]\n\n');
  return parts;
}

/** OpenAI 风格错误结构 */
function makeError(status, message, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code: null } };
}

/** 从 messages 提取任务摘要（工作台展示） */
function summarizeMessages(messages) {
  const counts = { system: 0, user: 0, assistant: 0, tool: 0, function: 0 };
  for (const m of messages) {
    const r = m && m.role;
    if (counts[r] !== undefined) counts[r]++;
  }
  const toText = (c) => {
    if (c == null) return '';
    return typeof c === 'string' ? c : JSON.stringify(c);
  };
  const sys = messages.find(m => m.role === 'system');
  const firstUser = messages.find(m => m.role === 'user');
  return {
    counts,
    systemPrompt: sys ? toText(sys.content).slice(0, 2000) : '',
    firstUserText: firstUser ? toText(firstUser.content).slice(0, 500) : '',
  };
}

module.exports = {
  MODEL, CATEGORIES, makeId, parseChatRequest, makeChatCompletion,
  makeStreamChunks, makeError, summarizeMessages,
};
