/**
 * 上游任务视图（接入层共用）
 * /v1/tasks/:id 回查 与 完成回调 webhook 共用同一份字段定义，避免两处漂移。
 */
const { getDb } = require('../db');

/** pg 结果集 → 对象数组（本库惯例：各服务本地定义，避免跨模块循环依赖） */
function rows(result) {
  if (!result || !result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

/** 状态 → 人类可读 content（OpenAI 兼容语义） */
function statusContent(task) {
  if (task.status === 'completed') return task.result_text || '';
  if (task.status === 'returned') return `任务被驳回: ${task.reject_reason || '未填写原因'}`;
  if (task.status === 'cancelled') return '任务已取消';
  return '任务处理中，请稍后查询';
}

/** SLA 剩余秒数（无 timeout_at 或已终态返回 null） */
function slaRemainingSec(task) {
  if (!task.timeout_at || task.completed_at) return null;
  const ms = new Date(task.timeout_at).getTime() - Date.now();
  return ms > 0 ? Math.round(ms / 1000) : 0;
}

/** 上游任务视图（结构化治理字段 + content） */
async function buildTaskView(task) {
  const ruleRow = task.rule_id
    ? (await getDb().exec('SELECT name FROM task_rules WHERE id = ?', [task.rule_id]))[0]
    : null;
  const rp = task.result_payload || {};
  const toolCallsOut = rp.tool_calls || null;
  let assignee = null;
  if (task.assignee_id) {
    const u = rows(await getDb().exec('SELECT name, username FROM users WHERE id = ?', [task.assignee_id]))[0];
    assignee = u ? (u.name || u.username) : null;
  }
  return {
    task_id: task.id,
    status: task.status,
    // 函数调用产出：content 为 null（OpenAI 语义），结果在 tool_calls
    content: toolCallsOut ? null : statusContent(task),
    tool_calls: toolCallsOut,
    finish_reason: task.status === 'completed' ? (toolCallsOut ? 'tool_calls' : 'stop') : null,
    model: task.model,
    priority: task.priority || 'medium',
    category: task.category || 'general',
    rule_id: task.rule_id || null,
    rule_name: ruleRow && ruleRow.values[0] ? ruleRow.values[0][0] : null,
    category_source: task.rule_id ? 'rule' : 'manual',
    assignee,
    quality: { completion_note: rp.completion_note || null },
    sla_remaining_sec: slaRemainingSec(task),
    timeout_at: task.timeout_at || null,
    created_at: task.created_at,
    completed_at: task.completed_at || null,
  };
}

module.exports = { buildTaskView, statusContent, slaRemainingSec };
