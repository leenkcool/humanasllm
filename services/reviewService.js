/**
 * 答复审核服务（质量分层）
 *
 * 用户已确认：单人审核。分级差异化：
 *   general       免审，直接 delivered
 *   ops           单人审核（同级工程师或 admin 均可审）
 *   confidential  单人审核 + admin 抽检（抽检不阻塞放行）
 *
 * 答复状态机（独立于任务状态机，任务仍是 completed）：
 *   draft → reviewed → delivered
 *         ↘ needs_revision（退回工程师，任务状态不变）
 *
 * 评分四维（1-5）：完整性 / 准确性 / 可操作性 / 边界说明，加权总分落 task_logs（已有哈希链防篡改）。
 */
const { getDb } = require('../db');
const { rows } = require('./queueService');

const STATUS = {
  DRAFT: 'draft',
  REVIEWED: 'reviewed',
  DELIVERED: 'delivered',
  NEEDS_REVISION: 'needs_revision',
  SPOT_CHECKED: 'spot_checked',
};

/** 各分级是否需要审核 */
const REVIEW_REQUIRED = { general: false, ops: true, confidential: true };
/** 需要 admin 抽检的分级 */
const SPOT_CHECK_REQUIRED = { confidential: true };

const SCORE_FIELDS = ['completeness', 'accuracy', 'actionable', 'boundary'];

function requiresReview(category) {
  return !!REVIEW_REQUIRED[category || 'general'];
}

function needsSpotCheck(category) {
  return !!SPOT_CHECK_REQUIRED[category || 'general'];
}

/** 加权总分（四维等权，保留两位） */
function totalScore(scores) {
  const vals = SCORE_FIELDS.map(k => parseInt(scores && scores[k], 10)).filter(v => Number.isFinite(v));
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return Math.round((sum / vals.length) * 100) / 100;
}

/** 任务完成后创建审核记录（幂等）；免审分级直接 delivered */
async function onCreate(task) {
  const existing = await getByTask(task.id);
  if (existing) return existing;
  const needed = requiresReview(task.category);
  const status = needed ? STATUS.DRAFT : STATUS.DELIVERED;
  await getDb().run(
    `INSERT INTO task_reviews (task_id, status, reviewed_at)
     VALUES (?, ?, ${needed ? 'NULL' : 'NOW()'})
     ON CONFLICT (task_id) DO NOTHING`,
    [task.id, status]);
  return getByTask(task.id);
}

async function getByTask(taskId) {
  return rows(await getDb().exec('SELECT * FROM task_reviews WHERE task_id = ?', [taskId]))[0] || null;
}

/** 上游可见的答复状态：未放行时返回 reviewing */
function upstreamStatus(review) {
  if (!review) return null;
  if (review.status === STATUS.DELIVERED || review.status === STATUS.SPOT_CHECKED) return 'delivered';
  if (review.status === STATUS.REVIEWED) return 'reviewed';
  if (review.status === STATUS.NEEDS_REVISION) return 'needs_revision';
  return 'reviewing';
}

/** 审核通过（单人）：draft/needs_revision → reviewed → delivered */
async function approve({ taskId, actor, scores, note, tenantId }) {
  const rev = await getByTask(taskId);
  if (!rev) return { ok: false, message: '该任务没有待审核的答复' };
  if (rev.status === STATUS.DELIVERED || rev.status === STATUS.SPOT_CHECKED) {
    return { ok: false, message: '该答复已放行，无需重复审核' };
  }
  if (rev.reviewer_id && rev.reviewer_id === actor.id) {
    return { ok: false, message: '不能审核自己提交的答复' };
  }
  const total = totalScore(scores);
  const name = actor.name || actor.username;
  await getDb().run(
    `UPDATE task_reviews
        SET status = ?, reviewer_id = ?, reviewer_name = ?,
            score_completeness = ?, score_accuracy = ?, score_actionable = ?, score_boundary = ?,
            score_total = ?, note = ?, reviewed_at = NOW(), updated_at = NOW()
      WHERE task_id = ?`,
    [STATUS.DELIVERED, actor.id, name,
      scores && scores.completeness != null ? parseInt(scores.completeness, 10) : null,
      scores && scores.accuracy != null ? parseInt(scores.accuracy, 10) : null,
      scores && scores.actionable != null ? parseInt(scores.actionable, 10) : null,
      scores && scores.boundary != null ? parseInt(scores.boundary, 10) : null,
      total, note || null, taskId]);
  // 审核留痕进审计哈希链
  const queue = require('./queueService');
  await queue.addLog(taskId, 'review', { status: rev.status },
    { status: STATUS.DELIVERED, score_total: total, reviewer: name },
    actor, note || '审核通过，答复放行').catch(() => {});
  return { ok: true, status: STATUS.DELIVERED, score_total: total };
}

