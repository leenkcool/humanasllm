/**
 * 任务队列服务
 * 状态机：pending → processing → completed | returned
 *              ↑_________________|          │
 *              └── 驳回/超时/暂停后可重新派发 ┘
 * 内存等待者 Map：/v1/chat/completions 挂起等待，工程师完成后唤醒返回
 */
require('dotenv').config();
const crypto = require('crypto');
const { getDb } = require('../db');
const ws = require('./websocket');
const aiRelay = require('./aiRelay');
const { TASK_TRANSITIONS } = require('./stateMachine');
const { createWaiterStore } = require('./waiters');
const { classify } = require('./categoryEngine');
const notifier = require('./notifier');

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

// SLA 分级：环境变量/默认作基准，按优先级比例调整（high 紧迫×0.5、low 放宽×2），治理层「差异化 SLA」
function timeoutMinutes(phase, priority) {
  const p = priority || 'medium';
  const base = phase === 'pending' ? PENDING_MIN() : PROCESSING_MIN();
  const ratio = { high: 0.5, medium: 1, low: 2 }[p] || 1;
  return Math.max(5, Math.round(base * ratio));
}

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

/** 人工产出质量校验：拦截空 / 过短 / 占位乱答；运维/涉密类允许简短（另附验收说明，见 completeTask） */
const MIN_RESULT_LEN = 20;
const MIN_OPS_LEN = 10;
const PLACEHOLDER_RE = /^(完成|已完|已ok|ok|done|finish|好的|嗯|你检查吧|稍后|待会儿|待补|待完善)[。．.！!\s]*$/i;
function qualityCheck(content, category = 'general') {
  const c = String(content == null ? '' : content).trim();
  if (!c) return '提交内容不能为空';
  const minLen = (category === 'ops' || category === 'confidential') ? MIN_OPS_LEN : MIN_RESULT_LEN;
  if (c.length < minLen) return `产出过短（${c.length} 字符，至少 ${minLen}），请补充实际内容`;
  if (PLACEHOLDER_RE.test(c)) return '疑似占位/乱答复，请提交实际实现内容';
  return null;
}

async function getTask(id) {
  const r = await getDb().exec('SELECT * FROM tasks WHERE id = ?', [id]);
  const list = rows(r);
  return list[0] || null;
}

/** 确定性序列化：对象键排序，保证哈希与 DB jsonb 存储顺序无关（pg jsonb 存储时按键排序） */
function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** 确定性序列化（INSERT 传对象 / SELECT jsonb 字符串 → 统一对象再序列化，保证哈希一致） */
function norm(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } }
  return v;
}
const hashPayload = (p) => crypto.createHash('sha256').update(stableJson(p)).digest('hex');

