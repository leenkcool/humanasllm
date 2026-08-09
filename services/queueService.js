/**
 * 任务队列服务
 * 状态机：pending → processing → completed | returned
 *              ↑_________________|          │
 *              └── 驳回/超时/暂停后可重新派发 ┘
 * 内存等待者 Map：/v1/chat/completions 挂起等待，工程师完成后唤醒返回
 */
require('dotenv').config();
const { getDb } = require('../db');
const ws = require('./websocket');

const STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  RETURNED: 'returned',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
};

// 状态机合法转换表
const TRANSITIONS = {
  pending: ['processing', 'returned', 'cancelled'],
  processing: ['completed', 'returned', 'paused'],
  returned: ['pending', 'processing', 'cancelled'],
  paused: ['processing', 'returned', 'cancelled'],
  completed: [],
  cancelled: [],
};

// 等待者：taskId → { resolve, timer }
const waiters = new Map();

const PENDING_MIN = () => parseInt(process.env.TASK_PENDING_TIMEOUT_MIN) || 60;
const PROCESSING_MIN = () => parseInt(process.env.TASK_PROCESSING_TIMEOUT_MIN) || 120;

/** SQL 表达式标记：{ __expr: 'NOW() + interval ...' } 直接拼 SQL，其余走参数绑定 */
const expr = (s) => ({ __expr: s });
const now = () => expr('NOW()');
const afterMin = (m) => expr(`NOW() + interval '${m} minutes'`);

function rows(result) {
  if (!result || !result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    for (const k of ['request_payload', 'result_payload', 'meta_tags']) {
      if (typeof obj[k] === 'string' && obj[k]) { try { obj[k] = JSON.parse(obj[k]); } catch (e) { obj[k] = null; } }
    }
    return obj;
  });
}

async function getTask(id) {
  const r = await getDb().exec('SELECT * FROM tasks WHERE id = ?', [id]);
  const list = rows(r);
  return list[0] || null;
}

async function addLog(taskId, action, oldValue, newValue, actor, remark) {
  await getDb().run(
    `INSERT INTO task_logs (task_id, action, old_value, new_value, actor_id, actor_name, remark)
     VALUES (?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)`,
    [taskId, action,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      actor ? actor.id : null, actor ? actor.name || actor.username : '系统', remark || null]
  );
}

async function logRequest(taskId, direction, payload, model) {
  await getDb().run(
    'INSERT INTO request_logs (task_id, direction, payload, model) VALUES (?, ?, ?::jsonb, ?)',
    [taskId, direction, JSON.stringify(payload), model || null]
  );
}

/** 上游请求接入 → 创建 pending 任务 */
async function createTaskFromRequest({ parsed, chatId, created }) {
  const db = getDb();
  const priority = parsed.extra.priority || 'medium';
  const projectCode = parsed.extra.project_code || null;
  const metaTags = parsed.extra.meta_tags || parsed.extra.meta || null;
  const payload = { ...parsed, created };

  const { lastId } = await db.run(
    `INSERT INTO tasks
       (upstream_request_id, model, stream, priority, project_code, meta_tags, request_payload, status, timeout_at)
     VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, 'pending', NOW() + interval '1 minute' * ?)`,
    [chatId, parsed.model, parsed.stream, priority, projectCode,
      metaTags ? JSON.stringify(metaTags) : null,
      JSON.stringify(payload),
      PENDING_MIN()]
  );
  await addLog(lastId, 'create', null, { status: 'pending' }, null, '系统', '上游请求接入');
  ws.broadcast('task:new', { id: lastId });
  return { taskId: lastId };
}

/** 状态流转核心：校验合法性 + 写审计 + 更新 + 推送 */
async function transition(taskId, to, actor, remark, updates = {}) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, message: '任务不存在' };
  if (!TRANSITIONS[task.status].includes(to)) {
    return { ok: false, message: `非法状态流转: ${task.status} → ${to}` };
  }
  await addLog(taskId, to, { status: task.status }, { status: to, ...updates }, actor, remark);

  const params = [to]; // $1 = status
  let pi = 1;
  const pieces = ['status = $1', 'updated_at = NOW()'];
  for (const [k, v] of Object.entries(updates)) {
    if (v && v.__expr) {
      pieces.push(`${k} = ${v.__expr}`);
    } else {
      pi++;
      params.push(v);
      pieces.push(`${k} = $${pi}`);
    }
  }
  pi++;
  params.push(taskId);
  const sql = `UPDATE tasks SET ${pieces.join(', ')} WHERE id = $${pi}`;
  await getDb().run(sql, params);
  ws.broadcast('task:update', { id: taskId, status: to });
  return { ok: true, task: await getTask(taskId) };
}

