/**
 * 任务访问校验（租户 + 归属）
 * 从 routes/tasks.js 抽出，供 tasks / dispatch / alerts 共用，避免多套 404 语义漂移。
 *
 * - 跨租户一律按 404 处理（不泄露任务存在性）
 * - ownerOnly=true 时仅「接单人本人」或 admin 可操作
 * - statusOnly=true 时只要求任务处于指定状态，不校验归属（用于「接单前谁都能看」的场景）
 *
 * 提示语顺序：先判状态，再判归属。未接单的任务 assignee 为空，若先判归属会给出
 * 「无权限」这种误导性提示——工程师真正需要知道的是「这单还没人接」。
 */
const queue = require('../services/queueService');

/**
 * @param {Object} req
 * @param {Object} res
 * @param {number} id 任务 id
 * @param {Object} opts { ownerOnly, requireStatus: string[] }
 */
async function assertTaskAccess(req, res, id, { ownerOnly = false, requireStatus = null } = {}) {
  const task = await queue.getTask(id);
  if (!task) return { error: res.status(404).json({ success: false, message: '任务不存在' }) };
  if (task.tenant_id !== req.tenant_id) return { error: res.status(404).json({ success: false, message: '任务不存在' }) };

  // 状态前置：状态不符时给出可执行的提示，而不是含糊的权限错误
  if (requireStatus && !requireStatus.includes(task.status)) {
    const hint = task.status === 'pending' && !task.assignee_id
      ? '请先接单再操作'
      : `当前状态 ${task.status} 不可执行此操作`;
    return { error: res.status(400).json({ success: false, message: hint }), task };
  }

  if (ownerOnly) {
    const isAdmin = req.user.role === 'admin';
    const isAssignee = task.assignee_id === req.user.id;
    if (!isAdmin && !isAssignee) {
      const msg = !task.assignee_id
        ? '该任务尚未被接单，请先接单'
        : '无权限操作该任务（仅接单人本人或管理员可操作）';
      return { error: res.status(403).json({ success: false, message: msg }), task };
    }
  }
  return { task };
}

module.exports = { assertTaskAccess };
