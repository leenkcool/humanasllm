/**
 * 超时告警升级序列服务（SLA 预警 → 违约 → 驳回滞留 → 审批超时）
 *
 * 五级告警：
 *   L1 sla_warn       pending/processing 已用 SLA >= 50%        → 处理人（未指派则 admin）
 *   L2 sla_warn       pending/processing 已用 SLA >= 80%        → admin（邮件/webhook）
 *   L3 sla_breach     queueService.timeoutTask 真正超时归还之后  → admin + 全站广播
 *   L4 return_stale   returned 滞留 >= ESCALATE_INTERVAL_MIN     → admin
 *   L5 return_stale   returned 滞留 >= 2 * ESCALATE_INTERVAL_MIN → admin + 全站广播
 *
 * 去重：tasks.escalation_level 单调递增，靠原子 `UPDATE ... WHERE escalation_level < ? RETURNING`
 * 抢占级别 —— 只有 RETURNING 有行才落 alerts 表并推送，并发/多实例下同一级别只会成功一次。
 * 注意：升级 UPDATE 绝不更新 updated_at，否则 return_stale（按 updated_at 计时）会自己重置自己。
 * 降级安全：ws / notifier / mailer 全 try-catch，失败只记日志，绝不打断 60s 扫描循环。
 * 依赖方向：本服务不 require queueService（queueService 反向调用 recordBreach），避免循环依赖。
 */
require('dotenv').config();
const { getDb } = require('../db');
const ws = require('./websocket');
const notifier = require('./notifier');
const { sendMail } = require('./mailer');

