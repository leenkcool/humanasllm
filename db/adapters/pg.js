/**
 * PostgreSQL 适配器（使用 pg 库的 Pool）
 * 统一接口：exec → [{columns, values}], run → {changes, lastId}
 * 注意：占位符 ? 会自动转换为 $1, $2, $3...
 * INSERT 语句会自动追加 RETURNING id 以获取插入的行 ID
 */

let Pool;
try {
  Pool = require('pg').Pool;
} catch (e) {
  // pg 未安装，将在 initDatabase 时报错
}

class PgAdapter {
  constructor(config) {
    this.pool = new Pool({
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'postgres',
      user: config.user || 'postgres',
      password: config.password || '',
      max: config.max || 10,
      idleTimeoutMillis: config.idleTimeoutMillis || 30000,
    });
  }

  /**
   * 将 SQL 中的 ? 占位符转换为 $1, $2, $3...
   * @param {string} sql
   * @returns {string}
   */
  convertPlaceholders(sql) {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
  }

  /**
   * 执行查询，返回统一格式
   * @param {string} sql
   * @param {Array} params
   * @returns {Promise<Array<{columns: string[], values: Array[]}>>}
   */
  async exec(sql, params) {
    const convertedSql = this.convertPlaceholders(sql);
    const result = await this.pool.query(convertedSql, params || []);

    if (!result.fields || result.fields.length === 0) {
      return [];
    }

    const columns = result.fields.map(f => f.name);
    const values = result.rows.map(row => columns.map(col => row[col]));
    return [{ columns, values }];
  }

  /**
   * 执行写操作，返回统一格式
   * INSERT 语句自动追加 RETURNING id
   * @param {string} sql
   * @param {Array} params
   * @returns {Promise<{changes: number, lastId: number}>}
   */
  async run(sql, params) {
    let modifiedSql = sql;
    // 自动为 INSERT 语句追加 RETURNING id，以便获取插入的行 ID
    // 但 role_permissions 等关联表没有 id 列，需要跳过
    const skipReturning = /role_permissions/i.test(sql);
    if (/^\s*INSERT\s/i.test(sql) && !/RETURNING/i.test(sql) && !skipReturning) {
      modifiedSql = sql.trim().replace(/;?\s*$/, '') + ' RETURNING id';
    }
    const convertedSql = this.convertPlaceholders(modifiedSql);
    const result = await this.pool.query(convertedSql, params || []);

    let lastId = 0;
    if (result.rows && result.rows.length > 0 && result.rows[0].id !== undefined) {
      lastId = result.rows[0].id;
    }

    return {
      changes: result.rowCount || 0,
      lastId
    };
  }

  /**
   * 获取最后一次插入的行 ID（PG 通过 RETURNING 处理）
   * @returns {Promise<number>}
   */
  async lastInsertId() {
    return 0;
  }

  /**
   * PostgreSQL 自动持久化，无需手动保存
   */
  saveDatabase() {
    // PostgreSQL 自动提交，无需手动保存
  }
}

module.exports = PgAdapter;
