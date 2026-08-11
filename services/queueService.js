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
const aiRelay = require('./aiRelay');
const { TASK_TRANSITIONS } = require('./stateMachine');
const { createWaiterStore } = require('./waiters');
const { classify } = require('./categoryEngine');

const STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  RETURNED: 'returned',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
};

// 状态机合法转换表（独立单例，见 services/stateMachine.js）
const TRANSITIONS = TASK_TRANSITIONS;

// 等待者：taskId → { resolve, timer }（通用 store，见 services/waiters.js）
const waiters = createWaiterStore();

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

/** 人工产出质量校验：拦截空 / 过短 / 占位乱答 */
const MIN_RESULT_LEN = 20;
const PLACEHOLDER_RE = /^(完成|已完|已ok|ok|done|finish|好的|嗯|你检查吧|稍后|待会儿|待补|待完善)[。．.！!\s]*$/i;
function qualityCheck(content) {
  const c = String(content == null ? '' : content).trim();
  if (!c) return '提交内容不能为空';
  if (c.length < MIN_RESULT_LEN) return `产出过短（${c.length} 字符，至少 ${MIN_RESULT_LEN}），请补充实际实现内容`;
  if (PLACEHOLDER_RE.test(c)) return '疑似占位/乱答复，请提交实际实现内容';
  return null;
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
  // 分级策略引擎定级（规则白名单锁死 > 上游显式 > 默认 general），rule_id 留痕分级理由
  const cat = await classify({ messages: parsed.messages, body: parsed.extra });
  const category = cat.category;
  const ruleId = cat.rule_id;
  const projectCode = parsed.extra.project_code || null;
  const metaTags = parsed.extra.meta_tags || parsed.extra.meta || null;
  const payload = { ...parsed, created };

  const { lastId } = await db.run(
    `INSERT INTO tasks
       (upstream_request_id, model, stream, priority, category, rule_id, project_code, meta_tags, request_payload, status, timeout_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, 'pending', NOW() + interval '1 minute' * ?)`,
    [chatId, parsed.model, parsed.stream, priority, category, ruleId, projectCode,
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

/** 提交结果：processing → completed（先过质量校验） */
async function completeTask(taskId, content, actor) {
  const bad = qualityCheck(content);
  if (bad) return { ok: false, message: bad };
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

/** 打回重做：completed → returned（产出不合格/乱答，清空结果重新派发） */
async function reopenTask(taskId, reason, actor) {
  return transition(taskId, STATUS.RETURNED, actor, reason || '产出不合格打回重做', {
    reject_reason: reason || '产出不合格，打回重做',
    assignee_id: null,
    claimed_at: null,
    completed_at: null,
    result_text: null,
    result_payload: null,
    timeout_at: afterMin(PENDING_MIN()),
  });
}

/** /v1 接口挂起等待（Promise，超时兜底） */
function waitForTask(taskId, timeoutMs) {
  return waiters.wait(taskId, timeoutMs, () => ({
    timedOut: true, content: '请求等待超时，任务仍在处理中，可稍后查询', task: null,
  }));
}

function resolveWaiter(taskId, result) {
  waiters.resolve(taskId, result);
}

/** 超时处理：待接单超时优先 AI 降级代答，失败回落 returned；处理中超时 → returned */
async function timeoutTask(taskId, phase) {
  const label = phase === 'pending' ? '待接单' : '处理中';

  // 待接单超时 → 尝试 AI 降级（人工无人接单时的兜底）
  // 分级策略：仅 general（常规）类允许 AI 代答；涉密/运维类上下文不得喂给公有大模型，直接回落 returned
  if (phase === 'pending') {
    try {
      const task = await getTask(taskId);
      if (task && task.category === 'general' && aiRelay.enabled() && task.request_payload) {
        const data = await aiRelay.chat({ ...task.request_payload, stream: false });
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (content) {
          const t = await transition(taskId, STATUS.COMPLETED, null, '待接单超时·AI 降级代答', {
            result_text: content,
            result_payload: JSON.stringify({ content, source: 'ai-relay' }),
            completed_at: now(),
            timeout_at: null,
          });
          if (t.ok) {
            await logRequest(taskId, 'out', { content, source: 'ai-relay' }, t.task.model);
            ws.broadcast('task:update', { id: taskId, status: 'completed', aiRelay: true });
            ws.broadcast('task:timeout', { id: taskId, phase, aiRelay: true });
            resolveWaiter(taskId, { completed: true, content, model: t.task.model, task: t.task, aiRelay: true });
            return;
          }
        }
      }
    } catch (e) {
      console.error('[AI 降级失败]', taskId, e.message);
    }
    // AI 降级不可用 / 失败 → 回落 returned
  }

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
  rejectTask, pauseTask, resumeTask, requeueTask, cancelTask, reopenTask,
  qualityCheck, waitForTask, startTimeoutScanner, timeoutTask,
};