/** pg 结果集 → 对象数组（本库惯例：各服务本地定义，避免跨模块循环依赖） */
function rows(result) {
  if (!result || !result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

// ===== 级别定义 =====
const LEVEL_WARN = 1;             // SLA 过半
const LEVEL_CRITICAL = 2;         // SLA 临近超时
const LEVEL_BREACH = 3;           // 已超时归还
const LEVEL_RETURN_WARN = 4;      // 驳回滞留
const LEVEL_RETURN_CRITICAL = 5;  // 驳回严重滞留
const MAX_LEVEL = 5;

/** 级别定义表（有序，level 字段可直查） */
const LEVELS = Object.freeze([
  { level: LEVEL_WARN, kind: 'sla_warn', name: 'SLA 过半预警', audience: 'assignee_or_admin' },
  { level: LEVEL_CRITICAL, kind: 'sla_warn', name: 'SLA 临近超时', audience: 'admin' },
  { level: LEVEL_BREACH, kind: 'sla_breach', name: 'SLA 已超时', audience: 'admin_broadcast' },
  { level: LEVEL_RETURN_WARN, kind: 'return_stale', name: '驳回滞留', audience: 'admin' },
  { level: LEVEL_RETURN_CRITICAL, kind: 'return_stale', name: '驳回严重滞留', audience: 'admin_broadcast' },
]);

/** SLA 预警阈值（已用比例） */
const WARN_RATIO = 0.5;
const CRITICAL_RATIO = 0.8;

const WORKBENCH_URL = process.env.WORKBENCH_URL || 'http://192.168.168.3:39000/login.html';

function levelDef(level) {
  return LEVELS.find(l => l.level === level) || null;
}

/** 正整数环境变量读取（非法/缺省回退默认值） */
function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** 驳回滞留升级间隔（分钟），默认 30 */
function escalateIntervalMin() {
  return envInt('ESCALATE_INTERVAL_MIN', 30);
}

/** 审批待办超时提醒间隔（小时），默认 24 */
function approvalOverdueHours() {
  return envInt('APPROVAL_OVERDUE_HOURS', 24);
}

/** 对外暴露的当前阈值配置（便于工作台展示 / 测试断言） */
function levelsConfig() {
  return {
    warn_ratio: WARN_RATIO,
    critical_ratio: CRITICAL_RATIO,
    return_stale_min: escalateIntervalMin(),
    approval_overdue_hours: approvalOverdueHours(),
  };
}

// ===== 时间工具 =====
function toMs(v) {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function nowMs(now) {
  const t = toMs(now);
  return t == null ? Date.now() : t;
}

/**
 * SLA 起点（毫秒戳）：claimed_at / created_at / updated_at 取最晚
 * 等价 SQL：GREATEST(COALESCE(claimed_at, created_at), updated_at)
 * @returns {number|null}
 */
function slaStart(task) {
  if (!task) return null;
  const ts = [toMs(task.claimed_at), toMs(task.created_at), toMs(task.updated_at)].filter(v => v != null);
  return ts.length ? Math.max(...ts) : null;
}

/** SLA 进度：{ ratio, remainingMin }，无法计算（无 timeout_at / 窗口非法）返回 null */
function slaProgress(task, now) {
  const start = slaStart(task);
  const end = toMs(task.timeout_at);
  if (start == null || end == null || end <= start) return null;
  const ms = nowMs(now);
  return { ratio: (ms - start) / (end - start), remainingMin: Math.round((end - ms) / 60000) };
}

/**
 * 计算任务当前应处的级别（纯函数，不考虑历史 escalation_level）
 * @param {Object} task 任务快照（status/timeout_at/created_at/claimed_at/updated_at）
 * @param {Date|number} [now]
 * @returns {number} 0 表示无需告警
 */
function computeLevel(task, now) {
  if (!task) return 0;
  if (task.status === 'pending' || task.status === 'processing') {
    const p = slaProgress(task, now);
    if (!p) return 0;
    if (p.ratio >= CRITICAL_RATIO) return LEVEL_CRITICAL;
    if (p.ratio >= WARN_RATIO) return LEVEL_WARN;
    return 0;
  }
  if (task.status === 'returned') {
    const since = toMs(task.updated_at);
    if (since == null) return 0;
    const mins = (nowMs(now) - since) / 60000;
    const interval = escalateIntervalMin();
    if (mins >= 2 * interval) return LEVEL_RETURN_CRITICAL;
    if (mins >= interval) return LEVEL_RETURN_WARN;
    return 0;
  }
  return 0;
}

function buildTitle(level, task) {
  const id = task.id;
  switch (level) {
    case LEVEL_WARN: return `SLA 过半预警：任务 #${id}`;
    case LEVEL_CRITICAL: return `SLA 临近超时：任务 #${id}`;
    case LEVEL_BREACH: return `SLA 已超时：任务 #${id}`;
    case LEVEL_RETURN_WARN: return `驳回任务滞留：任务 #${id}`;
    default: return `驳回任务严重滞留：任务 #${id}`;
  }
}

function buildDetail(level, task, now) {
  const base = `状态 ${task.status} / 优先级 ${task.priority || 'medium'} / 类别 ${task.category || 'general'}`;
  if (level <= LEVEL_CRITICAL) {
    const p = slaProgress(task, now);
    if (!p) return base;
    const left = p.remainingMin > 0 ? `剩余约 ${p.remainingMin} 分钟` : '已到超时时间';
    return `SLA 已用 ${Math.round(p.ratio * 100)}%，${left}（${base}）`;
  }
  if (level === LEVEL_BREACH) return `处理超时已自动归还，需重新派发（${base}）`;
  const since = Math.round((nowMs(now) - (toMs(task.updated_at) || nowMs(now))) / 60000);
  return `驳回后已滞留约 ${since} 分钟未重派（${base}）`;
}

/**
 * 给定任务快照 + 当前时间 → 应升级到的告警
 * 已发过的级别（escalation_level >= 目标级别）返回 null
 * @returns {{level:number, kind:string, title:string, detail:string}|null}
 */
function planEscalation(task, now) {
  if (!task) return null;
  const level = computeLevel(task, now);
  if (!level) return null;
  const cur = parseInt(task.escalation_level, 10) || 0;
  if (level <= cur) return null;
  const def = levelDef(level);
  if (!def) return null;
  return { level, kind: def.kind, title: buildTitle(level, task), detail: buildDetail(level, task, now) };
}

// ===== 数据访问 =====
const TASK_SNAPSHOT_COLS = `id, assignee_id, status, priority, category, tenant_id,
  timeout_at, created_at, claimed_at, updated_at, escalation_level, last_reminded_at`;

async function fetchTask(id) {
  const r = rows(await getDb().exec(`SELECT ${TASK_SNAPSHOT_COLS} FROM tasks WHERE id = ?`, [parseInt(id, 10)]));
  return r[0] || null;
}

/**
 * 原子抢占级别：只有 escalation_level < level 才会更新成功
 * 绝不更新 updated_at（return_stale 依赖它计时）
 * @param {number} taskId
 * @param {number} level 目标级别
 * @param {string|null} expectStatus 可选状态守卫（扫描期间状态已流转则放弃本次升级）
 * @returns {Promise<Object|null>} 升级成功返回最新任务快照，否则 null
 */
async function raiseTo(taskId, level, expectStatus) {
  const params = [level, parseInt(taskId, 10), level];
  let sql = `UPDATE tasks
       SET escalation_level = ?, remind_count = remind_count + 1, last_reminded_at = NOW()
     WHERE id = ? AND escalation_level < ?`;
  if (expectStatus) { sql += ' AND status = ?'; params.push(expectStatus); }
  sql += ` RETURNING ${TASK_SNAPSHOT_COLS}`;
  const r = rows(await getDb().exec(sql, params));
  return r[0] || null;
}

/** 写一条告警（alerts 表） */
async function writeAlert({ task_id, approval_id, level, kind, title, detail, tenant_id }) {
  const { lastId } = await getDb().run(
    `INSERT INTO alerts (task_id, approval_id, level, kind, status, title, detail, tenant_id)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [task_id || null, approval_id || null, level, kind, title, detail || null, tenant_id || null]
  );
  return { id: lastId, level, kind, title, detail: detail || null };
}

// ===== 通知（全部降级安全） =====
/** 实时推送：L1 → 处理人（未指派则 admin）；L2/L4 → admin；L3/L5 → admin + 全站广播 */
function pushRealtime(alert, task) {
  const event = alert.level === LEVEL_WARN ? 'alert:new' : 'alert:escalate';
  const payload = { id: alert.id, level: alert.level, kind: alert.kind, title: alert.title, task_id: task.id };
  try {
    if (alert.level === LEVEL_WARN) {
      if (task.assignee_id) ws.notifyUser(task.assignee_id, event, payload);
      else ws.notifyAdmins(event, payload);
      return;
    }
    ws.notifyAdmins(event, payload);
    if (alert.level === LEVEL_BREACH || alert.level === LEVEL_RETURN_CRITICAL) ws.broadcast(event, payload);
  } catch (e) {
    console.error('[告警实时推送失败]', e.message);
  }
}

/** 邮件 / webhook 通知渠道（notifier 未配置时内部自动降级） */
function pushChannels(alert, task) {
  notifier.send({
    event: 'alert:' + alert.kind,
    title: alert.title,
    text: alert.detail || '',
    taskId: task.id,
  }).catch(() => {});
  // L1 直达处理人邮箱（notifier 只发治理收件人，不认人）
  if (alert.level === LEVEL_WARN && task.assignee_id) {
    mailAssignee(task.assignee_id, alert, task).catch(() => {});
  }
}

async function mailAssignee(userId, alert, task) {
  const u = rows(await getDb().exec('SELECT name, username, email FROM users WHERE id = ?', [userId]))[0];
  if (!u || !u.email) return;
  await sendMail({
    to: u.email,
    subject: `[p390] ${alert.title}`,
    text: `${alert.detail || alert.title}\n\n请登录工作台处理: ${WORKBENCH_URL} (task_id: ${task.id})`,
  });
}

// ===== 扫描 =====
/**
 * SLA 窗口是否已重启（上次提醒早于当前 SLA 起点 → 旧级别属于上一轮生命周期，需归零重计）
 * 典型场景：pending 预警后接单 → processing 重新计时；returned 重派 → pending 重新计时。
 * 这条自愈规则让升级序列不依赖 queueService 是否记得复位 escalation_level。
 */
function slaRestarted(task) {
  if (task.status !== 'pending' && task.status !== 'processing') return false;
  const reminded = toMs(task.last_reminded_at);
  const start = slaStart(task);
  if (reminded == null || start == null) return false;
  return reminded < start;
}

/** 归零任务的升级序列（可选同时收起该任务仍然 active 的旧告警） */
async function resetEscalation(taskId, { resolveActive = false } = {}) {
  const id = parseInt(taskId, 10);
  if (!id) return false;
  const r = await getDb().run(
    'UPDATE tasks SET escalation_level = 0, remind_count = 0, last_reminded_at = NULL WHERE id = ?', [id]);
  if (resolveActive) await resolveAlerts(id);
  return r.changes > 0;
}

/**
 * 把任务 active 告警置 resolved
 * @param {number} [taskId] 指定任务；缺省时清扫所有已进入终态（completed/cancelled）任务的 active 告警
 * @returns {Promise<number>} 被解决的告警条数
 */
async function resolveAlerts(taskId) {
  const db = getDb();
  if (taskId) {
    const r = await db.run(
      `UPDATE alerts SET status = 'resolved', resolved_at = NOW() WHERE task_id = ? AND status = 'active'`,
      [parseInt(taskId, 10)]);
    return r.changes || 0;
  }
  const r = await db.run(
    `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
      WHERE status = 'active'
        AND task_id IN (SELECT id FROM tasks WHERE status IN ('completed', 'cancelled'))`);
  return r.changes || 0;
}

/**
 * 单次扫描（可测，不启动定时器）
 * @param {Date|number} [now]
 * @returns {Promise<{escalated:number, resolved:number}>}
 */
async function scanOnce(now) {
  const db = getDb();
  const limit = envInt('ALERT_SCAN_LIMIT', 500);
  let escalated = 0;
  let resolved = 0;

  try {
    // 回溯窗口：只对 ALERT_BACKFILL_DAYS（默认 7）天内创建的任务升级告警，
    // 避免首次启用时把历史积压的整套 returned 任务一次性刷成告警风暴。
    // 设为 0 表示不限制（全量扫描）。
    const backfillDays = envInt('ALERT_BACKFILL_DAYS', 7);
    const backfillSql = backfillDays > 0 ? ` AND created_at > NOW() - interval '${backfillDays} days'` : '';
    const candidates = rows(await db.exec(
      `SELECT ${TASK_SNAPSHOT_COLS} FROM tasks
        WHERE status IN ('pending', 'processing', 'returned')${backfillSql}
          AND (escalation_level < ?
               OR (status IN ('pending', 'processing') AND last_reminded_at IS NOT NULL
                   AND last_reminded_at < GREATEST(COALESCE(claimed_at, created_at), updated_at)))
        ORDER BY COALESCE(last_reminded_at, created_at) ASC, id ASC
        LIMIT ?`, [MAX_LEVEL, limit]));

    for (const task of candidates) {
      try {
        // 自愈：SLA 窗口已重启（接单/重派）→ 级别归零，重新走 L1/L2
        if (slaRestarted(task) && (parseInt(task.escalation_level, 10) || 0) > 0) {
          await db.run('UPDATE tasks SET escalation_level = 0, remind_count = 0, last_reminded_at = NULL WHERE id = ?', [task.id]);
          // 新生命周期开始（接单/重派/恢复）：上一轮的旧告警收起，只看本轮
          await resolveAlerts(task.id);
          task.escalation_level = 0;
          task.last_reminded_at = null;
        }
        const plan = planEscalation(task, now);
        if (!plan) continue;
        // 原子抢占：状态在 SELECT 与 UPDATE 之间变化（如接单）则放弃本次升级
        const updated = await raiseTo(task.id, plan.level, task.status);
        if (!updated) continue;
        const alert = await writeAlert({
          task_id: updated.id,
          level: plan.level,
          kind: plan.kind,
          title: plan.title,
          detail: plan.detail,
          tenant_id: updated.tenant_id,
        });
        pushRealtime(alert, updated);
        pushChannels(alert, updated);
        escalated++;
      } catch (e) {
        console.error('[告警升级失败]', task.id, e.message);
      }
    }
  } catch (e) {
    console.error('[告警扫描失败]', e.message);
  }

  try {
    resolved = await resolveAlerts();
  } catch (e) {
    console.error('[告警自动解决失败]', e.message);
  }
  return { escalated, resolved };
}

/** 启动升级扫描（每 60 秒） */
function startEscalationScanner() {
  setInterval(() => {
    scanOnce().catch(e => console.error('[告警扫描失败]', e.message));
  }, 60000);
}

/**
 * 违约记录：queueService.timeoutTask 真正超时归还（returned）后调用，写 L3 告警
 * @param {Object|number} taskOrId 任务对象（省一次查询）或任务 id
 * @param {{phase?:string}} [extra] phase=pending|processing 超时阶段
 * @returns {Promise<Object|null>} 新告警；已发过（escalation_level >= 3）返回 null
 */
async function recordBreach(taskOrId, extra = {}) {
  try {
    const task = (taskOrId && typeof taskOrId === 'object')
      ? taskOrId
      : await fetchTask(taskOrId);
    if (!task || !task.id) return null;
    const updated = await raiseTo(task.id, LEVEL_BREACH, null);
    if (!updated) return null;
    // 之前的 L1/L2 预警在违约后已过时，一并收起，未处理清单只留最新一条
    await resolveAlerts(updated.id);
    const phase = extra.phase ? `${extra.phase === 'pending' ? '待接单' : '处理中'}超时` : '';
    const alert = await writeAlert({
      task_id: updated.id,
      level: LEVEL_BREACH,
      kind: 'sla_breach',
      title: buildTitle(LEVEL_BREACH, updated),
      detail: phase ? `${phase}自动归还，需重新派发（状态 ${updated.status} / 优先级 ${updated.priority || 'medium'}）`
        : buildDetail(LEVEL_BREACH, updated),
      tenant_id: updated.tenant_id,
    });
    pushRealtime(alert, updated);
    pushChannels(alert, updated);
    return alert;
  } catch (e) {
    console.error('[违约告警写入失败]', e.message);
    return null;
  }
}

/**
 * 审批超时扫描（完整实现，含 24h 去重）
 * 修掉原 startApprovalScanner 每 60 秒无限重复发信的缺陷：
 * last_reminded_at 保证同一审批单每 24h 最多提醒一次。
 * @returns {Promise<{overdue:number}>}
 */
async function scanOverdueApprovals() {
  const db = getDb();
  const h = approvalOverdueHours();
  let overdue = 0;
  try {
    const list = rows(await db.exec(
      `UPDATE approvals SET remind_count = remind_count + 1, last_reminded_at = NOW()
        WHERE status = 'pending'
          AND created_at < NOW() - interval '${h} hours'
          AND (last_reminded_at IS NULL OR last_reminded_at < NOW() - interval '${h} hours')
      RETURNING id, tenant_id, resource, approval_no`));
    for (const a of list) {
      try {
        try { ws.broadcast('approval:overdue', { id: a.id }); } catch (e) { /* io 未就绪则忽略 */ }
        notifier.send({
          event: 'approval:overdue',
          title: `审批超时 #${a.id}`,
          text: `审批单 ${a.approval_no || '#' + a.id}（${a.resource || '资源申请'}）已超 ${h} 小时未处理，请及时审批`,
          taskId: null,
        }).catch(() => {});
        await recordApprovalOverdue(a, h);
        overdue++;
      } catch (e) {
        console.error('[审批超时告警失败]', a.id, e.message);
      }
    }
  } catch (e) {
    console.error('[审批超时扫描失败]', e.message);
  }
  return { overdue };
}

