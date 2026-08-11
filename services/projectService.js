/**
 * 项目管理服务
 * 项目 CRUD + 审批批准建项目（申请建项目复用审批体系）
 */
const { getDb } = require('../db');

function rows(result) {
  if (!result || !result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

async function listProjects({ status, tenantId } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (tenantId) { where.push('tenant_id = ?'); params.push(tenantId); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return rows(await db.exec(`SELECT * FROM projects ${whereSql} ORDER BY id`, params));
}

async function getProject(id) {
  const list = rows(await getDb().exec('SELECT * FROM projects WHERE id = ?', [id]));
  return list[0] || null;
}

async function getProjectByCode(code) {
  const list = rows(await getDb().exec('SELECT * FROM projects WHERE code = ?', [code]));
  return list[0] || null;
}

async function createProject({ code, name, description, createdBy, tenantId }) {
  const db = getDb();
  if (!code || !name) throw Object.assign(new Error('项目编码和名称不能为空'), { status: 400 });
  const exists = rows(await db.exec('SELECT id FROM projects WHERE code = ?', [code]));
  if (exists[0]) throw Object.assign(new Error('项目编码已存在'), { status: 400 });
  const { lastId } = await db.run(
    'INSERT INTO projects (code, name, description, created_by, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [code, name, description || null, createdBy || null, tenantId || null]
  );
  return { id: lastId, code, name };
}

async function updateProject(id, { name, description }) {
  const db = getDb();
  const p = await getProject(id);
  if (!p) throw Object.assign(new Error('项目不存在'), { status: 404 });
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (description !== undefined) { sets.push('description = ?'); params.push(description); }
  if (!sets.length) throw Object.assign(new Error('没有可更新字段'), { status: 400 });
  params.push(id);
  await db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params);
  return getProject(id);
}

async function archiveProject(id) {
  const p = await getProject(id);
  if (!p) throw Object.assign(new Error('项目不存在'), { status: 404 });
  const next = p.status === 'active' ? 'archived' : 'active';
  await getDb().run('UPDATE projects SET status = ? WHERE id = ?', [next, id]);
  return getProject(id);
}

/** 审批批准建项目时调用（approval.detail 为 JSON：{code,name,desc}） */
async function createFromApproval(approval) {
  let detail = {};
  try {
    detail = typeof approval.detail === 'string' ? JSON.parse(approval.detail) : (approval.detail || {});
  } catch (e) { detail = {}; }
  const code = detail.code || approval.project_code || ('proj-' + Date.now().toString(36));
  return createProject({
    code,
    name: detail.name || approval.resource || code,
    description: detail.desc || approval.purpose || null,
    createdBy: approval.provider_id || null,
    tenantId: approval.tenant_id,
  });
}

module.exports = {
  listProjects, getProject, getProjectByCode,
  createProject, updateProject, archiveProject, createFromApproval,
};
