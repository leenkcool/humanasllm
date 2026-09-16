/**
 * /v1 SSE 中途状态推送（opt-in）
 *
 * 上游在请求体传 `stream_events: true` 时：保持 SSE 连接打开，任务状态流转实时推送，
 * 终态（completed/returned/cancelled）推 `data: [DONE]` 并关闭。上游无需轮询。
 *
 * 不传该字段时行为不变（立即回受理信息 + [DONE]），对既有上游零破坏。
 *
 * .env：SSE_HEARTBEAT_MS（保活注释间隔，默认 15000）/ SSE_EVENTS_MAX_MIN（最长保持分钟，默认 60）
 */
const taskEvents = require('./taskEvents');
const taskView = require('./taskView');
const encoder = require('./openaiEncoder');

/** 终态：推送后关闭流 */
const TERMINAL = ['completed', 'returned', 'cancelled'];

function heartbeatMs() { return parseInt(process.env.SSE_HEARTBEAT_MS, 10) || 15000; }
function maxStreamMs() { return (parseInt(process.env.SSE_EVENTS_MAX_MIN, 10) || 60) * 60 * 1000; }

/**
 * 建立任务事件 SSE 流（调用方已建单）
 * @param {Object} req 请求
 * @param {Object} res 响应
 * @param {Object} opts { taskId, model, created }
 */
function streamTaskEvents(req, res, { taskId, model, created }) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 反代不缓冲，保证实时
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  let hb = null;
  let cap = null;
  let unsub = () => {};

  const write = (obj) => { if (!closed) res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (hb) clearInterval(hb);
    if (cap) clearTimeout(cap);
    unsub();
  };
  const finish = () => {
    if (closed) return;
    res.write('data: [DONE]\n\n');
    res.end();
    cleanup();
  };

  // 受理事件（OpenAI chunk 结构，兼容既有 SSE 解析）
  write({
    id: encoder.makeId(), object: 'chat.completion.chunk', created, model,
    task_id: taskId, status: 'pending', event: 'task.accepted',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  // 状态流转 → 推送（含终态产出）
  unsub = taskEvents.subscribe(taskId, async ({ status, task }) => {
    if (closed) return;
    try {
      write({ object: 'task.event', event: 'task.' + status, ...(await taskView.buildTaskView(task)) });
    } catch (e) {
      console.error('[SSE 推送失败]', taskId, e.message);
    }
    if (TERMINAL.includes(status)) finish();
  });

  // 保活（防代理超时断连）
  hb = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, heartbeatMs());
  // 最长保持：到点未终态则告知后关闭，上游可凭 task_id 继续回查
  cap = setTimeout(() => {
    if (closed) return;
    write({ object: 'task.event', event: 'task.stream_timeout', task_id: taskId, status: 'pending' });
    finish();
  }, maxStreamMs());

  req.on('close', cleanup);
}

module.exports = { streamTaskEvents, TERMINAL };
