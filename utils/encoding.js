/**
 * 编码检测与清理工具
 * 用于检测和修复乱码数据
 */

/**
 * 检测字符串是否包含乱码（UTF-8 替换字符）
 * @param {string} str - 要检测的字符串
 * @returns {boolean} - 是否包含乱码
 */
function hasGarbledText(str) {
  if (!str || typeof str !== 'string') return false;
  // 检测 UTF-8 替换字符 U+FFFD (efbfbd)
  return /�/.test(str) || /[\x00-\x08\x0e-\x1f]/.test(str);
}

/**
 * 检测对象中所有字符串字段是否包含乱码
 * @param {Object} obj - 要检测的对象
 * @param {Array<string>} fields - 要检测的字段列表（可选，不传则检测所有字符串字段）
 * @returns {Object} - { hasGarbled: boolean, fields: Array<{field: string, value: string}> }
 */
function detectGarbledFields(obj, fields = null) {
  if (!obj || typeof obj !== 'object') return { hasGarbled: false, fields: [] };

  const garbledFields = [];
  const checkFields = fields || Object.keys(obj);

  checkFields.forEach(field => {
    const value = obj[field];
    if (typeof value === 'string' && hasGarbledText(value)) {
      garbledFields.push({ field, value: value.substring(0, 50) + '...' });
    }
  });

  return { hasGarbled: garbledFields.length > 0, fields: garbledFields };
}

/**
 * 清理乱码字符串（替换为问号）
 * @param {string} str - 要清理的字符串
 * @returns {string} - 清理后的字符串
 */
function cleanGarbledText(str) {
  if (!str || typeof str !== 'string') return str;
  // 替换 UTF-8 替换字符和控制字符
  return str.replace(/[�]/g, '?').replace(/[\x00-\x08\x0e-\x1f]/g, '');
}

/**
 * 清理对象中的乱码字段
 * @param {Object} obj - 要清理的对象
 * @returns {Object} - 清理后的对象
 */
function cleanGarbledObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const cleaned = { ...obj };
  Object.keys(cleaned).forEach(key => {
    if (typeof cleaned[key] === 'string' && hasGarbledText(cleaned[key])) {
      cleaned[key] = cleanGarbledText(cleaned[key]);
    }
  });
  return cleaned;
}

/**
 * Express 中间件：请求数据编码验证
 * 检测 POST/PUT 请求体中的乱码数据
 */
function validateRequestEncoding(req, res, next) {
  // 只检查 JSON 请求体
  if (req.is('application/json') && req.body && typeof req.body === 'object') {
    const { hasGarbled, fields } = detectGarbledFields(req.body);

    if (hasGarbled) {
      const garbledFieldNames = fields.map(f => f.field).join(', ');
      console.warn(`[编码警告] 请求数据包含乱码字段: ${garbledFieldNames}`);

      // 可以选择拒绝请求或自动清理
      // 这里选择自动清理并继续
      Object.keys(req.body).forEach(key => {
        if (typeof req.body[key] === 'string' && hasGarbledText(req.body[key])) {
          req.body[key] = cleanGarbledText(req.body[key]);
          console.warn(`[编码清理] 已清理字段: ${key}`);
        }
      });
    }
  }

  next();
}

/**
 * 扫描数据库表中的乱码数据
 * @param {Object} db - 数据库适配器
 * @param {string} tableName - 表名
 * @param {Array<string>} textFields - 文本字段列表
 * @returns {Promise<Array>} - 包含乱码的记录
 */
async function scanGarbledData(db, tableName, textFields) {
  const result = await db.exec(`SELECT * FROM ${tableName}`);
  if (!result || !result.length) return [];

  const columns = result[0].columns;
  const rows = result[0].values;
  const garbled = [];

  rows.forEach((row, idx) => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);

    textFields.forEach(field => {
      if (obj[field] && typeof obj[field] === 'string' && hasGarbledText(obj[field])) {
        garbled.push({
          table: tableName,
          id: obj.id,
          field,
          value: obj[field].substring(0, 100)
        });
      }
    });
  });

  return garbled;
}

module.exports = {
  hasGarbledText,
  detectGarbledFields,
  cleanGarbledText,
  cleanGarbledObject,
  validateRequestEncoding,
  scanGarbledData
};
