/**
 * 分级策略引擎（治理层「分级是人的边界」）
 *
 * 任务分类计算：规则命中（安全优先，白名单锁死） > 上游显式 category > 默认 general。
 * 白名单锁死：规则命中 confidential/ops 时，即使上游显式声明 general 也按规则定级——
 * 涉密/运维上下文不得因上游声明而降到可 AI 兜底的 general 池。
 */
const { getDb } = require('../db');

const CATEGORIES = ['general', 'confidential', 'ops'];
const DEFAULT = 'general';

/** 上游显式 category（规范化，非法返回 null） */
function explicitCategory(cat) {
  return CATEGORIES.includes(cat) ? cat : null;
}

/** 关键字命中检测：含任一关键字即命中 */
function matchKeywords(text, keywords) {
  if (!text || !keywords) return false;
  const list = String(keywords).split(',').map(s => s.trim()).filter(Boolean);
  return list.some(k => text.includes(k));
}

/** 组合待匹配文本：消息内容 + 项目码 */
function buildText(messages, body) {
  const parts = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (m && typeof m.content === 'string') parts.push(m.content);
  }
  if (body && body.project_code) parts.push(String(body.project_code));
  return parts.join('\n');
}

function rowToObj(cols, row) {
  const o = {};
  cols.forEach((c, i) => { o[c] = row[i]; });
  return o;
}

/**
 * 计算任务分类（多租户：租户专属规则优先，全局规则兜底）
 * @param {Object} opts { messages, body, tenantId }  body 含 project_code / meta_tags / category
 * @returns {Promise<{category, rule_id, rule_name, source}>}
 *   source: 'rule'（规则命中，白名单锁死）| 'explicit'（上游声明）| 'default'
 */
async function classify({ messages, body = {}, tenantId }) {
  const db = getDb();
  const text = buildText(messages, body);

  // 1) 规则匹配（租户专属优先，enabled + priority 升序，命中即锁死）
  const rules = await db.exec(
    'SELECT * FROM task_rules WHERE enabled = true AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY (tenant_id = ?) DESC, priority ASC, id ASC',
    [tenantId || null, tenantId || null]);
  for (const row of (rules[0] ? rules[0].values : [])) {
    const r = rowToObj(rules[0].columns, row);
    const target = r.match_field === 'project'
      ? String(body.project_code || body.project || '')
      : r.match_field === 'meta_tags'
        ? JSON.stringify(body.meta_tags || body.meta || {})
        : text;
    if (matchKeywords(target, r.keywords)) {
      return { category: r.category, rule_id: r.id, rule_name: r.name, source: 'rule' };
    }
  }

  // 2) 上游显式 category
  const explicit = explicitCategory(body.category);
  if (explicit) return { category: explicit, rule_id: null, rule_name: null, source: 'explicit' };

  // 3) 默认 general
  return { category: DEFAULT, rule_id: null, rule_name: null, source: 'default' };
}

module.exports = { CATEGORIES, DEFAULT, classify, matchKeywords };