/**
 * 记录审批超时告警（alerts.kind='approval_overdue', level=2，租户随审批单）
 * 同一审批单同时只保留一条 active 告警，避免 24h 提醒反复刷屏
 * @param {Object} approval { id, tenant_id, resource, approval_no }
 * @param {number} [hours]
 */
async function recordApprovalOverdue(approval, hours) {
  const a = approval || {};
  if (!a.id) return null;
  const h = hours || approvalOverdueHours();
  try {
    const dup = rows(await getDb().exec(
      `SELECT id FROM alerts WHERE approval_id = ? AND kind = 'approval_overdue' AND status = 'active' LIMIT 1`,
      [a.id]));
    if (dup.length) return { id: dup[0].id, level: LEVEL_CRITICAL, kind: 'approval_overdue', deduped: true };
    return await writeAlert({
      approval_id: a.id,
      level: LEVEL_CRITICAL,
      kind: 'approval_overdue',
      title: `审批超时：${a.approval_no || '#' + a.id}`,
      detail: `审批单 ${a.approval_no || '#' + a.id}（${a.resource || '资源申请'}）已超 ${h} 小时未处理，请及时审批`,
      tenant_id: a.tenant_id,
    });
  } catch (e) {
    console.error('[审批超时告警写入失败]', e.message);
    return null;
  }
}

