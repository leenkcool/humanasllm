/**
 * 工单模板服务
 *
 * 让「常用任务」模板化：管理员在工作台维护模板，上游一句 template_id 或人工一键套用，
 * 自动预填 messages / priority / category / skills / project / meta_tags。
 *
 * 关键契约：模板只提供**默认值**，上游显式值优先；category 只作为「上游显式声明」交给
 * categoryEngine.classify —— 规则命中照旧白名单锁死，模板不能绕过涉密/运维分级。
 */
const { getDb } = require('../db');
const { CATEGORIES } = require('./categoryEngine');
const { rows } = require('./queueService');

const PRIORITIES = ['high', 'medium', 'low'];
const MAX_PAYLOAD_BYTES = 65536;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 逗号分隔技能 → 去重数组（小写、去空白），与派单打分保持同一归一化规则 */
function normalizeSkills(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const s of list) {
    const k = String(s).trim().toLowerCase();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** 入参校验：返回错误信息或 null */
function validateTemplate(input = {}) {
  if (!input.name || !String(input.name).trim()) return '模板名称必填';
  if (input.category !== undefined && !CATEGORIES.includes(input.category)) return 'category 非法';
  if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) return 'priority 非法';
  if (input.payload_template !== undefined && input.payload_template !== null) {
    if (!isPlainObject(input.payload_template)) return 'payload_template 必须是对象';
    if (JSON.stringify(input.payload_template).length > MAX_PAYLOAD_BYTES) return 'payload_template 过大';
  }
  if (input.default_meta_tags !== undefined && input.default_meta_tags !== null && !isPlainObject(input.default_meta_tags)) {
    return 'default_meta_tags 必须是对象';
  }
  return null;
}

// ===== CRUD =====

async function listTemplates({ tenantId, includeDisabled = false } = {}) {
  const where = ['(tenant_id IS NULL OR tenant_id = ?)'];
  const params = [tenantId || null];
  if (!includeDisabled) where.push('enabled = true');
  return rows(await getDb().exec(
    `SELECT * FROM task_templates WHERE ${where.join(' AND ')} ORDER BY id DESC`,
    params));
}

async function getTemplate(id) {
  return rows(await getDb().exec('SELECT * FROM task_templates WHERE id = ?', [id]))[0] || null;
}

/** 模板是否对租户可见（全局模板 tenant_id IS NULL 对所有租户可见） */
function templateVisible(tpl, tenantId) {
  if (!tpl) return false;
  return tpl.tenant_id === null || tpl.tenant_id === undefined || tpl.tenant_id === tenantId;
}

async function createTemplate(input, actor, tenantId) {
  const bad = validateTemplate(input);
  if (bad) return { ok: false, message: bad };
  const { lastId } = await getDb().run(
    `INSERT INTO task_templates
       (name, description, category, priority, skills, project_code, system_prompt,
        payload_template, default_meta_tags, enabled, tenant_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)`,
    [String(input.name).trim(), input.description || null,
      input.category || 'general', input.priority || 'medium',
      input.skills || null, input.project_code || null, input.system_prompt || null,
      JSON.stringify(input.payload_template || {}),
      input.default_meta_tags ? JSON.stringify(input.default_meta_tags) : null,
      input.enabled !== false, tenantId || null, actor ? actor.id : null]);
  return { ok: true, id: lastId };
}

