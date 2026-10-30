/**
 * 知识库服务（答复复用）
 *
 * 三级作用域（由严到宽）：
 *   project  仅该项目成员 + 租户 admin 可见
 *   tenant   同租户全体成员
 *   global   所有租户
 *
 * 硬约束：confidential 类条目**永不进入 global/tenant 共享池**，
 * 只能 scope=project 或作者本人可见——「数据不出网关」在知识库上的延续。
 */
const { getDb } = require('../db');
const { rows } = require('./queueService');
const members = require('./projectMemberService');

const SCOPES = ['project', 'tenant', 'global'];
const CATEGORIES = ['general', 'confidential', 'ops'];
const MIN_SIMILARITY = 0.05;

/** 校验入参 */
function validate(input = {}) {
  if (!input.title || !String(input.title).trim()) return '标题必填';
  if (!input.problem || !String(input.problem).trim()) return '问题描述必填';
  if (!input.solution || !String(input.solution).trim()) return '答复内容必填';
  if (input.scope && !SCOPES.includes(input.scope)) return 'scope 非法';
  if (input.category && !CATEGORIES.includes(input.category)) return 'category 非法';
  if (input.scope === 'project' && !input.project_code) return '项目知识库必须指定 project_code';
  // 涉密条目不得共享
  if (input.category === 'confidential' && input.scope && input.scope !== 'project') {
    return 'confidential 类知识只能作为项目知识库（scope=project）或私有保存';
  }
  return null;
}

/** 构建可见性 SQL 片段（所有检索/列表复用，避免各处口径漂移） */
async function visibleClause(user, tenantId) {
  // admin：本租户全可见
  if (user.role === 'admin') {
    return { sql: '(tenant_id = ? OR scope = \'global\')', params: [tenantId || null] };
  }
  const codes = await members.accessibleProjectCodes({
    userId: user.id, role: user.role, tenantId,
  });
  const projectPart = (codes && codes.length)
    ? `(scope = 'project' AND project_code IN (${codes.map(() => '?').join(',')}))`
    : '(1 = 0)';
  const params = [...(codes || [])];
  // 涉密条目：仅作者本人或项目成员可见（project 分支已含成员校验）
  const sql = `(
    (scope = 'global' AND category <> 'confidential')
    OR (scope = 'tenant' AND tenant_id = ? AND category <> 'confidential')
    OR ${projectPart}
    OR (author_id = ?)
  )`;
  return { sql, params: [tenantId || null, ...params, user.id] };
}

/**
 * 列表（按作用域/分级/关键词筛选）
 */
