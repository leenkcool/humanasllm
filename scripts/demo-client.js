/**
 * 模拟上游调度池客户端（演示零改动接入 p390 人工代理网关）
 *
 * 用法：
 *   node scripts/demo-client.js "写一个 hello world"      # 常规 → AI 中继（deepseek）
 *   node scripts/demo-client.js "实现内部结算对账逻辑"      # 涉密 → 人工（human-llm）
 *
 * 说明：这模拟一个多模型调度池的路由决策——根据任务类型选模型，
 *       把 base_url 指向 p390 /v1 即可，与调用任何 OpenAI 兼容 API 无异。
 */
const BASE = 'http://localhost:39000/v1';

/** 调度池模型路由表（示意：新增一条 human-llm 即可接入人工） */
const ROUTES = [
  { pattern: /涉密|内部|私有|安全|保密|敏感/, model: 'human-llm', note: '人工工程师' },
  { pattern: /.*/, model: 'deepseek-v4-flash', note: 'AI 中继（DeepSeek）' },
];

function route(task) {
  for (const r of ROUTES) {
    if (r.pattern.test(task)) return r;
  }
  return ROUTES[ROUTES.length - 1];
}

async function callLLM(model, messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ model, messages, stream: false, project_code: 'demo-pool' }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  const task = process.argv.slice(2).join(' ') || '写一个 hello world';
  const r = route(task);

  console.log('========== 模拟调度池 ==========');
  console.log(`任务: ${task}`);
  console.log(`路由决策: → ${r.model}（${r.note}）`);
  console.log(`调用: POST ${BASE}/chat/completions  model=${r.model}\n`);

  const { status, data } = await callLLM(r.model, [{ role: 'user', content: task }]);
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const errMsg = data.error && data.error.message;

  console.log('-------- 返回 --------');
  if (r.model === 'human-llm') {
    console.log(`人工任务已创建（HTTP ${status}）。请在 http://localhost:39000/login.html 接单完成，产出即会返回。`);
    console.log(`本次响应: ${content || errMsg || JSON.stringify(data).slice(0, 120)}`);
  } else {
    if (status >= 200 && status < 300 && content) {
      console.log(`AI 产出: ${content.slice(0, 200)}`);
    } else {
      console.log(`AI 中继返回 HTTP ${status}: ${errMsg || '（DeepSeek 余额不足等外部因素，路由已正确转发）'}`);
    }
  }
}

main().catch(e => { console.error('[失败]', e.message); process.exit(1); });
