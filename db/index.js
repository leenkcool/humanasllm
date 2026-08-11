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
  await db.exec(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  await db.exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  await db.exec(`ALTER TABLE task_rules ADD COLUMN IF NOT EXISTS tenant_id INTEGER`);
  await db.exec(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS upstream_key VARCHAR(64)`);
  await seedTenants();
  await db.exec(`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'resource'`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'general'`);
  await db.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rule_id INTEGER`);
  await db.exec(`ALTER TABLE task_logs ADD COLUMN IF NOT EXISTS prev_hash TEXT`);
  await db.exec(`ALTER TABLE task_logs ADD COLUMN IF NOT EXISTS hash TEXT`);
  // ===== 分级策略引擎种子规则（幂等：task_rules 为空时播种） =====
  await seedRules();
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

function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 initDatabase()');
  return db;
}

function saveDatabase() {
  if (db && db.saveDatabase) db.saveDatabase();
}

module.exports = { initDatabase, getDb, saveDatabase, DB_TYPE };