async function list({ user, tenantId, scope, category, keyword, page = 1, size = 20 }) {
  const vis = await visibleClause(user, tenantId);
  const where = [`(${vis.sql})`];
  const params = [...vis.params];
  if (scope && SCOPES.includes(scope)) { where.push('scope = ?'); params.push(scope); }
  if (category && CATEGORIES.includes(category)) { where.push('category = ?'); params.push(category); }
  if (keyword) {
    where.push('(title ILIKE ? OR problem ILIKE ? OR tags ILIKE ?)');
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw);
  }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const db = getDb();
  const total = parseInt(rows(await db.exec(`SELECT COUNT(*) AS c FROM knowledge_entries ${whereSql}`, params))[0].c, 10) || 0;
  const offset = (Math.max(1, page) - 1) * size;
  const data = rows(await db.exec(
    `SELECT * FROM knowledge_entries ${whereSql} ORDER BY use_count DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]));
  return { data, total, page, size };
}

/** 详情（带可见性校验） */
async function get({ id, user, tenantId }) {
  const vis = await visibleClause(user, tenantId);
  const r = rows(await getDb().exec(
    `SELECT * FROM knowledge_entries WHERE id = ? AND (${vis.sql})`, [id, ...vis.params]))[0];
  return r || null;
}

async function create(input, actor, tenantId) {
  const bad = validate(input);
  if (bad) return { ok: false, message: bad };
  const scope = input.category === 'confidential' ? 'project' : (input.scope || 'tenant');
  const { lastId } = await getDb().run(
    `INSERT INTO knowledge_entries
       (title, category, scope, project_code, problem, solution, tags, source_task_id, tenant_id, author_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [String(input.title).trim(), input.category || 'general', scope,
      input.project_code || null, String(input.problem).trim(), String(input.solution).trim(),
      input.tags || null, input.source_task_id || null, tenantId || null, actor ? actor.id : null]);
  return { ok: true, id: lastId, scope };
}

async function update(id, patch, user, tenantId) {
  const cur = await get({ id, user, tenantId });
  if (!cur) return { ok: false, message: '知识条目不存在或无权访问' };
  if (user.role !== 'admin' && cur.author_id !== user.id) {
    return { ok: false, message: '仅作者或管理员可编辑' };
  }
  const merged = { ...cur, ...patch };
  const bad = validate(merged);
  if (bad) return { ok: false, message: bad };
  const sets = [];
  const params = [];
  for (const k of ['title', 'category', 'scope', 'project_code', 'problem', 'solution', 'tags']) {
    if (patch[k] !== undefined) { sets.push(`${k} = ?`); params.push(patch[k]); }
  }
  if (!sets.length) return { ok: false, message: '无更新字段' };
  sets.push('updated_at = NOW()');
  params.push(id);
  await getDb().run(`UPDATE knowledge_entries SET ${sets.join(', ')} WHERE id = ?`, params);
  return { ok: true, id };
}

async function remove(id, user, tenantId) {
  const cur = await get({ id, user, tenantId });
  if (!cur) return { ok: false, message: '知识条目不存在或无权访问' };
  if (user.role !== 'admin' && cur.author_id !== user.id) {
    return { ok: false, message: '仅作者或管理员可删除' };
  }
  await getDb().run('DELETE FROM knowledge_entries WHERE id = ?', [id]);
  return { ok: true };
}

async function bumpUse(id) {
  await getDb().run('UPDATE knowledge_entries SET use_count = use_count + 1 WHERE id = ?', [id]);
}

/**
 * 相似历史答复检索（工程师答复任务时侧栏展示）
 * 优先用 pg_trgm 相似度；扩展不可用时降级为关键词 ILIKE。
 */
async function similar({ text, user, tenantId, limit = 5 }) {
  if (!text || !String(text).trim()) return [];
  const vis = await visibleClause(user, tenantId);
  const q = String(text).slice(0, 500);
  // 中文短语的三元组相似度普遍偏低，额外用关键词做兜底召回
  const kw = '%' + q.slice(0, 20).replace(/[%_]/g, '') + '%';
  const db = getDb();
  try {
    return rows(await db.exec(
      `SELECT id, title, category, scope, project_code, problem, solution, tags, use_count,
              similarity(problem, ?) AS sim
         FROM knowledge_entries
        WHERE (${vis.sql})
          AND (similarity(problem, ?) >= ? OR problem ILIKE ? OR title ILIKE ?)
        ORDER BY sim DESC, use_count DESC
        LIMIT ?`,
      [q, ...vis.params, q, MIN_SIMILARITY, kw, kw, limit]));
  } catch (e) {
    // pg_trgm 不可用：纯关键词匹配
    return rows(await db.exec(
      `SELECT id, title, category, scope, project_code, problem, solution, tags, use_count,
              0 AS sim
         FROM knowledge_entries
        WHERE (${vis.sql}) AND (problem ILIKE ? OR title ILIKE ?)
        ORDER BY use_count DESC LIMIT ?`,
      [...vis.params, kw, kw, limit]));
  }
}

/**
 * 上游自动命中（opt-in use_knowledge）
 * 只命中 global / 同租户 tenant 条目；project 条目不参与（上游请求无项目成员身份）
 */
async function matchForUpstream({ text, tenantId, threshold = 0.7 }) {
  if (!text) return null;
  const q = String(text).slice(0, 500);
  try {
    const r = rows(await getDb().exec(
      `SELECT id, title, solution, category, scope, similarity(problem, ?) AS sim
         FROM knowledge_entries
        WHERE category <> 'confidential'
          AND ((scope = 'global') OR (scope = 'tenant' AND tenant_id = ?))
          AND similarity(problem, ?) >= ?
        ORDER BY sim DESC LIMIT 1`,
      [q, tenantId || null, q, threshold]))[0];
    return r || null;
  } catch (e) {
    return null; // 扩展不可用时不做自动命中（保守）
  }
}

/** 完成任务的答复一键沉淀（预填问题/答复/标签） */
function draftFromTask(task) {
  const msgs = (task.request_payload && task.request_payload.messages) || [];
  const problem = msgs.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n').slice(0, 2000);
  const firstLine = problem.split('\n')[0] || '';
  return {
    title: firstLine.slice(0, 60) || `任务 #${task.id} 的答复`,
    category: task.category || 'general',
    // 有项目 -> 默认项目知识库；涉密强制 project
    scope: (task.category === 'confidential' || task.project_code) ? 'project' : 'tenant',
    project_code: task.project_code || null,
    problem,
    solution: task.result_text || '',
    tags: task.skills || null,
    source_task_id: task.id,
  };
}

module.exports = {
  SCOPES, CATEGORIES, MIN_SIMILARITY, validate, visibleClause,
  list, get, create, update, remove, bumpUse, similar, matchForUpstream, draftFromTask,
};