/** 审核不通过 → needs_revision（任务状态不变） */
async function requestRevision({ taskId, actor, reason, tenantId }) {
  const rev = await getByTask(taskId);
  if (!rev) return { ok: false, message: '该任务没有待审核的答复' };
  if (!reason || !String(reason).trim()) return { ok: false, message: '请填写退回原因' };
  const name = actor.name || actor.username;
  await getDb().run(
    `UPDATE task_reviews
        SET status = ?, reviewer_id = ?, reviewer_name = ?, revision_note = ?, updated_at = NOW()
      WHERE task_id = ?`,
    [STATUS.NEEDS_REVISION, actor.id, name, String(reason).trim(), taskId]);
  const queue = require('./queueService');
  await queue.addLog(taskId, 'review', { status: rev.status },
    { status: STATUS.NEEDS_REVISION, reason: String(reason).trim() }, actor, '审核退回，需修改答复').catch(() => {});
  return { ok: true, status: STATUS.NEEDS_REVISION };
}

/** 重新提交（工程师改完后）→ 回到 draft 等待审核 */
async function resubmit({ taskId }) {
  await getDb().run(
    `UPDATE task_reviews SET status = ?, updated_at = NOW() WHERE task_id = ? AND status = ?`,
    [STATUS.DRAFT, taskId, STATUS.NEEDS_REVISION]);
  return { ok: true };
}

/** admin 抽检（对已放行的 confidential 答复） */
async function spotCheck({ taskId, actor, pass, note }) {
  const rev = await getByTask(taskId);
  if (!rev) return { ok: false, message: '审核记录不存在' };
  if (rev.status !== STATUS.DELIVERED && rev.status !== STATUS.REVIEWED) {
    return { ok: false, message: '仅已放行的答复可抽检' };
  }
  const name = actor.name || actor.username;
  await getDb().run(
    `UPDATE task_reviews
        SET status = ?, note = COALESCE(note, '') || ?::text, updated_at = NOW()
      WHERE task_id = ?`,
    [pass ? STATUS.SPOT_CHECKED : STATUS.NEEDS_REVISION,
      `\n[抽检 ${pass ? '通过' : '不通过'} by ${name}] ${note || ''}`, taskId]);
  const queue = require('./queueService');
  await queue.addLog(taskId, 'review', { status: rev.status },
    { status: pass ? STATUS.SPOT_CHECKED : STATUS.NEEDS_REVISION, spot_check: true },
    actor, `抽检${pass ? '通过' : '不通过'}：${note || ''}`).catch(() => {});
  return { ok: true, status: pass ? STATUS.SPOT_CHECKED : STATUS.NEEDS_REVISION };
}

/** 待审核队列 */
async function listPending({ tenantId, page = 1, size = 20 }) {
  const db = getDb();
  const base = `FROM task_reviews r JOIN tasks t ON r.task_id = t.id
    WHERE t.tenant_id = ? AND r.status IN ('draft', 'needs_revision')`;
  const total = parseInt(rows(await db.exec(`SELECT COUNT(*) AS c ${base}`, [tenantId || null]))[0].c, 10) || 0;
  const data = rows(await db.exec(
    `SELECT r.*, t.category, t.priority, t.project_code, t.result_text, t.assignee_id
       ${base}
      ORDER BY r.updated_at ASC LIMIT ? OFFSET ?`,
    [tenantId || null, size, (Math.max(1, page) - 1) * size]));
  return { data, total, page, size };
}

/** 待抽检队列（已放行的 confidential） */
async function listSpotCheck({ tenantId, limit = 20 }) {
  return rows(await getDb().exec(
    `SELECT r.*, t.category, t.priority, t.result_text
       FROM task_reviews r JOIN tasks t ON r.task_id = t.id
      WHERE t.tenant_id = ? AND t.category = 'confidential' AND r.status = 'delivered'
      ORDER BY r.reviewed_at ASC LIMIT ?`,
    [tenantId || null, limit]));
}

/** 审核统计（治理页用） */
async function stats({ tenantId }) {
  const r = rows(await getDb().exec(
    `SELECT
       COUNT(*) FILTER (WHERE r.status = 'delivered') AS delivered,
       COUNT(*) FILTER (WHERE r.status = 'draft') AS pending,
       COUNT(*) FILTER (WHERE r.status = 'needs_revision') AS revision,
       COUNT(*) FILTER (WHERE r.status = 'spot_checked') AS spot_checked,
       AVG(r.score_total) AS avg_score
     FROM task_reviews r JOIN tasks t ON r.task_id = t.id
     WHERE t.tenant_id = ?`, [tenantId || null]))[0] || {};
  return {
    delivered: parseInt(r.delivered, 10) || 0,
    pending: parseInt(r.pending, 10) || 0,
    revision: parseInt(r.revision, 10) || 0,
    spot_checked: parseInt(r.spot_checked, 10) || 0,
    avg_score: r.avg_score != null ? Math.round(parseFloat(r.avg_score) * 100) / 100 : null,
  };
}

module.exports = {
  STATUS, SCORE_FIELDS, requiresReview, needsSpotCheck, totalScore,
  onCreate, getByTask, upstreamStatus, approve, requestRevision, resubmit,
  spotCheck, listPending, listSpotCheck, stats,
};
