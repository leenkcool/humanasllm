/**
 * CSV 工具（导出用）
 * 供 tasks/approvals 导出接口复用，避免重复定义
 */
function toCSV(rows, cols) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
}

module.exports = { toCSV };
