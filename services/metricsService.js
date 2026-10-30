/**
 * Prometheus 监控指标服务
 *
 * 设计要点：
 *  - 默认使用 prom-client；未安装时自动降级为零依赖的手写 Prometheus 文本实现
 *  - 指标名统一 p390_ 前缀，默认标签 service="p390-human-as-agent"
 *  - HTTP 指标的 route 标签只用 Express 路由模板（req.route.path），绝不用原始 URL，
 *    避免 /api/tasks/123 这类路径打爆时间序列基数
 *  - 业务 gauge 由 collectGauges() 每 15 秒查库刷新，单个查询失败不影响其他指标
 *  - /metrics 默认开放，配置 METRICS_TOKEN 后要求 Bearer 令牌（校验在 routes/metrics.js）
 */
'use strict';

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const SERVICE_NAME = 'p390-human-as-agent';
const GAUGE_INTERVAL_MS = 15000;

// ===== 可选依赖：prom-client（未安装则走零依赖兜底实现） =====
let prom = null;
try {
  // eslint-disable-next-line global-require
  prom = require('prom-client');
} catch (e) {
  prom = null;
}

// ===== 零依赖兜底实现（最小可用子集：Counter / Gauge / Histogram / Registry） =====

function escapeLabelValue(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatLabels(pairs) {
  const parts = pairs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function formatValue(v) {
  if (!Number.isFinite(Number(v))) return '0';
  return String(Number(v));
}

/** 合并默认标签 + 指标自身标签（后者覆盖同名键） */
function mergeLabelPairs(defaultLabels, labelNames, labels) {
  const map = new Map();
  for (const [k, v] of Object.entries(defaultLabels || {})) map.set(k, v);
  for (const n of labelNames) map.set(n, labels[n]);
  return Array.from(map.entries());
}

class FallbackMetric {
  constructor(opts = {}) {
    this.name = opts.name;
    this.help = opts.help || '';
    this.type = opts.type || 'gauge';
    this.labelNames = opts.labelNames || [];
    this._series = new Map();
    this.registry = null;
    const regs = opts.registers || (opts.register ? [opts.register] : []);
    for (const r of regs) {
      if (r && typeof r.registerMetric === 'function') {
        r.registerMetric(this);
        this.registry = r;
      }
    }
  }

  _key(labels) {
    return this.labelNames.map((n) => `${n}=${labels[n] == null ? '' : labels[n]}`).join('\u0001');
  }

  _seriesFor(labels) {
    const key = this._key(labels);
    let s = this._series.get(key);
    if (!s) {
      s = this._createSeries(labels);
      this._series.set(key, s);
    }
    return s;
  }

  _createSeries(labels) {
    return { labels: { ...labels }, value: 0 };
  }

  /** 子指标 API（与 prom-client 的 metric.labels({...}).set(v) 保持一致） */
  labels(labelValues = {}) {
    const self = this;
    const vals = labelValues || {};
    return {
      set: (v) => self.set(vals, v),
      inc: (v = 1) => self.inc(vals, v),
      dec: (v = 1) => self.dec(vals, v),
      observe: (v) => self.observe(vals, v),
      reset: () => self.reset(),
    };
  }

  reset() {
    this._series.clear();
  }

  render(defaultLabels = {}) {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    for (const s of this._series.values()) {
      const pairs = mergeLabelPairs(defaultLabels, this.labelNames, s.labels);
      out.push(`${this.name}${formatLabels(pairs)} ${formatValue(s.value)}`);
    }
    return out;
  }
}

class FallbackCounter extends FallbackMetric {
  constructor(opts = {}) {
    super({ ...opts, type: 'counter' });
  }

  // 兼容 inc({labels}, value) 与 inc(value)
  inc(a, b) {
    let labels;
    let value;
    if (typeof a === 'number') {
      value = a;
      labels = (b && typeof b === 'object') ? b : {};
    } else {
      labels = a || {};
      value = typeof b === 'number' ? b : 1;
    }
    const s = this._seriesFor(labels);
    s.value += value;
    return this;
  }
}

class FallbackGauge extends FallbackMetric {
  constructor(opts = {}) {
    super({ ...opts, type: 'gauge' });
  }

  // 兼容 set(value, labels) 与 set(labels, value)
  set(a, b) {
    let labels;
    let value;
    if (a && typeof a === 'object') {
      labels = a;
      value = Number(b) || 0;
    } else {
      value = Number(a) || 0;
      labels = (b && typeof b === 'object') ? b : {};
    }
    this._seriesFor(labels).value = value;
    return this;
  }

  inc(labels = {}, value = 1) {
    const s = this._seriesFor(labels || {});
    s.value += value;
    return this;
  }

  dec(labels = {}, value = 1) {
    return this.inc(labels, -value);
  }
}

class FallbackHistogram extends FallbackMetric {
  constructor(opts = {}) {
    super({ ...opts, type: 'histogram' });
    this.buckets = (opts.buckets || DEFAULT_BUCKETS).slice().sort((x, y) => x - y);
  }

  _createSeries(labels) {
    return {
      labels: { ...labels },
      bucketCounts: new Array(this.buckets.length).fill(0),
      sum: 0,
      count: 0,
    };
  }

  observe(a, b) {
    let labels;
    let value;
    if (typeof a === 'number') {
      value = a;
      labels = (b && typeof b === 'object') ? b : {};
    } else {
      labels = a || {};
      value = typeof b === 'number' ? b : 0;
    }
    const s = this._seriesFor(labels);
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) s.bucketCounts[i] += 1;
    }
    return this;
  }

  render(defaultLabels = {}) {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this._series.values()) {
      const base = mergeLabelPairs(defaultLabels, this.labelNames, s.labels);
      for (let i = 0; i < this.buckets.length; i += 1) {
        out.push(`${this.name}_bucket${formatLabels([...base, ['le', String(this.buckets[i])]])} ${formatValue(s.bucketCounts[i])}`);
      }
      out.push(`${this.name}_bucket${formatLabels([...base, ['le', '+Inf']])} ${formatValue(s.count)}`);
      out.push(`${this.name}_sum${formatLabels(base)} ${formatValue(s.sum)}`);
      out.push(`${this.name}_count${formatLabels(base)} ${formatValue(s.count)}`);
    }
    return out;
  }
}

