/**
 * 会话服务（多轮追问）
 *
 * 上游首次请求不带 conversation_id → 网关生成一个随 task_id 返回；
 * 追问时带上 conversation_id → 新任务挂到同一会话，工程师侧看到的是完整时间线。
 *
 * 关键约束：
 *  - 追问**继承首轮分级**：首轮是 confidential，后续轮次一律 confidential，
 *    不允许因内容变化降级（白名单锁死的语义延续到会话维度）。
 *  - 不传 conversation_id 时行为完全不变（零破坏）。
 */
const { getDb } = require('../db');
const { rows } = require('./queueService');

const MAX_TURNS = 50;
const CARRY_FIELDS = ['category', 'priority', 'project_code', 'skills', 'tenant_id', 'callback_url'];

/** 生成会话 id */
function makeConversationId() {
  return 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** 取会话最新一轮（用于继承分级与上下文） */
async function latestTurn(conversationId, tenantId) {
  return rows(await getDb().exec(
    `SELECT * FROM tasks
      WHERE conversation_id = ? AND tenant_id = ?
      ORDER BY turn_index DESC, id DESC LIMIT 1`,
    [conversationId, tenantId || null]))[0] || null;
}

/** 会话全部轮次（时间线，升序） */
async function listTurns(conversationId, tenantId) {
  return rows(await getDb().exec(
    `SELECT id, turn_index, status, category, priority, assignee_id, result_text,
            reject_reason, claimed_at, completed_at, created_at, request_payload
       FROM tasks
      WHERE conversation_id = ? AND tenant_id = ?
      ORDER BY turn_index ASC, id ASC`,
    [conversationId, tenantId || null]));
}

/** 会话轮数 */
async function turnCount(conversationId, tenantId) {
  const r = rows(await getDb().exec(
    'SELECT COUNT(*) AS c FROM tasks WHERE conversation_id = ? AND tenant_id = ?',
    [conversationId, tenantId || null]))[0];
  return parseInt(r && r.c, 10) || 0;
}

/**
 * 解析会话参数（供 /v1 建单前调用）
 * @param {Object} opts { conversationId, tenantId }
 * @returns {Promise<{ok:boolean, conversation_id:string, turn_index:number, parent_task_id:number|null,
 *                    inherit:Object|null, message?:string}>}
 */
async function resolveConversation({ conversationId, tenantId }) {
  if (!conversationId) {
    // 新会话
    return { ok: true, conversation_id: makeConversationId(), turn_index: 0, parent_task_id: null, inherit: null };
  }

  const prev = await latestTurn(conversationId, tenantId);
  if (!prev) {
    // 带了一个本租户不存在的会话 id：拒绝而非静默新建，避免上游拼错就悄悄分裂成新会话
    return { ok: false, message: `conversation_id 不存在或不属于当前租户: ${conversationId}` };
  }
  const count = await turnCount(conversationId, tenantId);
  if (count >= MAX_TURNS) {
    return { ok: false, message: `会话已达上限 ${MAX_TURNS} 轮，请新建会话` };
  }

  return {
    ok: true,
    conversation_id: conversationId,
    turn_index: (parseInt(prev.turn_index, 10) || 0) + 1,
    parent_task_id: prev.id,
    inherit: prev,  // 供调用方继承分级/优先级/项目
  };
}

/**
 * 把会话继承字段合并进 parsed（追问轮次用）
 * 规则：分级与项目强制继承；优先级仅在上游未指定时继承。
 */
function applyInheritance(parsed, prev, classifyResult) {
  if (!prev) return { parsed, categoryOverride: null };
  const extra = { ...(parsed.extra || {}) };

  // 项目：强制继承（追问属于同一业务上下文）
  if (!extra.project_code && prev.project_code) extra.project_code = prev.project_code;
  // 优先级：上游未指定时继承
  if (!extra.priority && prev.priority) extra.priority = prev.priority;
  // 技能：上游未指定时继承
  if (!extra.skills && prev.skills) extra.skills = prev.skills;
  // 分级：一旦首轮被判为受保护类，后续轮次不允许降级
  let categoryOverride = null;
  const protectedCats = ['confidential', 'ops'];
  if (protectedCats.includes(prev.category)) {
    // 若本轮规则判成 general，则强制沿用首轮分级（防降级）
    if (!classifyResult || classifyResult.category === 'general') {
      categoryOverride = prev.category;
    }
  }
  return { parsed: { ...parsed, extra }, categoryOverride };
}

/**
 * 会话摘要（给上游回查用，避免整段上下文回传）
 */
async function conversationSummary(conversationId, tenantId) {
  const turns = await listTurns(conversationId, tenantId);
  return turns.map(t => {
    const msgs = (t.request_payload && t.request_payload.messages) || [];
    const ask = msgs.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n');
    return {
      task_id: t.id,
      turn_index: t.turn_index,
      status: t.status,
      category: t.category,
      question: ask.slice(0, 500),
      answer: t.status === 'completed' ? String(t.result_text || '').slice(0, 2000) : null,
      reject_reason: t.reject_reason || null,
      created_at: t.created_at,
      completed_at: t.completed_at,
    };
  });
}

module.exports = {
  MAX_TURNS, CARRY_FIELDS, makeConversationId,
  latestTurn, listTurns, turnCount, resolveConversation,
  applyInheritance, conversationSummary,
};