/** 工程师接单：pending/returned → processing */
async function claimTask(taskId, engineerId, engineerName) {
  return transition(taskId, STATUS.PROCESSING, { id: engineerId, name: engineerName }, '工程师接单', {
    assignee_id: engineerId,
    claimed_at: now(),
    result_text: null,
    result_payload: null,
    reject_reason: null,
    timeout_at: afterMin(PROCESSING_MIN()),
  });
}

/** 提交结果：processing → completed */
async function completeTask(taskId, content, actor) {
  const t = await transition(taskId, STATUS.COMPLETED, actor, '提交结果', {
    result_text: content,
    result_payload: JSON.stringify({ content }),
    completed_at: now(),
    timeout_at: null,
  });
  if (t.ok) {
    await logRequest(taskId, 'out', { content, model: t.task.model }, t.task.model);
    resolveWaiter(taskId, { completed: true, content, model: t.task.model, task: t.task });
  }
  return t;
}

/** 驳回重写：processing → returned（可二次修改上下文后重派） */
async function rejectTask(taskId, reason, actor) {
  const t = await transition(taskId, STATUS.RETURNED, actor, reason || '驳回', {
    reject_reason: reason || '未填写原因',
    assignee_id: null,
    claimed_at: null,
    timeout_at: null,
  });
  if (t.ok) {
    resolveWaiter(taskId, {
      completed: false, status: STATUS.RETURNED,
      content: `任务被驳回: ${reason || '工程师要求补充说明'}`, task: t.task,
    });
  }
  return t;
}

/** 暂停：processing → paused */
async function pauseTask(taskId, reason, actor) {
  return transition(taskId, STATUS.PAUSED, actor, reason || '暂停', { paused_reason: reason || null });
}

/** 恢复：paused → processing */
async function resumeTask(taskId, actor) {
  return transition(taskId, STATUS.PROCESSING, actor, '恢复处理', {
    paused_reason: null,
    timeout_at: afterMin(PROCESSING_MIN()),
  });
}

/** 二次修改上下文后重新派发：returned/paused → pending */
async function requeueTask(taskId, newPayload, actor) {
  const t = await getTask(taskId);
  if (!t) return { ok: false, message: '任务不存在' };
  const payload = newPayload || t.request_payload;
  const res = await transition(taskId, STATUS.PENDING, actor, '修改上下文后重新派发', {
    request_payload: expr(`'${escapeSql(JSON.stringify(payload))}'::jsonb`),
    reject_reason: null,
    assignee_id: null,
    claimed_at: null,
    timeout_at: afterMin(PENDING_MIN()),
  });
  if (res.ok) ws.broadcast('task:new', { id: taskId });
  return res;
}

function escapeSql(s) { return String(s).replace(/'/g, "''"); }

/** 取消：任意非终态 → cancelled */
async function cancelTask(taskId, actor) {
  return transition(taskId, STATUS.CANCELLED, actor, '取消任务', { timeout_at: null });
}

/** /v1 接口挂起等待（Promise，超时兜底） */
function waitForTask(taskId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(taskId);
      resolve({ timedOut: true, content: '请求等待超时，任务仍在处理中，可稍后查询', task: null });
    }, timeoutMs);
    waiters.set(taskId, { resolve, timer });
  });
}

function resolveWaiter(taskId, result) {
  const w = waiters.get(taskId);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(taskId);
    w.resolve(result);
  }
}

/** 超时处理：pending/processing 超时 → returned + 告警 */
async function timeoutTask(taskId, phase) {
  const label = phase === 'pending' ? '待接单' : '处理中';
  const t = await transition(taskId, STATUS.RETURNED, null, `${label}超时自动归还`, {
    reject_reason: `${label}超时`,
    assignee_id: null,
    claimed_at: null,
    timeout_at: null,
  });
  if (t.ok) {
    ws.broadcast('task:timeout', { id: taskId, phase });
    resolveWaiter(taskId, { completed: false, status: STATUS.RETURNED, content: `任务${label}超时`, task: t.task });
  }
}

/** 启动超时扫描（每 30 秒） */
function startTimeoutScanner() {
  setInterval(async () => {
    const db = getDb();
    try {
      const p = await db.exec(`SELECT id FROM tasks WHERE status = 'pending' AND timeout_at IS NOT NULL AND timeout_at < NOW()`, []);
      for (const row of p[0] ? p[0].values : []) await timeoutTask(row[0], 'pending');
      const pr = await db.exec(`SELECT id FROM tasks WHERE status = 'processing' AND timeout_at IS NOT NULL AND timeout_at < NOW()`, []);
      for (const row of pr[0] ? pr[0].values : []) await timeoutTask(row[0], 'processing');
    } catch (e) {
      console.error('[超时扫描失败]', e.message);
    }
  }, 30000);
}

module.exports = {
  STATUS, TRANSITIONS, getTask, rows, addLog, logRequest,
  createTaskFromRequest, transition, claimTask, completeTask,
  rejectTask, pauseTask, resumeTask, requeueTask, cancelTask,
  waitForTask, startTimeoutScanner,
};
