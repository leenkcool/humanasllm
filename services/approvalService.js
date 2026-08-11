/**
 * 审批服务（AI 提审批 → 人类批准/驳回 → 返回结果）
 * 场景：agent 需要服务器/环境/权限等资源时向人类提审批，人类采购/准备后提供
 * 状态机：pending → approved | rejected
 * 内存等待者 Map：/v1/approvals 挂起等待，人类审批后唤醒返回
 */
require('dotenv').config();
const { getDb } = require('../db');
const ws = require('./websocket');
const notifier = require('./notifier');
const { APPROVAL_TRANSITIONS } = require('./stateMachine');
const { createWaiterStore } = require('./waiters');

const STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' };

// 状态机合法转换表（独立单例，见 services/stateMachine.js）
const TRANSITIONS = APPROVAL_TRANSITIONS;

// 等待者：approvalId → { resolve, timer }（通用 store，见 services/waiters.js）
const waiters = createWaiterStore();

function rows(result) {
  if (!result || !result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    if (typeof obj.meta_tags === 'string' && obj.meta_tags) {
      try { obj.meta_tags = JSON.parse(obj.meta_tags); } catch (e) { obj.meta_tags = null; }
    }
    return obj;
  });
}

async function getApproval(id) {
  const r = await getDb().exec('SELECT * FROM approvals WHERE id = ?', [id]);
  const list = rows(r);
  return list[0] || null;
}

/** 按 approval_no 查（上游 /v1 回查用） */
async function getApprovalByNo(no) {
  const r = await getDb().exec('SELECT * FROM approvals WHERE approval_no = ?', [no]);
  const list = rows(r);
  return list[0] || null;
}

async function listApprovals({ status, page = 1, size = 20 }) {
  const db = getDb();
  const where = [];
  const params = [];
  if (status && STATUS[status.toUpperCase()]) { where.push('status = ?'); params.push(status); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const count = await db.exec(`SELECT COUNT(*) AS c FROM approvals ${whereSql}`, params);
  const total = count[0].values[0][0];
  const offset = (page - 1) * size;
  const list = rows(await db.exec(
    `SELECT * FROM approvals ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, size, offset]
  ));
  return { data: list, total, page, size };
}

function makeNo() {
  return 'appr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** AI 发起审批请求 → pending（type: resource=资源申请 / project=项目创建申请） */
async function createApproval({ type = 'resource', resource, amount, purpose, detail, requester, project_code, meta_tags }) {
  const db = getDb();
  const no = makeNo();
  const { lastId } = await db.run(
    `INSERT INTO approvals (approval_no, type, resource, amount, purpose, detail, requester, project_code, meta_tags, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'pending')`,
    [no, type, resource || '未指定资源', amount || null, purpose || null, detail || null,
      requester || 'ai-agent', project_code || null,
      meta_tags ? JSON.stringify(meta_tags) : null]
  );
  ws.broadcast('approval:new', { id: lastId, approval_no: no });
  notifier.send({
    event: 'approval:new', title: `新审批待办 ${no}`,
    text: `${resource}${amount ? ' / ' + amount : ''}${purpose ? '\n' + purpose : ''}`,
  });
  return { id: lastId, approval_no: no };
}

async function decide(id, to, updates, actor, resolveResult) {
  const a = await getApproval(id);
  if (!a) return { ok: false, message: '审批单不存在' };
  if (!TRANSITIONS[a.status].includes(to)) {
    return { ok: false, message: `非法状态流转: ${a.status} → ${to}` };
  }
  const sets = ['status = ?', 'provider_id = ?', 'provider_name = ?', 'decided_at = NOW()'];
  const params = [to, actor ? actor.id : null, actor ? actor.name || actor.username : null];
  for (const [k, v] of Object.entries(updates)) {
    if (v && v.__expr) {
      sets.push(`${k} = ${v.__expr}`);
    } else {
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }
  params.push(id);
  await getDb().run(`UPDATE approvals SET ${sets.join(', ')} WHERE id = ?`, params);
  const updated = await getApproval(id);
  ws.broadcast('approval:update', { id, status: to });
  resolveWaiter(id, { approved: to === STATUS.APPROVED, ...resolveResult, approval: updated });
  return { ok: true, approval: updated };
}

/** 人类批准并提供资源 */
async function approve(id, provided, actor) {
  return decide(id, STATUS.APPROVED, { provided: provided || null }, actor, { provided: provided || null });
}

/** 人类驳回 */
async function reject(id, reason, actor) {
  return decide(id, STATUS.REJECTED, { reject_reason: reason || '未说明原因' }, actor, { reject_reason: reason || '未说明原因' });
}

/** /v1/approvals 挂起等待 */
function waitForApproval(id, timeoutMs) {
  return waiters.wait(id, timeoutMs, () => ({
    timedOut: true, message: '审批等待超时，审批单仍在处理中，可稍后查询', approval: null,
  }));
}

function resolveWaiter(id, result) {
  waiters.resolve(id, result);
}

/** 待审批超时提醒（每 60 秒扫描一次，超过 24h 未处理的标红提醒） */
function startApprovalScanner() {
  setInterval(async () => {
    try {
      const r = await getDb().exec(
        `SELECT id FROM approvals WHERE status = 'pending' AND created_at < NOW() - interval '24 hours'`
      );
      for (const row of (r[0] ? r[0].values : [])) {
        ws.broadcast('approval:overdue', { id: row[0] });
        notifier.send({ event: 'approval:overdue', title: `审批超时 #${row[0]}`, text: '已超 24h 未处理，请及时审批' });
      }
    } catch (e) {
      console.error('[审批超时扫描失败]', e.message);
    }
  }, 60000);
}

module.exports = {
  STATUS, TRANSITIONS, getApproval, getApprovalByNo, listApprovals,
  createApproval, approve, reject, waitForApproval, startApprovalScanner,
};
