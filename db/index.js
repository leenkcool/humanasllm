/**
 * 数据库统一入口（PostgreSQL）
 * 提供 initDatabase() / getDb() / saveDatabase()
 * 统一接口：
 *   exec(sql, params) → [{columns, values}]
 *   run(sql, params) → {changes, lastId}
 */
require('dotenv').config();

const DB_TYPE = process.env.DB_TYPE || 'pg';
let db = null;

// ===== 建表 DDL（幂等） =====
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(64) UNIQUE NOT NULL,
  email VARCHAR(128),
  password VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'engineer',
  name VARCHAR(64),
  is_active BOOLEAN NOT NULL DEFAULT true,
  reset_token VARCHAR(128),
  reset_expires TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  upstream_request_id TEXT,
  model VARCHAR(64) NOT NULL DEFAULT 'human-llm',
  stream BOOLEAN NOT NULL DEFAULT false,
  priority VARCHAR(10) NOT NULL DEFAULT 'medium',
  category VARCHAR(20) NOT NULL DEFAULT 'general',
  rule_id INTEGER,
  project_code TEXT,
  callback_url VARCHAR(512),
  meta_tags JSONB,
  request_payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  assignee_id INTEGER REFERENCES users(id),
  result_text TEXT,
  result_payload JSONB,
  reject_reason TEXT,
  paused_reason TEXT,
  claimed_at TIMESTAMP,
  completed_at TIMESTAMP,
  timeout_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

CREATE TABLE IF NOT EXISTS task_rules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  category VARCHAR(20) NOT NULL DEFAULT 'general',
  match_field VARCHAR(20) NOT NULL DEFAULT 'content',
  keywords TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_rules_enabled ON task_rules(enabled);

CREATE TABLE IF NOT EXISTS task_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  category VARCHAR(20) NOT NULL DEFAULT 'general',
  priority VARCHAR(10) NOT NULL DEFAULT 'medium',
  skills TEXT,
  project_code TEXT,
  system_prompt TEXT,
  payload_template JSONB NOT NULL DEFAULT '{}',
  default_meta_tags JSONB,
  enabled BOOLEAN NOT NULL DEFAULT true,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  tenant_id INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_templates_tenant ON task_templates(tenant_id, enabled);


CREATE TABLE IF NOT EXISTS task_logs (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  action VARCHAR(32) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  actor_id INTEGER,
  actor_name VARCHAR(64),
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);

