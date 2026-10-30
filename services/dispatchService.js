/**
 * 智能派单服务（技能匹配 + 负载均衡 + 历史质量）
 *
 * 只做「建议」与「显式派单」，不改变默认的人工 claim 语义：
 *  - rankEngineers/suggest：只读，返回候选人排序与打分理由
 *  - assign：复用 queueService.claimTask，走同一状态机与审计哈希链（不新增流转路径）
 *
 * 打分（满分 100）：0.50 技能匹配 + 0.30 空闲负载 + 0.20 历史一次通过率
 */
const { getDb } = require('../db');
const queue = require('./queueService');
const { normalizeSkills } = require('./templateService');

const { rows } = queue;

const WEIGHTS = { skill: 0.5, load: 0.3, quality: 0.2 };
const DEFAULT_LOAD_CAP = 5;
/** 无历史时给新人 0.7 分：既不埋没新人，也不让老手因样本少而虚高 */
const NO_HISTORY_QUALITY = 0.7;
/** 任务无技能要求时全员同分（不因技能维度拉开差距） */
const NO_SKILL_TASK_RATIO = 0.5;

function loadCap() {
  const v = parseInt(process.env.DISPATCH_LOAD_CAP, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_LOAD_CAP;
}

function enabled() {
  return process.env.DISPATCH_ENABLED !== 'false';
}

/** 技能匹配比例（任务无技能要求 → 中性分，避免按技能误判） */
function skillRatio(taskSkills, userSkills) {
  const need = normalizeSkills(taskSkills);
  if (!need.length) return NO_SKILL_TASK_RATIO;
  const have = new Set(normalizeSkills(userSkills));
  const matched = need.filter(s => have.has(s)).length;
  return matched / need.length;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * 纯打分函数（便于单测与调参）
 * @param {Object} c 候选人 { skills, active_count, completed, reopened }
 * @param {Object} task 任务 { skills }
 */
function scoreCandidate(c, task) {
  const need = normalizeSkills(task.skills);
  const sRatio = skillRatio(task.skills, c.skills);
  const active = parseInt(c.active_count) || 0;
  const lScore = clamp(1 - active / loadCap(), 0, 1);
  const completed = parseInt(c.completed) || 0;
  const reopened = parseInt(c.reopened) || 0;
  const passRate = completed > 0 ? Math.max(0, 1 - reopened / completed) : null;
  const qScore = passRate == null ? NO_HISTORY_QUALITY : passRate;

  const score = Math.round(100 * (WEIGHTS.skill * sRatio + WEIGHTS.load * lScore + WEIGHTS.quality * qScore));

  const matched = need.length ? need.filter(s => new Set(normalizeSkills(c.skills)).has(s)).length : 0;
  const reasons = [];
  if (need.length) reasons.push(`技能匹配 ${matched}/${need.length}`);
  else reasons.push('任务无技能要求');
  reasons.push(`进行中 ${active}/${loadCap()}`);
  reasons.push(passRate == null ? '暂无历史（按 70% 计）' : `一次通过率 ${Math.round(passRate * 100)}% (${completed - reopened}/${completed})`);

  return {
    score, skill_ratio: Math.round(sRatio * 100) / 100,
    load_score: Math.round(lScore * 100) / 100, quality_score: Math.round(qScore * 100) / 100,
    active_count: active, completed, reopened,
    pass_rate: passRate == null ? null : Math.round(passRate * 1000) / 10,
    matched_skills: matched, required_skills: need.length,
    reasons,
  };
}

/** 候选查询：一次 SQL 聚合技能/负载/质量 */
async function listCandidates({ tenantId }) {
  return rows(await getDb().exec(
    `SELECT u.id, u.username, u.name, u.skills,
            COUNT(t.id) FILTER (WHERE t.status = 'processing') AS active_count,
            COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed,
            (SELECT COUNT(*) FROM task_logs l JOIN tasks tt ON l.task_id = tt.id
              WHERE l.action = 'reopen' AND tt.assignee_id = u.id) AS reopened
       FROM users u
       LEFT JOIN tasks t ON t.assignee_id = u.id
      WHERE u.role = 'engineer' AND u.is_active = true AND u.tenant_id = ?
      GROUP BY u.id, u.username, u.name, u.skills
      ORDER BY u.id`,
    [tenantId || null]));
}

/** 排序：分数 desc → 负载 asc → 完成数 desc → id asc（确定性，便于测试） */
function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.active_count !== b.active_count) return a.active_count - b.active_count;
  if (b.completed !== a.completed) return b.completed - a.completed;
  return a.user_id - b.user_id;
}