class FallbackRegistry {
  constructor() {
    this._metrics = new Map();
    this._collectors = new Set();
    this._defaultLabels = {};
    this.contentType = 'text/plain; version=0.0.4; charset=utf-8';
  }

  setDefaultLabels(labels) {
    Object.assign(this._defaultLabels, labels || {});
  }

  registerMetric(metric) {
    if (metric && metric.name) this._metrics.set(metric.name, metric);
  }

  addCollector(fn) {
    if (typeof fn === 'function') this._collectors.add(fn);
  }

  async metrics() {
    // 渲染前刷新一次进程类指标（兜底实现没有 prom-client 的自动采集）
    for (const fn of this._collectors) {
      try { fn(); } catch (e) { /* 采集失败不影响输出 */ }
    }
    const lines = [];
    for (const m of this._metrics.values()) lines.push(...m.render(this._defaultLabels));
    return `${lines.join('\n')}\n`;
  }

  reset() {
    for (const m of this._metrics.values()) {
      if (typeof m.reset === 'function') m.reset();
    }
  }
}

/** 兜底实现的进程指标（prom-client 由 collectDefaultMetrics 提供） */
function registerFallbackProcessMetrics(registry) {
  const startGauge = new FallbackGauge({
    name: 'process_start_time_seconds',
    help: '进程启动时间（Unix 秒）',
    registers: [registry],
  });
  const rssGauge = new FallbackGauge({
    name: 'process_resident_memory_bytes',
    help: '进程常驻内存（字节）',
    registers: [registry],
  });
  const heapGauge = new FallbackGauge({
    name: 'process_heap_used_bytes',
    help: 'Node.js 堆已用（字节）',
    registers: [registry],
  });
  const uptimeGauge = new FallbackGauge({
    name: 'process_uptime_seconds',
    help: '进程运行时长（秒）',
    registers: [registry],
  });
  const cpuUser = new FallbackCounter({
    name: 'process_cpu_user_seconds_total',
    help: '用户态 CPU 累计（秒）',
    registers: [registry],
  });
  const cpuSystem = new FallbackCounter({
    name: 'process_cpu_system_seconds_total',
    help: '内核态 CPU 累计（秒）',
    registers: [registry],
  });

  startGauge.set(Date.now() / 1000 - process.uptime());
  let lastCpu = process.cpuUsage();

  registry.addCollector(() => {
    const mem = process.memoryUsage();
    rssGauge.set(mem.rss);
    heapGauge.set(mem.heapUsed);
    uptimeGauge.set(process.uptime());
    const now = process.cpuUsage();
    // cpuUsage 返回微秒累计值，单调递增，取差值避免重复计数
    cpuUser.inc({}, Math.max(0, now.user - lastCpu.user) / 1e6);
    cpuSystem.inc({}, Math.max(0, now.system - lastCpu.system) / 1e6);
    lastCpu = now;
  });
}

