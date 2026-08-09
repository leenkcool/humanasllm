/**
 * SQLite 适配器（包装 sql.js 实例）
 * 统一接口：exec → [{columns, values}], run → {changes, lastId}
 */

class SqliteAdapter {
  constructor(sqlJsDb) {
    this.db = sqlJsDb;
  }

  /**
   * 执行查询语句，返回 sql.js 原生格式
   * @param {string} sql
   * @param {Array} params
   * @returns {Array<{columns: string[], values: Array[]}>}
   */
  exec(sql, params) {
    return this.db.exec(sql, params || []);
  }

  /**
   * 执行写操作（INSERT/UPDATE/DELETE）
   * @param {string} sql
   * @param {Array} params
   * @returns {{changes: number, lastId: number}}
   */
  run(sql, params) {
    this.db.run(sql, params || []);
    const r = this.db.exec('SELECT last_insert_rowid() as id');
    const lastId = r.length > 0 ? r[0].values[0][0] : 0;
    return { changes: 1, lastId };
  }

  /**
   * 获取最后一次插入的行 ID
   * @returns {number}
   */
  lastInsertId() {
    const r = this.db.exec('SELECT last_insert_rowid() as id');
    return r.length > 0 ? r[0].values[0][0] : 0;
  }

  /**
   * 保存数据库到磁盘（由外部 db.js 处理）
   */
  saveDatabase() {
    // 留空，由 db.js 的 saveDatabase 函数处理
  }
}

module.exports = SqliteAdapter;
