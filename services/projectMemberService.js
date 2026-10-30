/**
 * 项目成员服务（项目级权限）
 *
 * 背景：原先 projects 表只有 code/name/tenant_id，租户内**所有人可见所有项目**，
 * 不存在「项目权限」这个概念。项目知识库要按项目隔离，必须先补这一层。
 *
 * 兼容策略：已有项目若没有任何成员记录，视为「租户内可见」（保持现状），
 * 避免上线瞬间锁死历史项目；一旦管理员为某项目添加了成员，该项目即转为成员制。
 */
const { getDb } = require('../db');
const { rows } = require('./queueService');

const ROLES = ['owner', 'member', 'viewer'];

async function listMembers(projectCode, tenantId) {
  return rows(await getDb().exec(
    `SELECT m.id, m.project_code, m.user_id, m.role, m.created_at,
            u.username, u.name, u.skills
       FROM project_members m JOIN users u ON m.user_id = u.id
      WHERE m.project_code = ? AND m.tenant_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.id`,
    [projectCode, tenantId || null]));
}

async function addMember({ projectCode, userId, role = 'member', tenantId, actor }) {
  if (!ROLES.includes(role)) return { ok: false, message: 'role 非法（owner/member/viewer）' };
  const db = getDb();
  const u = rows(await db.exec('SELECT id FROM users WHERE id = ? AND tenant_id = ?', [userId, tenantId || null]))[0];
  if (!u) return { ok: false, message: '用户不存在或不属于本租户' };
  const dup = rows(await db.exec(
    'SELECT id FROM project_members WHERE project_code = ? AND user_id = ?', [projectCode, userId]))[0];
  if (dup) {
    await db.run('UPDATE project_members SET role = ? WHERE id = ?', [role, dup.id]);
    return { ok: true, id: dup.id, updated: true };
  }
  const { lastId } = await db.run(
    'INSERT INTO project_members (project_code, user_id, role, tenant_id, added_by) VALUES (?, ?, ?, ?, ?)',
    [projectCode, userId, role, tenantId || null, actor ? actor.id : null]);
  return { ok: true, id: lastId };
}

async function removeMember({ projectCode, userId, tenantId }) {
  await getDb().run(
    'DELETE FROM project_members WHERE project_code = ? AND user_id = ? AND tenant_id = ?',
    [projectCode, userId, tenantId || null]);
  return { ok: true };
}

/** 用户是否属于该项目（admin 视为全项目可访问） */
async function isMember({ projectCode, userId, role, tenantId }) {
  if (role === 'admin') return true;
  const r = rows(await getDb().exec(
    'SELECT id FROM project_members WHERE project_code = ? AND user_id = ? AND tenant_id = ?',
    [projectCode, userId, tenantId || null]))[0];
  return !!r;
}

/** 项目是否已启用成员制（有任何成员记录即视为启用） */
async function hasMembers(projectCode, tenantId) {
  const r = rows(await getDb().exec(
    'SELECT COUNT(*) AS c FROM project_members WHERE project_code = ? AND tenant_id = ?',
    [projectCode, tenantId || null]))[0];
  return (parseInt(r && r.c, 10) || 0) > 0;
}

/**
 * 用户可访问的项目 code 列表（供知识库等场景做 in 查询）
 * - admin：返回全部（null 表示不限制）
 * - 普通用户：有成员记录的项目 + 未启用成员制的项目（兼容）
 */
async function accessibleProjectCodes({ userId, role, tenantId }) {
  if (role === 'admin') return null; // 不限制
  const memberCodes = rows(await getDb().exec(
    'SELECT project_code FROM project_members WHERE user_id = ? AND tenant_id = ?',
    [userId, tenantId || null])).map(r => r.project_code);
  const openCodes = rows(await getDb().exec(
    `SELECT p.code FROM projects p
      WHERE p.tenant_id = ?
        AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_code = p.code AND m.tenant_id = p.tenant_id)`,
    [tenantId || null])).map(r => r.code);
  return [...new Set([...memberCodes, ...openCodes])];
}

/** 建项目时把创建者设为 owner（幂等） */
async function ensureOwner({ projectCode, userId, tenantId }) {
  if (!userId) return;
  const dup = rows(await getDb().exec(
    'SELECT id FROM project_members WHERE project_code = ? AND user_id = ?', [projectCode, userId]))[0];
  if (dup) return;
  await getDb().run(
    'INSERT INTO project_members (project_code, user_id, role, tenant_id) VALUES (?, ?, ?, ?)',
    [projectCode, userId, 'owner', tenantId || null]);
}

module.exports = {
  ROLES, listMembers, addMember, removeMember, isMember, hasMembers,
  accessibleProjectCodes, ensureOwner,
};
