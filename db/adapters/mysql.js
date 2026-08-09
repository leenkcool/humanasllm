/**
 * MySQL 适配器（使用 mysql2/promise createPool）
 * 统一接口：exec → [{columns, values}], run → {changes, lastId}
 */

let mysql;
try {
  mysql = require('mysql2/promise');
} catch (e) {
  // mysql2 未安装，将在 initDatabase 时报错
}

class MysqlAdapter {
  constructor(config) {
    this.pool = mysql.createPool({
      host: config.host || 'localhost',
      port: config.port || 3306,
      database: config.database || 'app',
      user: config.user || 'root',
      password: config.password || '',
      waitForConnections: true,
      connectionLimit: config.max || 10,
      queueLimit: 0,
      charset: 'utf8mb4',
    });
  }

  /**
   * 执行查询，返回统一格式
   * @param {string} sql
   * @param {Array} params
   * @returns {Promise<Array<{columns: string[], values: Array[]}>>}
   */
  async exec(sql, params) {
    const [rows, fields] = await this.pool.query(sql, params || []);

    // 如果是空结果（如 INSERT 等没有返回行的操作）
    if (!Array.isArray(rows) || rows.length === 0) {
      if (fields && fields.length > 0) {
        const columns = fields.map(f => f.name);
        return [{ columns, values: [] }];
      }
      return [];
    }

    const columns = fields ? fields.map(f => f.name) : Object.keys(rows[0]);
    const values = rows.map(row => columns.map(col => row[col]));
    return [{ columns, values }];
  }

  /**
   * 执行写操作，返回统一格式
   * @param {string} sql
   * @param {Array} params
   * @returns {Promise<{changes: number, lastId: number}>}
   */
  async run(sql, params) {
    const [result] = await this.pool.query(sql, params || []);
    return {
      changes: result.affectedRows || 0,
      lastId: result.insertId || 0
    };
  }

  /**
   * 获取最后一次插入的行 ID
   * @returns {Promise<number>}
   */
  async lastInsertId() {
    const [rows] = await this.pool.query('SELECT LAST_INSERT_ID() as id');
    return rows.length > 0 ? rows[0].id : 0;
  }

  /**
   * MySQL 自动持久化，无需手动保存
   */
  saveDatabase() {
    // MySQL 自动提交，无需手动保存
  }
}

module.exports = MysqlAdapter;
