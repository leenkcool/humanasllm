/**
 * 细粒度权限（三权分立）
 *
 * 现状背景：系统原先只有 admin / engineer 两档，管理员权力过于集中。
 * 本模块把「管理」拆成三类互不覆盖的职责 + 一名总管理员：
 *
 *   - sys_admin  系统管理员：用户 / 租户 / 项目 / 备份 / 派单（管「人和资源」）
 *   - sec_admin  安全管理员：分级规则 / 抽检 / 评测集 / 告警（管「策略和质量」）
 *   - audit_admin 审计管理员：**只读**审计与合规（无任何写权限，防篡改）
 *   - admin      超级管理员：全部权限（开发/演示用；生产建议用三权分立）
 *   - engineer   工程师：无管理权限，只有任务相关能力（保持既有行为不变）
 *
 * 关键约束：审计管理员（audit_admin）不得拥有任何写权限——三权分立的前提是
 * 「看得见的不能改」。unit 测试锁定这一点，新增权限时若误配会立即失败。
 */

const PERMISSIONS = [
  'users.manage',        // 用户增删改
  'tenants.manage',      // 租户增删改
  'projects.manage',     // 项目建立 / 归档
  'system.backup',       // 数据备份与恢复
  'dispatch.assign',     // 一键派单
  'alerts.manage',       // 告警批量处理
  'rules.manage',        // 分级规则（安全策略）
  'templates.manage',    // 工单模板库
  'reviews.spotcheck',   // 答复抽检
  'annotations.evalset', // 生成私有评测集
  'billing.manage',      // 费率与结算
  'gateway.install',     // 服务器端安装
  'audit.read',          // 审计 / 合规报告 / 数据资产
];

const ROLES = ['admin', 'sys_admin', 'sec_admin', 'audit_admin', 'engineer'];

const ROLE_PERMISSIONS = {
  admin: ['*'],
  sys_admin: ['users.manage', 'tenants.manage', 'projects.manage', 'system.backup', 'dispatch.assign',
    'alerts.manage', 'billing.manage', 'templates.manage'],
  sec_admin: ['rules.manage', 'templates.manage', 'reviews.spotcheck', 'annotations.evalset',
    'alerts.manage', 'audit.read'],
  // 只读角色：仅审计与合规数据可见，任何写操作都没有对应权限
  audit_admin: ['audit.read'],
  engineer: [],
};

/** 某角色的权限列表（admin 返回 ['*']） */
function permissionsOf(role) {
  return (ROLE_PERMISSIONS[role] || []).slice();
}

/** 是否为管理类角色（前端侧栏 / 用户页展示用） */
function isManager(role) {
  return !!ROLE_PERMISSIONS[role] && role !== 'engineer';
}

/**
 * 权限判定
 * @param {object} user JWT 载荷（需含 role）
 * @param {string} perm 权限点
 */
function can(user, perm) {
  if (!user || !user.role) return false;
  const list = ROLE_PERMISSIONS[user.role];
  if (!list) return false;
  return list.includes('*') || list.includes(perm);
}

/** 任一权限即可 */
function canAny(user, perms) {
  return (perms || []).some(p => can(user, p));
}

/** Express 中间件：要求指定权限 */
function requirePermission(perm) {
  return (req, res, next) => {
    if (!can(req.user, perm)) {
      return res.status(403).json({ success: false, message: '权限不足：需要 ' + perm });
    }
    next();
  };
}

/** 角色合法性校验（用户创建 / 修改时用） */
function isValidRole(role) {
  return ROLES.includes(role);
}

module.exports = {
  PERMISSIONS, ROLES, ROLE_PERMISSIONS,
  permissionsOf, isManager, can, canAny, requirePermission, isValidRole,
};
