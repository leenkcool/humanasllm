/**
 * 计费计量服务（人力成本可核算 + 租户账单）
 *
 * 计价模型：按任务计费，按「租户 + 分级 + 优先级」配置每分钟人力单价（单位：分，避免浮点误差）。
 *  - 费率层级：租户专属 > 全局默认（tenant_id IS NULL） > 代码常量 DEFAULT_RATES
 *  - 结算时机：任务终态 completed 后入账（扫描器 60s 补结算，也支持手工触发）
 *  - 幂等：billing_ledger 对 task_id 唯一，重复结算不会重复入账
 *  - AI 产出（ai-relay / ai-shift）不计人工费，但流水仍写一条便于审计（amount_cents = 0）
 *
 * 计费规则：
 *  1) 只对 status='completed' 的任务计费；未完成 / 取消 / 驳回一律 0
 *  2) 时长 = completed_at - COALESCE(claimed_at, created_at)，向上取整到 0.5 分钟，最少 0.5 分钟；为负归 0
 *  3) 金额 = max(round(minutes × 单价), 最低消费)
 *  4) 账单期间 period = completed_at 的 YYYY-MM（按完成时间归档）
 *
 * 注意：PG 适配器会把 SQL 里所有 ? 转成 $n，因此这里禁止使用 JSONB 的 ? 运算符。
 */
require('dotenv').config();
const { getDb } = require('../db');
const queue = require('./queueService');

const CATEGORIES = ['general', 'confidential', 'ops'];
const PRIORITIES = ['high', 'medium', 'low'];
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// 默认最低消费：5 元（500 分）起收
const DEFAULT_MIN_CHARGE = 500;

/**
 * 默认费率常量（分/分钟）
 *  - 优先级分档：high 基准，medium = high × 0.8，low = high × 0.6
 *  - 分级加成：general 基准，ops × 1.2，confidential × 1.5
 *  - 基准取 general/high = 500 分（即 5 元/分钟）
 *  推导结果：general 500/400/300；ops 600/480/360；confidential 750/600/450
 */
const DEFAULT_RATES = {
  general: { high: 500, medium: 400, low: 300 },
  ops: { high: 600, medium: 480, low: 360 },
  confidential: { high: 750, medium: 600, low: 450 },
};

// ===== 建表 DDL（幂等；主会话同步进 db/index.js 的 SCHEMA，这里保留一份给测试/独立初始化用）=====
const SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_rates (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER,
  category VARCHAR(20) NOT NULL,
  priority VARCHAR(10) NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  min_charge_cents INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, category, priority)
);