CREATE TABLE IF NOT EXISTS request_logs (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  tenant_id INTEGER,
  direction VARCHAR(8) NOT NULL,
  payload JSONB,
  model VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_logs_task ON request_logs(task_id);

CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  approval_no VARCHAR(32),
  type VARCHAR(20) NOT NULL DEFAULT 'resource',
  resource VARCHAR(128) NOT NULL,
  amount VARCHAR(64),
  purpose TEXT,
  detail TEXT,
  requester VARCHAR(64),
  project_code TEXT,
  meta_tags JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  provider_id INTEGER REFERENCES users(id),
  provider_name VARCHAR(64),
  provided TEXT,
  reject_reason TEXT,
  decided_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  code VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  code VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(128) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  approval_id INTEGER REFERENCES approvals(id),
  level INTEGER NOT NULL DEFAULT 1,
  kind VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  title VARCHAR(255) NOT NULL,
  detail TEXT,
  tenant_id INTEGER,
  acked_by INTEGER REFERENCES users(id),
  acked_at TIMESTAMP,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON alerts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_task ON alerts(task_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);

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

-- PG 的 UNIQUE 不约束 NULL 相等：全局费率行需部分唯一索引防重复
CREATE UNIQUE INDEX IF NOT EXISTS uniq_billing_rates_global ON billing_rates(category, priority) WHERE tenant_id IS NULL;

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
`;

function createAdapter() {
  if (DB_TYPE === 'pg') {
    const PgAdapter = require('./adapters/pg');
    return new PgAdapter({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT) || 5432,
      database: process.env.PG_DATABASE || 'postgres',
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD || ''
    });
  }
  const SqliteAdapter = require('./adapters/sqlite');
  const initSqlJs = require('sql.js');
  return new SqliteAdapter(null); // sqlite 场景由调用方注入实例
}

async function initDatabase() {
  db = createAdapter();
  await db.exec(SCHEMA);
  // ===== 兼容迁移（对已存在的表补列） =====
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(128)`);
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS skills TEXT`);
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS skills TEXT`);
  await db.exec(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  await db.exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  await db.exec(`ALTER TABLE task_rules ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  // request_logs 的中继/漂移日志无 task_id 可关联，必须自存租户才能做隔离筛选
  await db.exec(`ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_request_logs_tenant ON request_logs(tenant_id)`);
  await db.exec(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS upstream_key VARCHAR(64)`);
  await seedTenants();
  await db.exec(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'resource'`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'general'`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rule_id INTEGER`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS callback_url VARCHAR(512)`);
  await db.exec(`ALTER TABLE task_logs ADD COLUMN IF NOT EXISTS prev_hash TEXT`);
  await db.exec(`ALTER TABLE task_logs ADD COLUMN IF NOT EXISTS hash TEXT`);
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(128)`);
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMP`);
  // 工单模板：任务溯源（模板删除后仍保留 id，前端降级展示）
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS template_id INTEGER`);
  // 告警升级序列：提醒次数 / 上次提醒时间 / 当前升级级别（单调递增用于去重）
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_count INTEGER NOT NULL DEFAULT 0`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMP`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0`);
  await db.exec(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS remind_count INTEGER NOT NULL DEFAULT 0`);
  await db.exec(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMP`);
  // 智能派单：按处理人 + 状态聚合负载
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee_id, status)`);
  // ===== 分级策略引擎种子规则（幂等：task_rules 为空时播种） =====
  await seedRules();
  // ===== 工单模板示例（幂等：task_templates 为空时播种，开源开箱即可见） =====
  await seedTemplates();
  return db;
}

/** 播种默认租户并把存量用户归位（多租户 v1：现有单租户数据归 default） */
async function seedTenants() {
  const db = getDb();
  const tr = await db.exec('SELECT id FROM tenants WHERE code = ?', ['default']);
  if (!tr[0] || !tr[0].values.length) {
    await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', ['default', '默认租户']);
  }
  const d = await db.exec('SELECT id FROM tenants WHERE code = ?', ['default']);
  const defaultId = d[0].values[0][0];
  await db.run('UPDATE users SET tenant_id = ? WHERE tenant_id IS NULL', [defaultId]);
  await db.run('UPDATE tasks SET tenant_id = ? WHERE tenant_id IS NULL', [defaultId]);
  await db.run('UPDATE approvals SET tenant_id = ? WHERE tenant_id IS NULL', [defaultId]);
  await db.run('UPDATE projects SET tenant_id = ? WHERE tenant_id IS NULL', [defaultId]);
  // 存量 request_logs 回填：挂任务的按任务租户回填；无任务的中继/漂移日志归默认租户
  await db.run('UPDATE request_logs SET tenant_id = (SELECT t.tenant_id FROM tasks t WHERE t.id = request_logs.task_id) WHERE task_id IS NOT NULL AND tenant_id IS NULL');
  await db.run('UPDATE request_logs SET tenant_id = ? WHERE tenant_id IS NULL', [defaultId]);
}

/** 播种分级策略种子规则（白名单锁死：confidential/ops 命中即定级，不可被上游声明降级） */
async function seedRules() {
  const db = getDb();
  const r = await db.exec('SELECT COUNT(*) AS c FROM task_rules', []);
  if (r[0] && r[0].values[0][0] > 0) return;
  const rules = [
    // 涉密 / 合规 / 安全（confidential，最高优先）
    ['合规备案安全', 'confidential', 'content', '备案,等保,通保,渗透,漏洞,溯源,入侵排查,应急响应,日志审计,SSL证书,域名续费,大模型备案,算法备案,数据安全,隐私合规,安全巡检', 10],
    ['涉密敏感', 'confidential', 'content', '涉密,私有数据,敏感数据,不能外传,不出网关,机密,脱敏', 20],
    ['密钥权限', 'confidential', 'content', 'SSH密钥,API密钥,管理员密码,令牌,权限管控,后台权限,密钥保管', 30],
    // 运维 / 基础设施（ops）
    ['数据库运维', 'ops', 'content', '数据库迁移,DDL,备份恢复,死锁,慢查询,数据备份,异地备份', 40],
    ['基础设施', 'ops', 'content', '机房,电力,防火墙,负载均衡,K8s,Kubernetes,DNS,带宽,磁盘阵列,SSH远程,公网IP,端口管理,内网', 50],
    ['部署发布', 'ops', 'content', '灰度发布,回滚,CI/CD,部署,定时任务,定时脚本,定时重启,版本更新,环境搭建', 60],
    ['监控故障', 'ops', 'content', '宕机,接口报错,502,401,容器异常,SERVFAIL,告警,慢请求,内存报错,程序崩溃', 70],
  ];
  for (const [name, category, field, keywords, priority] of rules) {
    await db.run(
      'INSERT INTO task_rules (name, category, match_field, keywords, priority) VALUES (?, ?, ?, ?, ?)',
      [name, category, field, keywords, priority]);
  }
}

/** 播种工单模板示例（幂等：按名称判重；让开源访客开箱即可见模板能力） */
async function seedTemplates() {
  const db = getDb();
  const templates = [
    ['代码审查', '按团队规范审查改动，输出问题清单与修复建议', 'general', 'medium', 'node,review',
      '你是资深代码审查员。逐条检查：边界条件、错误处理、SQL 注入、并发安全。输出分级问题清单与最小修复建议。'],
    ['数据库迁移', '生产库结构变更（DDL）+ 备份验证，需人工执行', 'ops', 'high', 'postgres,ops',
      '执行数据库迁移：1) 先全量备份并校验 2) 按顺序应用 DDL 3) 记录回滚步骤 4) 提交验收说明。'],
    ['安全巡检', '合规/安全巡检与整改记录，涉密不出口', 'confidential', 'high', 'security,compliance',
      '执行安全巡检：端口暴露、证书有效期、审计日志、权限最小化。输出整改项与责任人。'],
  ];
  for (const [name, description, category, priority, skills, system_prompt] of templates) {
    const dup = await db.exec('SELECT id FROM task_templates WHERE name = ?', [name]);
    if (dup[0] && dup[0].values.length) {
      // 兼容旧版种子（曾绑定 default 租户）：示例模板统一为全局，所有租户开箱可见
      await db.run('UPDATE task_templates SET tenant_id = NULL WHERE name = ? AND tenant_id IS NOT NULL', [name]);
      continue;
    }
    await db.run(
      `INSERT INTO task_templates (name, description, category, priority, skills, system_prompt, payload_template, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, NULL)`,
      [name, description, category, priority, skills, system_prompt,
        JSON.stringify({ messages: [{ role: 'user', content: `请执行「${name}」相关任务，并提交完整产出。` }] })]);
  }
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 initDatabase()');
  return db;
}

function saveDatabase() {
  if (db && db.saveDatabase) db.saveDatabase();
}

module.exports = { initDatabase, getDb, saveDatabase, DB_TYPE };
