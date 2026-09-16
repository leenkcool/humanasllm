/**
 * tools / function calling 支持
 *
 * 上游在 /v1 请求声明 `tools`（OpenAI 函数定义），人工产出可回填 `tool_calls`，
 * 由 /v1/tasks/:id 回查与完成回调按 OpenAI 原生结构返回，agent 直接执行即可。
 *
 * 安全：只允许调用「本任务声明过的函数」，未声明一律拒绝（防人工误填/越权调用）。
 */
const crypto = require('crypto');

/** 本任务声明的函数名（request_payload.tools 为 OpenAI 格式） */
function declaredNames(task) {
  const tools = (task && task.request_payload && task.request_payload.tools) || [];
  return tools
    .map(t => (t && t.function && t.function.name) || null)
    .filter(Boolean);
}

/** 本任务声明的函数定义（工作台展示用） */
function declaredTools(task) {
  const tools = (task && task.request_payload && task.request_payload.tools) || [];
  return tools.filter(t => t && t.type === 'function' && t.function && t.function.name);
}

/**
 * 归一化人工提交的函数调用 → OpenAI tool_calls 结构
 * @param {Object} task 任务行
 * @param {Object|Array|null} input {name, arguments} 或数组
 * @returns {{ok:boolean, message?:string, tool_calls?:Array}}
 */
function normalize(task, input) {
  if (input === undefined || input === null) return { ok: true, tool_calls: [] };
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) return { ok: true, tool_calls: [] };
  const names = declaredNames(task);
  const out = [];
  for (const raw of list) {
    const name = raw && (raw.name || (raw.function && raw.function.name));
    if (!name) return { ok: false, message: '函数调用缺少 name' };
    if (!names.includes(name)) {
      return { ok: false, message: `未声明的函数: ${name}（本任务声明的函数: ${names.join(', ') || '无'}）` };
    }
    let args = raw.arguments !== undefined ? raw.arguments : (raw.function && raw.function.arguments);
    if (args === undefined || args === null) args = {};
    if (typeof args === 'string') {
      try { JSON.parse(args); } catch (e) { return { ok: false, message: `函数 ${name} 的 arguments 不是合法 JSON` }; }
    } else {
      args = JSON.stringify(args);
    }
    out.push({
      id: 'call_' + crypto.randomBytes(8).toString('hex'),
      type: 'function',
      function: { name, arguments: args },
    });
  }
  return { ok: true, tool_calls: out };
}

module.exports = { declaredNames, declaredTools, normalize };