CREATE TABLE IF NOT EXISTS billing_ledger (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  tenant_id INTEGER,
  project_code TEXT,
  category VARCHAR(20),
  priority VARCHAR(10),
  assignee_id INTEGER,
  billable_minutes NUMERIC(10,2) NOT NULL DEFAULT 0,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  min_charge_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(16) NOT NULL DEFAULT 'manual',
  period VARCHAR(7) NOT NULL,
  meta JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (task_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_tenant ON billing_ledger(tenant_id, period);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_period ON billing_ledger(period);
-- PG 的 UNIQUE 不约束 NULL 相等：全局费率行（tenant_id IS NULL）需额外部分唯一索引防重复
CREATE UNIQUE INDEX IF NOT EXISTS uniq_billing_rates_global ON billing_rates(category, priority) WHERE tenant_id IS NULL;
`;

const rows = queue.rows;

/** 幂等建表（独立初始化 / 测试用；生产由 db/index.js 的 SCHEMA 统一下发） */
async function ensureSchema() {
  await getDb().exec(SCHEMA);
}

// ===== 纯函数层（不连库，便于单测）=====

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** 结果来源：human | ai_relay | ai_shift | manual */
function resultSource(task) {
  if (!task) return 'manual';
  let rp = task.result_payload;
  if (typeof rp === 'string' && rp) {
    try { rp = JSON.parse(rp); } catch (e) { rp = null; }
  }
  const src = rp && typeof rp === 'object' ? rp.source : null;
  if (src === 'ai-relay' || src === 'ai_relay') return 'ai_relay';
  if (src === 'ai-shift' || src === 'ai_shift') return 'ai_shift';
  if (task.assignee_id) return 'human';
  return 'manual';
}

/**
 * 计费时长（分钟，2 位小数）
 *  - 非 completed → 0
 *  - AI 产出（ai-relay / ai-shift）→ 0（不计人工费）
 *  - 时长 = completed_at - COALESCE(claimed_at, created_at)，向上取整到 0.5 分钟，最少 0.5
 *  - 时长为负 / 缺失 → 0
 */
function billableMinutes(task) {
  if (!task || task.status !== 'completed') return 0;
  const src = resultSource(task);
  if (src === 'ai_relay' || src === 'ai_shift') return 0;
  const end = toDate(task.completed_at);
  const start = toDate(task.claimed_at) || toDate(task.created_at);
  if (!end || !start) return 0;
  const raw = (end.getTime() - start.getTime()) / 60000;
  if (!(raw > 0)) return 0;
  const rounded = Math.max(0.5, Math.ceil(raw * 2) / 2); // 向上取整到 0.5，最少 0.5
  return Math.round(rounded * 100) / 100;
}

/** 金额（分）= max(round(分钟 × 单价), 最低消费)；时长为 0 时不收最低消费 */
function calcAmount({ minutes, unitPriceCents, minChargeCents } = {}) {
  const m = Number(minutes) || 0;
  const unit = Number(unitPriceCents) || 0;
  const min = Number(minChargeCents) || 0;
  if (m <= 0) return 0;
  return Math.max(Math.round(m * unit), Math.round(min));
}

/**
 * 费率解析（纯函数）：租户专属 > 全局默认 > 代码常量
 * @param {Object} p
 * @param {number|null} p.tenantId
 * @param {'general'|'confidential'|'ops'} p.category
 * @param {'high'|'medium'|'low'} p.priority
 * @param {Array} [p.rates] 预取的费率行（listRates 结果）；不传则直接回退代码常量
 * @returns {{unit_price_cents:number, min_charge_cents:number, source:'tenant'|'global'|'default', id:number|null}}
 */
function resolveRate({ tenantId, category, priority, rates } = {}) {
  const cat = CATEGORIES.includes(category) ? category : 'general';
  const pri = PRIORITIES.includes(priority) ? priority : 'medium';
  const list = Array.isArray(rates) ? rates : [];
  const norm = (v) => (v === null || v === undefined ? null : parseInt(v, 10));

  const find = (tid) => list.find(r =>
    r.enabled !== false &&
    norm(r.tenant_id) === tid &&
    r.category === cat &&
    r.priority === pri);

  const tenantHit = tenantId !== null && tenantId !== undefined ? find(norm(tenantId)) : null;
  const globalHit = find(null);
  const hit = tenantHit || globalHit;
  if (hit) {
    return {
      unit_price_cents: Number(hit.unit_price_cents) || 0,
      min_charge_cents: Number(hit.min_charge_cents) || 0,
      source: tenantHit ? 'tenant' : 'global',
      id: hit.id || null,
    };
  }
  return {
    unit_price_cents: DEFAULT_RATES[cat][pri],
    min_charge_cents: DEFAULT_MIN_CHARGE,
    source: 'default',
    id: null,
  };
}

/** YYYY-MM（本地时区，按完成时间归档） */
function periodOf(d) {
  const dt = toDate(d) || new Date();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/** 分 → 元字符串（2 位小数） */
function yuan(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

// ===== 数据层 =====

/** 幂等播种全局默认费率（billing_rates 表为空时；并发安全靠全局部分唯一索引兜底） */
async function seedRates() {
  const db = getDb();
  const r = await db.exec('SELECT COUNT(*) AS c FROM billing_rates');
  const c = r[0] ? Number(r[0].values[0][0]) : 0;
  if (c > 0) return { seeded: 0 };
  let n = 0;
  for (const cat of CATEGORIES) {
    for (const pri of PRIORITIES) {
      const ins = await db.run(
        `INSERT INTO billing_rates (tenant_id, category, priority, unit_price_cents, min_charge_cents, enabled)
         VALUES (NULL, ?, ?, ?, ?, ?)
         ON CONFLICT (category, priority) WHERE tenant_id IS NULL DO NOTHING`,
        [cat, pri, DEFAULT_RATES[cat][pri], DEFAULT_MIN_CHARGE, true]);
      if (ins.changes) n++;
    }
  }
  return { seeded: n };
}

/** 费率列表：本租户专属在前，全局在后 */
async function listRates({ tenantId } = {}) {
  const db = getDb();
  return rows(await db.exec(
    `SELECT * FROM billing_rates
      WHERE tenant_id IS NULL OR tenant_id = ?
      ORDER BY (tenant_id IS NULL) ASC, category ASC, priority ASC, id ASC`,
    [tenantId == null ? -1 : tenantId]));
}

/** 新建 / 覆盖费率（按 tenant_id + category + priority）。tenant_id=null 表示全局费率 */
async function upsertRate(data = {}) {
  const category = String(data.category || '');
  const priority = String(data.priority || '');
  if (!CATEGORIES.includes(category)) return { ok: false, message: 'category 非法' };
  if (!PRIORITIES.includes(priority)) return { ok: false, message: 'priority 非法' };
  const unit = Number(data.unit_price_cents);
  const min = Number(data.min_charge_cents == null ? 0 : data.min_charge_cents);
  if (!Number.isFinite(unit) || unit < 0 || unit > 1000000) return { ok: false, message: 'unit_price_cents 非法' };
  if (!Number.isFinite(min) || min < 0 || min > 1000000) return { ok: false, message: 'min_charge_cents 非法' };
  const tenantId = data.tenant_id === null || data.tenant_id === undefined ? null : parseInt(data.tenant_id, 10);
  if (tenantId !== null && !Number.isFinite(tenantId)) return { ok: false, message: 'tenant_id 非法' };
  const enabled = data.enabled !== false;

  const db = getDb();
  // 先尝试更新（避免全局行 tenant_id 为 NULL 时 UNIQUE 不生效导致重复插入）
  const upd = await db.run(
    `UPDATE billing_rates SET unit_price_cents = ?, min_charge_cents = ?, enabled = ?
      WHERE tenant_id IS NOT DISTINCT FROM ? AND category = ? AND priority = ?`,
    [Math.round(unit), Math.round(min), enabled, tenantId, category, priority]);
  if (upd.changes > 0) {
    const hit = await db.exec(
      'SELECT id FROM billing_rates WHERE tenant_id IS NOT DISTINCT FROM ? AND category = ? AND priority = ?',
      [tenantId, category, priority]);
    return { ok: true, id: hit[0].values[0][0], updated: true };
  }
  const ins = await db.run(
    'INSERT INTO billing_rates (tenant_id, category, priority, unit_price_cents, min_charge_cents, enabled) VALUES (?, ?, ?, ?, ?, ?)',
    [tenantId, category, priority, Math.round(unit), Math.round(min), enabled]);
  return { ok: true, id: ins.lastId, updated: false };
}

/** 删除费率（仅限本租户；全局费率不可删） */
async function deleteRate(id, tenantId) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return { ok: false, message: 'id 非法' };
  if (tenantId === null || tenantId === undefined) return { ok: false, message: '仅能删除本租户费率' };
  const r = await getDb().run('DELETE FROM billing_rates WHERE id = ? AND tenant_id = ?', [n, tenantId]);
  if (!r.changes) return { ok: false, message: '费率不存在或不可删除（全局费率受保护）' };
  return { ok: true };
}

/**
 * 为单个任务结算并写 ledger（幂等：已入账则跳过）
 * @param {number} taskId
 * @param {{rates?:Array}} [opts] 批量场景可预取费率（避免 N 次查询）
 * @returns {{settled:boolean, reason?:string, data?:Object}}
 */
async function settleTask(taskId, opts = {}) {
  const db = getDb();
  const task = await queue.getTask(taskId);
  if (!task) return { settled: false, reason: 'not_found' };
  if (task.status !== 'completed') return { settled: false, reason: 'not_completed' };

  const dup = await db.exec('SELECT id FROM billing_ledger WHERE task_id = ?', [task.id]);
  if (dup[0] && dup[0].values.length) return { settled: false, reason: 'already_settled', ledger_id: dup[0].values[0][0] };

  const rates = Array.isArray(opts.rates) ? opts.rates : await listRates({ tenantId: task.tenant_id });
  const rate = resolveRate({
    tenantId: task.tenant_id,
    category: task.category,
    priority: task.priority,
    rates,
  });
  const minutes = billableMinutes(task);
  const amount = calcAmount({
    minutes,
    unitPriceCents: rate.unit_price_cents,
    minChargeCents: rate.min_charge_cents,
  });
  const period = periodOf(task.completed_at);
  const meta = {
    started_at: task.claimed_at || task.created_at || null,
    completed_at: task.completed_at || null,
    result_source: resultSource(task),
    rate_source: rate.source,
  };

  const ins = await db.run(
    `INSERT INTO billing_ledger
       (task_id, tenant_id, project_code, category, priority, assignee_id,
        billable_minutes, unit_price_cents, min_charge_cents, amount_cents, source, period, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
     ON CONFLICT (task_id) DO NOTHING`,
    [
      task.id,
      task.tenant_id == null ? null : task.tenant_id,
      task.project_code || null,
      task.category || 'general',
      task.priority || 'medium',
      task.assignee_id == null ? null : task.assignee_id,
      minutes,
      rate.unit_price_cents,
      rate.min_charge_cents,
      amount,
      resultSource(task),
      period,
      JSON.stringify(meta),
    ]);
  // changes=0 说明并发下已被另一路结算（幂等）
  if (!ins.changes) return { settled: false, reason: 'already_settled' };
  return {
    settled: true,
    data: {
      id: ins.lastId,
      task_id: task.id,
      tenant_id: task.tenant_id,
      period,
      billable_minutes: minutes,
      unit_price_cents: rate.unit_price_cents,
      amount_cents: amount,
      source: resultSource(task),
    },
  };
}

/** 批量补结算：已完成但未入账的任务（扫描器 / 手工触发共用） */
async function settlePendingTasks({ limit = 200 } = {}) {
  const db = getDb();
  const size = Math.max(1, Math.min(2000, parseInt(limit, 10) || 200));
  const list = rows(await db.exec(
    `SELECT t.id, t.tenant_id
       FROM tasks t LEFT JOIN billing_ledger l ON l.task_id = t.id
      WHERE t.status = 'completed' AND l.id IS NULL
      ORDER BY t.completed_at ASC NULLS LAST, t.id ASC
      LIMIT ?`,
    [size]));
  // 费率按租户缓存，避免批量结算时 N 次查库
  const rateCache = new Map();
  let settled = 0, skipped = 0;
  for (const r of list) {
    const key = r.tenant_id == null ? 'g' : String(r.tenant_id);
    if (!rateCache.has(key)) rateCache.set(key, await listRates({ tenantId: r.tenant_id }));
    const res = await settleTask(r.id, { rates: rateCache.get(key) });
    if (res.settled) settled++; else skipped++;
  }
  return { settled, skipped };
}

let scannerTimer = null;
/** 计费扫描器：每 60s 补结算一次（幂等，可安全重复调用） */
function startBillingScanner() {
  if (scannerTimer) return scannerTimer;
  scannerTimer = setInterval(async () => {
    try {
      const r = await settlePendingTasks({ limit: 200 });
      if (r.settled) console.log(`[计费] 补结算 ${r.settled} 条，跳过 ${r.skipped} 条`);
    } catch (e) {
      console.error('[计费扫描失败]', e.message);
    }
  }, 60000);
  if (scannerTimer.unref) scannerTimer.unref();
  return scannerTimer;
}

/** 聚合结果行 → 统一结构（金额同时给分与元字符串） */
function mapAgg(r, extra = {}) {
  const amountCents = Number(r.amt) || 0;
  return {
    key: r.k,
    count: Number(r.c) || 0,
    minutes: Math.round((Number(r.mins) || 0) * 100) / 100,
    amount_cents: amountCents,
    amount_yuan: yuan(amountCents),
    ...extra,
  };
}

/**
 * 租户账单：按分级 / 项目 / 工程师 / 来源汇总
 * @returns {{period:string,total_cents:number,total_yuan:string,total_minutes:number,task_count:number,by_category:Array,by_project:Array,by_assignee:Array,by_source:Array}}
 */
async function tenantStatement({ tenantId, period } = {}) {
  const db = getDb();
  const p = PERIOD_RE.test(String(period || '')) ? period : periodOf(new Date());
  const tid = tenantId == null ? -1 : tenantId;
  const args = [tid, p];

  const totRow = rows(await db.exec(
    `SELECT COUNT(*) AS c, COALESCE(SUM(billable_minutes), 0) AS mins, COALESCE(SUM(amount_cents), 0) AS amt
       FROM billing_ledger WHERE tenant_id = ? AND period = ?`, args))[0] || { c: 0, mins: 0, amt: 0 };
  const totalCents = Number(totRow.amt) || 0;

  const byCategory = rows(await db.exec(
    `SELECT category AS k, COUNT(*) AS c, COALESCE(SUM(billable_minutes), 0) AS mins, COALESCE(SUM(amount_cents), 0) AS amt
       FROM billing_ledger WHERE tenant_id = ? AND period = ?
      GROUP BY category ORDER BY amt DESC`, args)).map(r => mapAgg(r));

  const byProject = rows(await db.exec(
    `SELECT COALESCE(project_code, '') AS k, COUNT(*) AS c, COALESCE(SUM(billable_minutes), 0) AS mins, COALESCE(SUM(amount_cents), 0) AS amt
       FROM billing_ledger WHERE tenant_id = ? AND period = ?
      GROUP BY COALESCE(project_code, '') ORDER BY amt DESC`, args)).map(r => mapAgg(r));

  const byAssignee = rows(await db.exec(
    `SELECT l.assignee_id AS id, COALESCE(u.name, u.username, '') AS k,
            COUNT(*) AS c, COALESCE(SUM(l.billable_minutes), 0) AS mins, COALESCE(SUM(l.amount_cents), 0) AS amt
       FROM billing_ledger l LEFT JOIN users u ON u.id = l.assignee_id
      WHERE l.tenant_id = ? AND l.period = ?
      GROUP BY l.assignee_id, u.name, u.username ORDER BY amt DESC`, args))
    .map(r => mapAgg(r, { assignee_id: r.id }));

  const bySource = rows(await db.exec(
    `SELECT source AS k, COUNT(*) AS c, COALESCE(SUM(billable_minutes), 0) AS mins, COALESCE(SUM(amount_cents), 0) AS amt
       FROM billing_ledger WHERE tenant_id = ? AND period = ?
      GROUP BY source ORDER BY amt DESC`, args)).map(r => mapAgg(r));

  return {
    period: p,
    total_cents: totalCents,
    total_yuan: yuan(totalCents),
    total_minutes: Math.round((Number(totRow.mins) || 0) * 100) / 100,
    task_count: Number(totRow.c) || 0,
    by_category: byCategory,
    by_project: byProject,
    by_assignee: byAssignee,
    by_source: bySource,
  };
}

/** 工作台概览：本期（当月）总额 / 任务数 / 日均费用 / 人工时价均值 / 分级分布 / 项目 Top5 */
async function overview({ tenantId } = {}) {
  const st = await tenantStatement({ tenantId, period: periodOf(new Date()) });
  const days = new Date().getDate() || 1;
  const dailyAvg = Math.round(st.total_cents / days);
  const hourlyAvg = st.total_minutes > 0
    ? Math.round((st.total_cents / st.total_minutes) * 60)
    : 0;
  return {
    period: st.period,
    total_cents: st.total_cents,
    total_yuan: st.total_yuan,
    task_count: st.task_count,
    total_minutes: st.total_minutes,
    daily_avg_cents: dailyAvg,
    daily_avg_yuan: yuan(dailyAvg),
    hourly_avg_cents: hourlyAvg,
    hourly_avg_yuan: yuan(hourlyAvg),
    by_category: st.by_category,
    top_projects: st.by_project.slice(0, 5),
  };
}

/** 明细流水（分页），join 出指派人姓名与任务状态 */
async function listLedger({ tenantId, period, page = 1, size = 20 } = {}) {
  const db = getDb();
  const p = PERIOD_RE.test(String(period || '')) ? period : periodOf(new Date());
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const sz = Math.min(500, Math.max(1, parseInt(size, 10) || 20));
  const offset = (pg - 1) * sz;
  const tid = tenantId == null ? -1 : tenantId;

  const cnt = await db.exec(
    'SELECT COUNT(*) AS c FROM billing_ledger WHERE tenant_id = ? AND period = ?', [tid, p]);
  const total = Number(cnt[0].values[0][0]) || 0;

  const list = rows(await db.exec(
    `SELECT l.*, u.name AS assignee_name, u.username AS assignee_username, t.status AS task_status
       FROM billing_ledger l
       LEFT JOIN users u ON l.assignee_id = u.id
       LEFT JOIN tasks t ON l.task_id = t.id
      WHERE l.tenant_id = ? AND l.period = ?
      ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [tid, p, sz, offset]))
    .map(r => ({
      ...r,
      billable_minutes: Math.round((Number(r.billable_minutes) || 0) * 100) / 100,
      amount_yuan: yuan(r.amount_cents),
      unit_price_yuan: yuan(r.unit_price_cents),
    }));

  return { data: list, total, page: pg, size: sz };
}

module.exports = {
  DEFAULT_RATES,
  DEFAULT_MIN_CHARGE,
  SCHEMA,
  ensureSchema,
  seedRates,
  resolveRate,
  billableMinutes,
  calcAmount,
  resultSource,
  periodOf,
  yuan,
  settleTask,
  settlePendingTasks,
  startBillingScanner,
  tenantStatement,
  listLedger,
  listRates,
  upsertRate,
  deleteRate,
  overview,
};