/**
 * 解决某审批单的 active 告警（审批已批准/驳回后调用；未接线时由扫描自然过期）
 * @returns {Promise<number>} 被解决的条数
 */
async function resolveApprovalAlerts(approvalId) {
  const id = parseInt(approvalId, 10);
  if (!id) return 0;
  const r = await getDb().run(
    `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
      WHERE approval_id = ? AND status IN ('active', 'acked')`, [id]);
  return r.changes || 0;
}

// ===== 告警列表 / 统计 / 处理（供 routes/alerts.js 使用） =====
/** 单条告警（含任务状态与处理人，租户隔离；跨租户返回 null） */
async function getAlert(id, tenantId) {
  const list = rows(await getDb().exec(
    `SELECT a.*, t.status AS task_status, t.priority AS task_priority,
            t.assignee_id AS task_assignee_id, u.name AS assignee_name
       FROM alerts a
       LEFT JOIN tasks t ON a.task_id = t.id
       LEFT JOIN users u ON t.assignee_id = u.id
      WHERE a.id = ? AND a.tenant_id = ?`,
    [parseInt(id, 10), tenantId]));
  return list[0] || null;
}

/**
 * 告警列表（当前租户）
 * @param {Object} opts { tenantId, status='active'|'acked'|'resolved'|'all', level, kind, taskId, page, size }
 */