/** 计算任务候选人排序（不落库） */
async function rankEngineers(task, { limit = 5 } = {}) {
  if (!task) return [];
  const cands = await listCandidates({ tenantId: task.tenant_id });
  const ranked = cands.map(c => {
    const s = scoreCandidate(c, task);
    return {
      user_id: c.id, username: c.username, name: c.name || c.username, skills: c.skills || null,
      ...s,
    };
  }).sort(compareCandidates);
  return ranked.slice(0, Math.max(1, Math.min(50, limit)));
}

/** 派单建议（只读） */
async function suggest({ taskId, limit = 5 }) {
  const task = await queue.getTask(taskId);
  if (!task) return { ok: false, status: 404, message: '任务不存在' };
  const assignable = ['pending', 'returned'].includes(task.status);
  const candidates = await rankEngineers(task, { limit });
  return {
    ok: true,
    data: {
      task_id: task.id,
      status: task.status,
      assignable,
      required_skills: normalizeSkills(task.skills),
      candidates,
      recommended: candidates[0] || null,
    },
  };
}

/**
 * 派单：指定 user_id 或在候选集内取第一名
 * dryRun=true 只返回建议，不改状态
 */
async function assign({ taskId, actor, userId, dryRun = false }) {
  if (!enabled()) return { ok: false, status: 403, message: '智能派单未启用' };
  const task = await queue.getTask(taskId);
  if (!task) return { ok: false, status: 404, message: '任务不存在' };
  if (!['pending', 'returned'].includes(task.status)) {
    return { ok: false, status: 409, message: `当前状态 ${task.status} 不可派单` };
  }
  const ranked = await rankEngineers(task, { limit: 50 });
  if (!ranked.length) return { ok: false, status: 409, message: '当前租户没有可派单的工程师' };

  let pick = null;
  if (userId !== undefined && userId !== null) {
    pick = ranked.find(c => c.user_id === parseInt(userId));
    if (!pick) return { ok: false, status: 400, message: '指定工程师不在本租户候选集内' };
  } else {
    pick = ranked[0];
  }

  if (dryRun) {
    return { ok: true, dry_run: true, data: { task_id: task.id, assignee: pick, would_assign: true } };
  }

  const r = await queue.claimTask(task.id, pick.user_id, pick.name);
  if (!r.ok) return { ok: false, status: 409, message: r.message };

  // 审计：在哈希链里留下派单依据（claim 本身已有一条 processing 日志）
  await queue.addLog(task.id, 'dispatch',
    { assignee_id: null },
    { assignee_id: pick.user_id, score: pick.score, reasons: pick.reasons },
    actor || null, '智能派单');

  return {
    ok: true,
    data: {
      task: r.task,
      assignee: { id: pick.user_id, name: pick.name, username: pick.username },
      score: pick.score, reasons: pick.reasons, ranking: ranked.slice(0, 5),
    },
  };
}

/** 工程师负载概览（管理员视图） */
async function workload({ tenantId }) {
  const cands = await listCandidates({ tenantId });
  return cands.map(c => {
    const completed = parseInt(c.completed) || 0;
    const reopened = parseInt(c.reopened) || 0;
    return {
      user_id: c.id, name: c.name || c.username, username: c.username, skills: c.skills || null,
      active_count: parseInt(c.active_count) || 0, completed, reopened,
      pass_rate: completed > 0 ? Math.max(0, Math.round((1 - reopened / completed) * 1000) / 10) : null,
      load_cap: loadCap(),
    };
  }).sort((a, b) => b.active_count - a.active_count);
}

module.exports = {
  WEIGHTS, DEFAULT_LOAD_CAP, NO_HISTORY_QUALITY, NO_SKILL_TASK_RATIO,
  enabled, loadCap, skillRatio, scoreCandidate, compareCandidates,
  listCandidates, rankEngineers, suggest, assign, workload,
};