async function updateTemplate(id, patch = {}) {
  // 只校验本次提交的字段（name 缺失时用占位符跳过必填检查）
  const bad = validateTemplate({
    name: patch.name !== undefined ? patch.name : '__unchanged__',
    category: patch.category, priority: patch.priority,
    payload_template: patch.payload_template, default_meta_tags: patch.default_meta_tags,
  });
  if (bad) return { ok: false, message: bad };
  const allowed = ['name', 'description', 'category', 'priority', 'skills', 'project_code',
    'system_prompt', 'enabled', 'default_meta_tags'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    if (k === 'default_meta_tags') {
      sets.push(`${k} = ?::jsonb`);
      params.push(patch[k] === null ? null : JSON.stringify(patch[k]));
    } else {
      sets.push(`${k} = ?`);
      params.push(patch[k]);
    }
  }
  if (patch.payload_template !== undefined) {
    sets.push('payload_template = ?::jsonb');
    params.push(JSON.stringify(patch.payload_template));
  }
  if (!sets.length) return { ok: false, message: '无更新字段' };
  sets.push('updated_at = NOW()');
  params.push(id);
  await getDb().run(`UPDATE task_templates SET ${sets.join(', ')} WHERE id = ?`, params);
  return { ok: true, id };
}

/** 软删：置 enabled=false，历史任务的 template_id 仍可溯源自
 *  （硬删会被 tasks.template_id 的悬空引用影响展示，软删更安全） */
async function deleteTemplate(id) {
  await getDb().run('UPDATE task_templates SET enabled = false, updated_at = NOW() WHERE id = ?', [id]);
  return { ok: true };
}

async function bumpUseCount(id) {
  await getDb().run('UPDATE task_templates SET use_count = use_count + 1 WHERE id = ?', [id]);
}

// ===== 合并（纯函数，便于单测） =====

/**
 * 模板 + 上游请求 → 合并后的请求（模板给默认值，上游优先）
 * @param {Object} tpl 模板行
 * @param {Object} parsed openaiEncoder.parseChatRequest 的输出（含 messages / extra）
 * @returns {Object} 新的 parsed（不修改入参）
 */
function mergeIntoParsed(tpl, parsed) {
  if (!tpl) return parsed;
  const tplPayload = isPlainObject(tpl.payload_template) ? tpl.payload_template : {};
  const tplMsgs = Array.isArray(tplPayload.messages) ? tplPayload.messages : [];

  // messages：调用方非空则用调用方的；否则用模板的；再回填 system_prompt
  let messages = Array.isArray(parsed.messages) && parsed.messages.length
    ? parsed.messages.slice()
    : tplMsgs.slice();

  if (tpl.system_prompt && !messages.some(m => m && m.role === 'system')) {
    messages = [{ role: 'system', content: tpl.system_prompt }, ...messages];
  }

  const extra = { ...(parsed.extra || {}) };
  const pick = (upstream, tplVal) => (upstream !== undefined && upstream !== null && upstream !== '' ? upstream : tplVal);

  extra.priority = pick(parsed.extra && parsed.extra.priority, tpl.priority || undefined);
  extra.skills = pick(parsed.extra && parsed.extra.skills, tpl.skills || undefined);
  extra.project_code = pick(parsed.extra && parsed.extra.project_code, tpl.project_code || undefined);
  // category：仅作为上游显式声明交给 classify，规则命中仍会白名单锁死
  extra.category = pick(parsed.extra && parsed.extra.category, tpl.category || undefined);

  // meta_tags：模板默认值 ← 上游覆盖
  const tplMeta = isPlainObject(tpl.default_meta_tags) ? tpl.default_meta_tags
    : (isPlainObject(tplPayload.meta_tags) ? tplPayload.meta_tags : {});
  const upMeta = isPlainObject(parsed.extra && parsed.extra.meta_tags) ? parsed.extra.meta_tags : {};
  const mergedMeta = { ...tplMeta, ...upMeta };
  if (Object.keys(mergedMeta).length) extra.meta_tags = mergedMeta;

  // tools：上游优先，否则模板预置
  const tools = (Array.isArray(parsed.tools) && parsed.tools.length) ? parsed.tools
    : (Array.isArray(tplPayload.tools) ? tplPayload.tools : null);

  return { ...parsed, messages, extra, tools };
}

module.exports = {
  PRIORITIES, MAX_PAYLOAD_BYTES, normalizeSkills, validateTemplate,
  listTemplates, getTemplate, templateVisible, createTemplate, updateTemplate,
  deleteTemplate, bumpUseCount, mergeIntoParsed,
};
