/**
 * 答复起草服务（AI 起草 + 人工审核）
 *
 * 用户原则：「帮他回复的人也会借用大模型，但回复内容是经过专业人员审计、筛选或
 * 提示词设计的」。本服务把这句话落成可留痕的机制——起草留痕 drafted_by_ai，
 * 人工修改后提交，审计链可追溯。
 *
 * 红线：confidential / ops 类**禁止** AI 起草（上下文不得出网关），
 * 仅 general 类可用。判断复用 categoryEngine 的分级结果，不另立口径。
 */
require('dotenv').config();
const aiRelay = require('./aiRelay');
const queue = require('./queueService');

const DRAFTABLE_CATEGORIES = ['general'];
const MAX_CONTEXT_CHARS = 8000;

/** 该任务是否允许 AI 起草（分级 + 中继可用性） */
function canDraft(task) {
  if (!task) return { ok: false, message: '任务不存在' };
  if (!DRAFTABLE_CATEGORIES.includes(task.category || 'general')) {
    return {
      ok: false,
      message: `${task.category} 类任务禁止 AI 起草（上下文不得出网关），请人工撰写`,
    };
  }
  if (!aiRelay.enabled()) {
    return { ok: false, message: 'AI 中继未启用或未配置 API Key，无法起草' };
  }
  return { ok: true };
}

/** 从任务请求体提取可读上下文（截断防超长） */
function buildContext(task) {
  const p = task.request_payload || {};
  const msgs = Array.isArray(p.messages) ? p.messages : [];
  const lines = [];
  for (const m of msgs) {
    if (!m || m.content == null) continue;
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    lines.push(`[${m.role || 'user'}] ${text}`);
  }
  const joined = lines.join('\n');
  return joined.length > MAX_CONTEXT_CHARS
    ? joined.slice(0, MAX_CONTEXT_CHARS) + '\n…（上下文已截断）'
    : joined;
}

/** 起草用系统提示：强调可执行、可验证、交代前提 */
const SYSTEM_PROMPT = `你是资深技术顾问，正在协助一位人类工程师起草给上游 AI Agent 的答复。

要求：
1. 直接给出可执行的结论与步骤，不要寒暄、不要复述问题。
2. 涉及命令/配置/代码时给出完整可复制的内容。
3. 明确交代前提条件、风险与回滚方式（若适用）。
4. 不确定的地方显式写出「需确认：…」，不要编造。
5. 控制在 800 字以内，用中文。

注意：这是初稿，人类工程师会在此基础上修改定稿。`;

/**
 * 生成答复草稿（不落库，由调用方决定是否采用）
 * @param {Object} task 任务行
 * @returns {Promise<{ok:boolean, draft?:string, message?:string}>}
 */
async function draft(task) {
  const check = canDraft(task);
  if (!check.ok) return check;

  const context = buildContext(task);
  if (!context.trim()) return { ok: false, message: '任务缺少上下文，无法起草' };

  try {
    const data = await aiRelay.chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `上游需求如下：\n\n${context}` },
      ],
      max_tokens: 1600,
      temperature: 0.3,
    });
    const content = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (!content || !String(content).trim()) {
      return { ok: false, message: 'AI 返回为空，请重试或人工撰写' };
    }
    return { ok: true, draft: String(content).trim() };
  } catch (e) {
    console.error('[起草失败]', task.id, e.message);
    return { ok: false, message: 'AI 起草失败：' + e.message };
  }
}

/**
 * 记录「本次答复使用了 AI 起草」到审计哈希链
 * 在 completeTask 成功之后调用，失败只记日志不阻断提交
 */
async function markDrafted(taskId, actor, meta = {}) {
  try {
    await queue.addLog(taskId, 'draft',
      null,
      { drafted_by_ai: true, model: meta.model || null, edited: meta.edited !== false },
      actor || null, '答复使用了 AI 起草（人工修改后提交）');
  } catch (e) {
    console.error('[起草留痕失败]', taskId, e.message);
  }
}

module.exports = { DRAFTABLE_CATEGORIES, canDraft, buildContext, draft, markDrafted, SYSTEM_PROMPT };
