/**
 * 上游完成回调（接入层：任务终态主动推送，上游无需轮询）
 *
 * 上游在请求体带 callback_url 时，任务进入终态（completed/returned/cancelled）后
 * 主动 POST 结果到该地址，省去 GET /v1/tasks/:id 轮询。
 *
 * .env：CALLBACK_ENABLED（默认 true）/ CALLBACK_TIMEOUT_MS（默认 5000）
 * 降级安全：未配置或投递失败只记日志，绝不阻塞任务主流程。
 */
const { buildTaskView } = require('./taskView');

/** 终态 → 事件名 */
const TERMINAL_EVENTS = {
  completed: 'task.completed',
  returned: 'task.returned',
  cancelled: 'task.cancelled',
};

function enabled() {
  return String(process.env.CALLBACK_ENABLED || 'true') !== 'false';
}

/** 仅允许 http/https（回环/内网地址不拦：上游 agent 常部署在内网） */
function isAllowedUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * 任务终态回调
 * @param {Object} task 任务行（需含 callback_url/status 等字段）
 * @returns {Promise<{ok:boolean, skipped?:boolean, status?:number, error?:string}>}
 */
async function notify(task) {
  const event = task && TERMINAL_EVENTS[task.status];
  if (!event) return { ok: false, skipped: true };
  const url = task.callback_url;
  if (!url) return { ok: false, skipped: true };
  if (!enabled()) return { ok: false, skipped: true };
  if (!isAllowedUrl(url)) {
    console.error(`[上游回调跳过] task=${task.id} callback_url 非法（仅支持 http/https）`);
    return { ok: false, skipped: true };
  }

  const body = { event, ...(await buildTaskView(task)) };
  const ms = parseInt(process.env.CALLBACK_TIMEOUT_MS, 10) || 5000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'p390-callback/1.0' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) console.error(`[上游回调失败] task=${task.id} HTTP ${res.status}`);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error(`[上游回调失败] task=${task.id}`, e.message);
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { notify, enabled, isAllowedUrl, TERMINAL_EVENTS };