// ===== 注册表与指标单例 =====

let registry = null;
let inited = false;
let gaugeTimer = null;
let collecting = false;

const M = {}; // 指标实例集合

const TASK_STATUSES = ['pending', 'processing', 'completed', 'returned', 'paused', 'cancelled'];
const TASK_CATEGORIES = ['general', 'confidential', 'ops'];
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];
const ALERT_LEVELS = ['1', '2', '3'];

const COUNTER_ALIASES = {
  ai_relay_total: 'aiRelayTotal',
  p390_ai_relay_total: 'aiRelayTotal',
  task_timeout_total: 'taskTimeoutTotal',
  p390_task_timeout_total: 'taskTimeoutTotal',
};

function ensureRegistry() {
  if (registry) return registry;
  if (prom) {
    registry = new prom.Registry();
    registry.setDefaultLabels({ service: SERVICE_NAME });
    prom.collectDefaultMetrics({ register: registry });
  } else {
    registry = new FallbackRegistry();
    registry.setDefaultLabels({ service: SERVICE_NAME });
    registerFallbackProcessMetrics(registry);
  }
  return registry;
}

/** 预置已知标签为 0，保证表为空时面板也能看到序列 */
function seedKnownGauges() {
  for (const status of TASK_STATUSES) M.tasks.labels({ status }).set(0);
  for (const category of TASK_CATEGORIES) M.tasksByCategory.labels({ category }).set(0);
  for (const status of APPROVAL_STATUSES) M.approvals.labels({ status }).set(0);
  for (const level of ALERT_LEVELS) M.alertsActive.labels({ level }).set(0);
  M.tasksOverdue.set(0);
  M.engineersActive.set(0);
  M.billingTotal.set(0);
  M.dbUp.set(0);
}

/**
 * 注册全部指标（幂等：多次调用只注册一次）
 * @returns {object} Registry
 */
function init() {
  const reg = ensureRegistry();
  if (inited) return reg;

  const C = prom ? prom.Counter : FallbackCounter;
  const G = prom ? prom.Gauge : FallbackGauge;
  const H = prom ? prom.Histogram : FallbackHistogram;

  // HTTP：请求数 / 耗时（route 用路由模板，防高基数）
  M.httpRequestsTotal = new C({
    name: 'p390_http_requests_total',
    help: 'HTTP 请求总数（按方法/路由/状态码）',
    labelNames: ['method', 'route', 'status'],
    registers: [reg],
  });
  M.httpDuration = new H({
    name: 'p390_http_request_duration_seconds',
    help: 'HTTP 请求耗时（秒）',
    labelNames: ['method', 'route'],
    buckets: DEFAULT_BUCKETS,
    registers: [reg],
  });

  // 业务 gauge（collectGauges 每 15 秒刷新）
  M.tasks = new G({
    name: 'p390_tasks',
    help: '任务数量（按状态）',
    labelNames: ['status'],
    registers: [reg],
  });
  M.tasksByCategory = new G({
    name: 'p390_tasks_by_category',
    help: '任务数量（按分级）',
    labelNames: ['category'],
    registers: [reg],
  });
  M.tasksOverdue = new G({
    name: 'p390_tasks_overdue',
    help: '已超时且未终态的任务数',
    registers: [reg],
  });
  M.approvals = new G({
    name: 'p390_approvals',
    help: '审批数量（按状态）',
    labelNames: ['status'],
    registers: [reg],
  });
  M.alertsActive = new G({
    name: 'p390_alerts_active',
    help: '活跃告警数量（按级别）',
    labelNames: ['level'],
    registers: [reg],
  });
  M.engineersActive = new G({
    name: 'p390_engineers_active',
    help: '启用状态的工程师数量',
    registers: [reg],
  });
  M.billingTotal = new G({
    name: 'p390_billing_amount_cents_total',
    help: '计费流水总额（分）；billing_ledger 表不存在时为 0',
    registers: [reg],
  });
  M.dbUp = new G({
    name: 'p390_db_up',
    help: '数据库可用性（1 可用 / 0 不可用）',
    registers: [reg],
  });

  // 业务 counter（供其他服务自增）
  M.aiRelayTotal = new C({
    name: 'p390_ai_relay_total',
    help: 'AI 中继调用次数（按结果）',
    labelNames: ['result'],
    registers: [reg],
  });
  M.taskTimeoutTotal = new C({
    name: 'p390_task_timeout_total',
    help: '任务超时次数（按阶段）',
    labelNames: ['phase'],
    registers: [reg],
  });

  seedKnownGauges();
  inited = true;
  if (!prom) {
    console.warn('[监控] 未安装 prom-client，已启用内置零依赖指标实现（功能一致，默认进程指标较少）');
  }
  return reg;
}

