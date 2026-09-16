/**
 * 任务事件总线（进程内）
 *
 * 任务状态流转时发布，供 /v1 SSE 中途推送订阅。
 * 与 websocket.js 的区别：websocket 面向工作台浏览器，这里是面向「上游 agent 的 HTTP SSE 流」。
 */
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // 同一任务可能被多个上游订阅

/** 发布任务状态流转 */
function publish(taskId, payload) {
  emitter.emit('task:' + taskId, payload);
}

/** 订阅某任务的状态流转，返回取消订阅函数 */
function subscribe(taskId, fn) {
  const key = 'task:' + taskId;
  emitter.on(key, fn);
  return () => emitter.off(key, fn);
}

/** 当前订阅者数量（调试/测试用） */
function listenerCount(taskId) {
  return emitter.listenerCount('task:' + taskId);
}

module.exports = { publish, subscribe, listenerCount };
