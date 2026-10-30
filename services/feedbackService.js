/**
 * 答复效果回流服务
 *
 * 上游收到答复后回传「是否解决问题」，这是数据飞轮的第一环：
 *   - resolved=false 且任务在 7 天内 → 自动重开为同一会话的追问（复用多轮追问）
 *   - 工作台展示有效率指标（按分级 / 工程师 / 知识库来源拆分）
 */
const { getDb } = require('../db');
const { rows } = require('./queueService');

const RECENT_DAYS = 7;

/** 记录反馈（幂等：同一任务只保留最新一条） */
async function record({ taskId, resolved, rating, comment, reporter }) {
  if (typeof resolved !== 'boolean') return { ok: false, message: 'resolved 必须是布尔值' };
  const r = parseInt(rating, 10);
  const rate = Number.isFinite(r) ? Math.min(5, Math.max(1, r)) : null;
  await getDb().run(
    `INSERT INTO task_feedback (task_id, resolved, rating, comment, reporter)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE
       SET resolved = EXCLUDED.resolved, rating = EXCLUDED.rating,
           comment = EXCLUDED.comment, reporter = EXCLUDED.reporter,
           created_at = NOW()`,
    [taskId, resolved, rate, comment || null, reporter || null]);
  return { ok: true };
}

async function getByTask(taskId) {
  return rows(await getDb().exec('SELECT * FROM task_feedback WHERE task_id = ?', [taskId]))[0] || null;
}

/**
 * 未解决的反馈是否应触发重开
 * 条件：resolved=false + 任务已完成 + 在 RECENT_DAYS 天内 + 没有后续轮次
 */
async function shouldReopen(task) {
  if (!task || task.status !== 'completed') return false;
  const fb = await getByTask(task.id);
  if (!fb || fb.resolved) return false;
  const created = new Date(task.completed_at || task.created_at).getTime();
  if (Date.now() - created > RECENT_DAYS * 24 * 3600 * 1000) return false;
  if (task.conversation_id) {
    // 已有后续轮次则不再重复重开
    const next = rows(await getDb().exec(
      'SELECT id FROM tasks WHERE conversation_id = ? AND turn_index > ? LIMIT 1',
      [task.conversation_id, parseInt(task.turn_index, 10) || 0]))[0];
    if (next) return false;
  }
  return true;
}

/** 有效率统计（工作台治理用） */
async function stats({ tenantId }) {
  const db = getDb();
  const base = `FROM task_feedback f JOIN tasks t ON f.task_id = t.id WHERE t.tenant_id = ?`;
  const overall = rows(await db.exec(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE f.resolved) AS resolved,
            AVG(f.rating) AS avg_rating
       ${base}`, [tenantId || null]))[0] || {};
  const byCategory = rows(await db.exec(
    `SELECT t.category,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE f.resolved) AS resolved
       ${base} GROUP BY t.category`, [tenantId || null]));
  const byAssignee = rows(await db.exec(
    `SELECT COALESCE(u.name, u.username, '未指派') AS name,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE f.resolved) AS resolved
       FROM task_feedback f
       JOIN tasks t ON f.task_id = t.id
       LEFT JOIN users u ON t.assignee_id = u.id
      WHERE t.tenant_id = ?
      GROUP BY u.name, u.username ORDER BY COUNT(*) DESC LIMIT 10`, [tenantId || null]));
  const total = parseInt(overall.total, 10) || 0;
  const resolved = parseInt(overall.resolved, 10) || 0;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    total, resolved,
    rate: pct(resolved, total),
    avg_rating: overall.avg_rating != null ? Math.round(parseFloat(overall.avg_rating) * 10) / 10 : null,
    by_category: byCategory.map(r => ({
      category: r.category, total: parseInt(r.total, 10) || 0,
      resolved: parseInt(r.resolved, 10) || 0,
      rate: pct(parseInt(r.resolved, 10) || 0, parseInt(r.total, 10) || 0),
    })),
    by_assignee: byAssignee.map(r => ({
      name: r.name, total: parseInt(r.total, 10) || 0,
      resolved: parseInt(r.resolved, 10) || 0,
      rate: pct(parseInt(r.resolved, 10) || 0, parseInt(r.total, 10) || 0),
    })),
  };
}

module.exports = { RECENT_DAYS, record, getByTask, shouldReopen, stats };