/**
 * 路由标签：只用 Express 路由模板，缺失时归入 unmatched
 * 注意：router 通过 app.use('/api/tasks', router) 挂载时，req.route.path 只是模块内相对路径
 * （如 '/:id'），必须拼上 req.baseUrl 否则不同模块的同名路由会混成一个序列。
 */
function routeLabel(req) {
  try {
    const p = req && req.route && req.route.path;
    const rel = Array.isArray(p) ? p[0] : p;
    if (typeof rel === 'string' && rel) {
      const base = (req && typeof req.baseUrl === 'string') ? req.baseUrl : '';
      return `${base}${rel}` || rel;
    }
  } catch (e) { /* 忽略 */ }
  return 'unmatched';
}

/** 指标功能是否启用（METRICS_ENABLED=false 时中间件与端点都静默） */
function isEnabled() {
  const v = String(process.env.METRICS_ENABLED || 'true').toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

/** Express 中间件：记录 HTTP 请求数与耗时（失败绝不影响业务） */
function metricsMiddleware(req, res, next) {
  if (!isEnabled()) return next();
  // 跳过抓取端点自身，避免 /metrics 的延迟混入业务指标
  const reqPath = (req && (req.path || req.url || '')).split('?')[0];
  if (reqPath === '/metrics') return next();

  const start = process.hrtime.bigint();
  const onFinish = () => {
    try {
      init();
      const route = routeLabel(req);
      const labels = { method: (req && req.method) || 'GET', route };
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      M.httpRequestsTotal.labels({ ...labels, status: String((res && res.statusCode) || 0) }).inc();
      M.httpDuration.labels(labels).observe(seconds);
    } catch (e) { /* 指标失败不影响业务 */ }
  };
  try {
    if (res && typeof res.on === 'function') res.on('finish', onFinish);
  } catch (e) { /* 忽略 */ }
  next();
}

/** 安全查询：任何失败返回 null，不打断其他指标 */
async function safeQuery(db, sql, params) {
  try {
    return await db.exec(sql, params || []);
  } catch (e) {
    return null;
  }
}

/** 把 exec 结果转成对象数组 */
function toObjects(result) {
  if (!result || !result[0] || !Array.isArray(result[0].values)) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

/** 刷新业务 gauge（异步查库；每个查询独立 try/catch） */
async function collectGauges() {
  init();
  if (collecting) return;
  collecting = true;
  try {
    // 先清空再预置，避免已删除的标签组合残留
    const resetSafe = (g) => { try { if (g && typeof g.reset === 'function') g.reset(); } catch (e) { /* 忽略 */ } };
    resetSafe(M.tasks);
    resetSafe(M.tasksByCategory);
    resetSafe(M.approvals);
    resetSafe(M.alertsActive);
    seedKnownGauges();

    let db = null;
    try {
      // eslint-disable-next-line global-require
      db = require('../db').getDb();
    } catch (e) {
      db = null;
    }
    if (!db) {
      M.dbUp.set(0);
      return;
    }

    // 数据库可用性
    const ping = await safeQuery(db, 'SELECT 1 AS ok');
    M.dbUp.set(ping ? 1 : 0);

    // 任务按状态
    const byStatus = toObjects(await safeQuery(db, 'SELECT status, COUNT(*) AS n FROM tasks GROUP BY status'));
    for (const row of byStatus) {
      M.tasks.labels({ status: String(row.status) }).set(Number(row.n) || 0);
    }

    // 任务按分级
    const byCategory = toObjects(await safeQuery(db, 'SELECT category, COUNT(*) AS n FROM tasks GROUP BY category'));
    for (const row of byCategory) {
      M.tasksByCategory.labels({ category: String(row.category || 'general') }).set(Number(row.n) || 0);
    }

    // 超时未终态
    const overdue = toObjects(await safeQuery(
      db,
      "SELECT COUNT(*) AS n FROM tasks WHERE timeout_at IS NOT NULL AND timeout_at < NOW() AND status NOT IN ('completed', 'returned', 'cancelled')"
    ));
    if (overdue[0]) M.tasksOverdue.set(Number(overdue[0].n) || 0);

    // 审批按状态
    const approvals = toObjects(await safeQuery(db, 'SELECT status, COUNT(*) AS n FROM approvals GROUP BY status'));
    for (const row of approvals) {
      M.approvals.labels({ status: String(row.status) }).set(Number(row.n) || 0);
    }

    // 活跃告警按级别
    const alerts = toObjects(await safeQuery(db, "SELECT level, COUNT(*) AS n FROM alerts WHERE status = 'active' GROUP BY level"));
    for (const row of alerts) {
      M.alertsActive.labels({ level: String(row.level) }).set(Number(row.n) || 0);
    }

    // 工程师数
    const engineers = toObjects(await safeQuery(
      db,
      "SELECT COUNT(*) AS n FROM users WHERE role = 'engineer' AND is_active = true"
    ));
    if (engineers[0]) M.engineersActive.set(Number(engineers[0].n) || 0);

    // 计费流水（表不存在则跳过；to_regclass 仅 PG 支持，失败静默）
    const reg = toObjects(await safeQuery(db, "SELECT to_regclass('billing_ledger') AS t"));
    const hasBilling = reg[0] && reg[0].t != null;
    if (hasBilling) {
      const sum = toObjects(await safeQuery(db, 'SELECT COALESCE(SUM(amount_cents), 0) AS s FROM billing_ledger'));
      if (sum[0]) M.billingTotal.set(Number(sum[0].s) || 0);
    }
  } catch (e) {
    // 兜底：collectGauges 本身绝不抛错
  } finally {
    collecting = false;
  }
}

/** 启动 15 秒 gauge 刷新定时器（幂等） */
function startGaugeRefresher() {
  if (!isEnabled()) return null;
  init();
  if (gaugeTimer) return gaugeTimer;
  collectGauges().catch(() => {});
  gaugeTimer = setInterval(() => { collectGauges().catch(() => {}); }, GAUGE_INTERVAL_MS);
  if (typeof gaugeTimer.unref === 'function') gaugeTimer.unref();
  return gaugeTimer;
}

/** 统计某指标的结果标签（供 AI 中继 / 超时扫描自增） */
function incCounter(name, labels = {}, value = 1) {
  init();
  const key = COUNTER_ALIASES[name] || name;
  const metric = M[key];
  if (!metric || typeof metric.labels !== 'function') return false;
  try {
    metric.labels(labels || {}).inc(value);
    return true;
  } catch (e) {
    return false;
  }
}

/** 输出 /metrics 文本（Express handler） */
async function renderMetrics(req, res) {
  if (!isEnabled()) {
    return res.status(404).json({ error: 'metrics 已关闭' });
  }
  try {
    const reg = init();
    const body = await reg.metrics();
    res.setHeader('Content-Type', reg.contentType || 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(body);
  } catch (e) {
    console.error('[监控] 指标输出失败:', e.message);
    return res.status(500).end('metrics error');
  }
}

/** 测试用：重置非 gauge 指标（counter / histogram），业务 gauge 保持不变 */
function resetForTests() {
  init();
  const resettable = ['httpRequestsTotal', 'httpDuration', 'aiRelayTotal', 'taskTimeoutTotal'];
  for (const key of resettable) {
    const metric = M[key];
    if (metric && typeof metric.reset === 'function') {
      try { metric.reset(); } catch (e) { /* 忽略 */ }
    }
  }
  seedKnownGauges();
}

module.exports = {
  get register() { return ensureRegistry(); },
  init,
  isEnabled,
  metricsMiddleware,
  collectGauges,
  startGaugeRefresher,
  renderMetrics,
  resetForTests,
  incCounter,
};