async function listAlerts({ tenantId, status = 'active', level, kind, taskId, page = 1, size = 20 } = {}) {
  const db = getDb();
  const p = Math.max(1, parseInt(page, 10) || 1);
  const s = Math.min(100, Math.max(1, parseInt(size, 10) || 20));
  const where = ['a.tenant_id = ?'];
  const params = [tenantId];
  if (status && status !== 'all') { where.push('a.status = ?'); params.push(status); }
  if (level !== undefined && level !== null && level !== '') {
    const lv = parseInt(level, 10);
    if (lv >= 1 && lv <= MAX_LEVEL) { where.push('a.level = ?'); params.push(lv); }
  }
  if (kind) { where.push('a.kind = ?'); params.push(kind); }
  if (taskId) { where.push('a.task_id = ?'); params.push(parseInt(taskId, 10)); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const countR = await db.exec(`SELECT COUNT(*) AS c FROM alerts a ${whereSql}`, params);
  const total = parseInt(countR[0].values[0][0], 10) || 0;
  const list = rows(await db.exec(
    `SELECT a.*, t.status AS task_status, t.priority AS task_priority,
            u.name AS assignee_name, au.name AS acked_by_name
       FROM alerts a
       LEFT JOIN tasks t ON a.task_id = t.id
       LEFT JOIN users u ON t.assignee_id = u.id
       LEFT JOIN users au ON a.acked_by = au.id
       ${whereSql}
      ORDER BY a.level DESC, a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [...params, s, (p - 1) * s]));
  return { data: list, total, page: p, size: s };
}

/**
 * 告警统计（当前租户）
 * by_level / by_kind 为 active 告警分布；状态计数为全量
 */
async function alertStats({ tenantId }) {
  const db = getDb();
  const byStatus = rows(await db.exec(
    `SELECT status, COUNT(*) AS c FROM alerts WHERE tenant_id = ? GROUP BY status`, [tenantId]));
  const byLevel = rows(await db.exec(
    `SELECT level, COUNT(*) AS c FROM alerts WHERE tenant_id = ? AND status = 'active' GROUP BY level`, [tenantId]));
  const byKind = rows(await db.exec(
    `SELECT kind, COUNT(*) AS c FROM alerts WHERE tenant_id = ? AND status = 'active' GROUP BY kind`, [tenantId]));
  const oldestR = await db.exec(
    `SELECT MIN(created_at) AS t FROM alerts WHERE tenant_id = ? AND status = 'active'`, [tenantId]);
  const oldest = oldestR[0] && oldestR[0].values[0] ? oldestR[0].values[0][0] : null;

  const stats = {
    active: 0, acked: 0, resolved: 0,
    by_level: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    by_kind: {},
    oldest_active_at: oldest || null,
  };
  for (const r of byStatus) {
    const n = parseInt(r.c, 10) || 0;
    if (r.status === 'active') stats.active = n;
    else if (r.status === 'acked') stats.acked = n;
    else if (r.status === 'resolved') stats.resolved = n;
  }
  for (const r of byLevel) {
    const lv = parseInt(r.level, 10);
    if (lv >= 1 && lv <= MAX_LEVEL) stats.by_level[lv] = parseInt(r.c, 10) || 0;
  }
  for (const r of byKind) stats.by_kind[r.kind] = parseInt(r.c, 10) || 0;
  return stats;
}

/**
 * 确认告警（active → acked）
 * 权限（admin 或任务处理人）由路由层校验
 * @returns {Promise<boolean>} 是否真正更新（false = 告警不存在/已不是 active）
 */
async function ackAlert(id, actor, tenantId) {
  const r = await getDb().run(
    `UPDATE alerts SET status = 'acked', acked_by = ?, acked_at = NOW()
      WHERE id = ? AND tenant_id = ? AND status = 'active'`,
    [actor && actor.id ? actor.id : null, parseInt(id, 10), tenantId]);
  return (r.changes || 0) > 0;
}

/**
 * 解决告警（→ resolved，admin）
 * @returns {Promise<boolean>}
 */
async function resolveAlert(id, actor, tenantId) {
  const r = await getDb().run(
    `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
      WHERE id = ? AND tenant_id = ? AND status <> 'resolved'`,
    [parseInt(id, 10), tenantId]);
  return (r.changes || 0) > 0;
}

module.exports = {
  LEVELS, levelsConfig,
  slaStart, computeLevel, planEscalation,
  scanOnce, startEscalationScanner,
  recordBreach, recordApprovalOverdue, scanOverdueApprovals,
  resolveAlerts, resetEscalation, resolveApprovalAlerts,
  ackAlert, listAlerts, alertStats, resolveAlert, getAlert,
};