/** 审计留痕（哈希链防篡改：每条 log 含 prev_hash + hash，可验证完整性） */
async function addLog(taskId, action, oldValue, newValue, actor, remark) {
  const db = getDb();
  const actorName = actor ? actor.name || actor.username : '系统';
  const rem = remark || null;
  const last = rows(await db.exec('SELECT hash FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId]));
  const prevHash = last[0] ? last[0].hash : null;
  const hash = hashPayload({ prevHash, action, oldValue: norm(oldValue), newValue: norm(newValue), actor: actorName, remark: rem });
  await db.run(
    `INSERT INTO task_logs (task_id, action, old_value, new_value, actor_id, actor_name, remark, prev_hash, hash)
     VALUES (?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?)`,
    [taskId, action,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      actor ? actor.id : null, actorName, rem, prevHash, hash]
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
  // 多租户：上游 /v1 无 JWT，任务归默认租户（租户路由见工作台）
  const defTenant = rows(await getDb().exec('SELECT id FROM tenants WHERE code = ?', ['default']))[0];
  const tenantId = defTenant ? defTenant.id : null;

  const { lastId } = await db.run(
    `INSERT INTO tasks
       (upstream_request_id, model, stream, priority, category, rule_id, project_code, meta_tags, request_payload, status, timeout_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, 'pending', NOW() + interval '1 minute' * ?, ?)`,
    [chatId, parsed.model, parsed.stream, priority, category, ruleId, projectCode,
      metaTags ? JSON.stringify(metaTags) : null,
      JSON.stringify(payload),
      timeoutMinutes('pending', priority), tenantId]
  );
  await addLog(lastId, 'create', null, { status: 'pending' }, null, '上游请求接入');
  ws.broadcast('task:new', { id: lastId });
  const firstUser = parsed.messages.find(m => m.role === 'user');
  const summary = firstUser && typeof firstUser.content === 'string' ? firstUser.content.slice(0, 60) : '';
  notifier.send({
    event: 'task:new', title: `新人工任务 #${lastId}`,
    text: `优先级 ${priority} / 类别 ${category}${summary ? '\n' + summary : ''}`, taskId: lastId,
  });
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

/** 工程师接单：pending/returned → processing（按优先级差异化 SLA 超时） */
async function claimTask(taskId, engineerId, engineerName) {
  const task = await getTask(taskId);
  const priority = (task && task.priority) || 'medium';
  return transition(taskId, STATUS.PROCESSING, { id: engineerId, name: engineerName }, '工程师接单', {
    assignee_id: engineerId,
    claimed_at: now(),
    result_text: null,
    result_payload: null,
    reject_reason: null,
    timeout_at: afterMin(timeoutMinutes('processing', priority)),
  });
}

/** 提交结果：processing → completed（先过质量校验；运维/涉密类需人工验收单） */
async function completeTask(taskId, content, actor, opts = {}) {
  const task = await getTask(taskId);
  const category = (task && task.category) || 'general';
  const bad = qualityCheck(content, category);
  if (bad) return { ok: false, message: bad };
  // 治理层「质量是人的标准」：运维/涉密类提交需附验收说明（做了什么 + 自检结果），允许简短产出但拦截占位
  if (category !== 'general') {
    const note = String(opts.completion_note || '').trim();
    if (!note) return { ok: false, message: '运维/涉密任务需附验收说明（做了什么、自检结果）' };
    if (PLACEHOLDER_RE.test(note)) return { ok: false, message: '验收说明疑似占位，请填写实际完成情况' };
  }
  const t = await transition(taskId, STATUS.COMPLETED, actor, '提交结果', {
    result_text: content,
    result_payload: JSON.stringify({ content, completion_note: opts.completion_note || null }),
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

/** 恢复：paused → processing（按优先级差异化 SLA 超时） */
async function resumeTask(taskId, actor) {
  const task = await getTask(taskId);
  const priority = (task && task.priority) || 'medium';
  return transition(taskId, STATUS.PROCESSING, actor, '恢复处理', {
    paused_reason: null,
    timeout_at: afterMin(timeoutMinutes('processing', priority)),
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
    // 通知：涉密/运维类不 AI 代答，需人工重派；general 类 AI 兜底失败也通知
    const cat = (t.task && t.task.category) || 'general';
    notifier.send({
      event: 'task:timeout', title: `任务 #${taskId} ${label}超时`,
      text: `类别 ${cat}${cat === 'general' ? '（AI 兜底失败，需人工重派）' : '（涉密/运维类不 AI 代答，需人工改上下文重派）'}`,
      taskId,
    });
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

/** 校验任务审计哈希链完整性（治理层「留痕是人的证据」，可证明未被篡改） */
async function verifyAuditChain(taskId) {
  const logs = rows(await getDb().exec('SELECT * FROM task_logs WHERE task_id = ? ORDER BY id', [taskId]));
  let prevHash = null, valid = true, brokenAt = null;
  for (const l of logs) {
    const h = hashPayload({
      prevHash: l.prev_hash, action: l.action,
      oldValue: norm(l.old_value), newValue: norm(l.new_value),
      actor: l.actor_name || '系统', remark: l.remark || null,
    });
    if (h !== l.hash) { valid = false; brokenAt = l.id; break; }
    prevHash = l.hash;
  }
  return { valid, broken_at: brokenAt, count: logs.length };
}

module.exports = {
  STATUS, TRANSITIONS, getTask, rows, addLog, logRequest,
  createTaskFromRequest, transition, claimTask, completeTask,
  rejectTask, pauseTask, resumeTask, requeueTask, cancelTask, reopenTask,
  qualityCheck, waitForTask, startTimeoutScanner, timeoutTask, verifyAuditChain,
};
