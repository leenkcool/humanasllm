/**
 * 智能漂移执行引擎（阶段三：general 池边界自动调整）
 *
 * 当 AI_SHIFT_ENABLED=true 且 AI 中继可用时：general 且未被分级规则锁定（白名单）的
 * 简单任务直接由 AI 承接，不创建人工任务（省人工）；confidential/ops 由规则锁死，绝不漂移。
 * AI 漂移失败 → 调用方回落人工。
 */
const { classify } = require('./categoryEngine');
const aiRelay = require('./aiRelay');

const ENABLED = process.env.AI_SHIFT_ENABLED === 'true';

function enabled() {
  return ENABLED && aiRelay.enabled();
}

/**
 * 是否应走 AI 漂移
 * @param {Object} opts { messages, body }  body 含 category / project_code / meta_tags / skills
 */
async function shouldShift({ messages, body = {} }) {
  if (!enabled()) return false;
  const cat = await classify({ messages, body });
  // 仅 general 且非规则锁定可漂移；confidential/ops 制度锁死
  return cat.category === 'general' && cat.source !== 'rule';
}

module.exports = { enabled, shouldShift };
