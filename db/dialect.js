/**
 * SQL 方言转换器
 * 提供 sqlite / pg / mysql 三种方言的差异处理
 * 供路由层获取 getDialect() 并调用方言方法
 */

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

const dialects = {
  sqlite: {
    autoIncrement: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    textType: 'TEXT',
    boolType: 'INTEGER',
    datetimeType: 'DATETIME',
    timestampDefault: 'DEFAULT CURRENT_TIMESTAMP',
    lastInsertId: () => 'SELECT last_insert_rowid() as id',
    now: () => "datetime('now', 'localtime')",
    dateNow: () => "DATE('now')",
    dateSub: (n) => `datetime('now', '-${n} days')`,
    insertIgnore: (table, cols, vals) => `INSERT OR IGNORE INTO ${table} ${cols} VALUES ${vals}`,
    columnExists: (table) => `PRAGMA table_info(${table})`,
    parseColumnExists: (result, colName) => {
      if (!result || !result.length) return false;
      const nameIdx = result[0].columns.indexOf('name');
      return result[0].values.some(row => row[nameIdx] === colName);
    },
    parseColumnList: (result) => {
      if (!result || !result.length) return [];
      const nameIdx = result[0].columns.indexOf('name');
      return result[0].values.map(row => row[nameIdx]);
    },
    placeholder: (i) => '?',
    // LIKE 大小写：SQLite 默认不区分大小写
    ilike: (col) => `${col} LIKE ?`,
    // 布尔值：SQLite 用 1/0
    boolValue: (v) => v ? 1 : 0,
  },
  pg: {
    autoIncrement: 'SERIAL PRIMARY KEY',
    textType: 'TEXT',
    boolType: 'BOOLEAN',
    boolDefault: 'DEFAULT false',
    boolTrueDefault: 'DEFAULT true',
    datetimeType: 'TIMESTAMP',
    timestampDefault: 'DEFAULT NOW()',
    lastInsertId: (table, col) => `RETURNING ${col || 'id'}`,
    now: () => 'NOW()',
    dateNow: () => 'CURRENT_DATE',
    dateSub: (n) => `NOW() - INTERVAL '${n} days'`,
    insertIgnore: (table, cols, vals) => `INSERT INTO ${table} ${cols} VALUES ${vals} ON CONFLICT DO NOTHING`,
    columnExists: (table) => `SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`,
    parseColumnExists: (result, colName) => {
      if (!result || !result.length) return false;
      return result[0].values.some(row => row[0] === colName);
    },
    parseColumnList: (result) => {
      if (!result || !result.length) return [];
      return result[0].values.map(row => row[0]);
    },
    placeholder: (i) => `$${i}`,
    // LIKE 大小写：PG 默认区分大小写，使用 ILIKE
    ilike: (col) => `${col} ILIKE ?`,
    // 布尔值：PostgreSQL 用 true/false
    boolValue: (v) => v ? true : false,
  },
  mysql: {
    autoIncrement: 'INT AUTO_INCREMENT PRIMARY KEY',
    textType: 'VARCHAR(500)',
    boolType: 'TINYINT(1)',
    datetimeType: 'DATETIME',
    timestampDefault: 'DEFAULT CURRENT_TIMESTAMP',
    lastInsertId: () => 'SELECT LAST_INSERT_ID() as id',
    now: () => 'NOW()',
    dateNow: () => 'CURDATE()',
    dateSub: (n) => `DATE_SUB(NOW(), INTERVAL ${n} DAY)`,
    insertIgnore: (table, cols, vals) => `INSERT IGNORE INTO ${table} ${cols} VALUES ${vals}`,
    columnExists: (table) => `SHOW COLUMNS FROM \`${table}\``,
    parseColumnExists: (result, colName) => {
      if (!result || !result.length) return false;
      const fieldIdx = result[0].columns.indexOf('Field');
      return result[0].values.some(row => row[fieldIdx] === colName);
    },
    parseColumnList: (result) => {
      if (!result || !result.length) return [];
      const fieldIdx = result[0].columns.indexOf('Field');
      return result[0].values.map(row => row[fieldIdx]);
    },
    placeholder: (i) => '?',
    // LIKE 大小写：MySQL 默认不区分大小写（取决于 collation）
    ilike: (col) => `${col} LIKE ?`,
    // 布尔值：MySQL 用 1/0
    boolValue: (v) => v ? 1 : 0,
  }
};

function getDialect() {
  return dialects[DB_TYPE] || dialects.sqlite;
}

module.exports = { dialects, getDialect, DB_TYPE };
