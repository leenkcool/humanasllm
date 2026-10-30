/**
 * 任务访问校验（租户 + 归属）
 * 从 routes/tasks.js 抽出，供 tasks / dispatch / alerts 共用，避免多套 404 语义漂移。
 *
 * - 跨租户一律按 404 处理（不泄露任务存在性）
 * - ownerOnly=true 时仅「接单人本人」或 admin 可操作
 */
const queue = require('../services/queueService');

async function assertTaskAccess(req, res, id, { ownerOnly = false } = {}) {
  const task = await queue.getTask(id);
  if (!task) return { error: res.status(404).json({ success: false, message: '任务不存在' }) };
  if (task.tenant_id !== req.tenant_id) return { error: res.status(404).json({ success: false, message: '任务不存在' }) };
  if (ownerOnly) {
    const isAdmin = req.user.role === 'admin';
    const isAssignee = task.assignee_id === req.user.id;
    if (!isAdmin && !isAssignee) return { error: res.status(403).json({ success: false, message: '无权限操作该任务' }) };
  }
  return { task };
}

module.exports = { assertTaskAccess };
