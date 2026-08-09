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
  return db;
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 initDatabase()');
  return db;
}

function saveDatabase() {
  if (db && db.saveDatabase) db.saveDatabase();
}

module.exports = { initDatabase, getDb, saveDatabase, DB_TYPE };
