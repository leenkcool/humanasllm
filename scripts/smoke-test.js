/**
 * p390 冒烟测试（自动化回归）
 * 用法：node scripts/smoke-test.js    （需服务已启动于 39000）
 * 覆盖：health / models / 登录 / 人工任务完整流程(创建→接单→占位拦截→完成→OpenAI返回) /
 *       审批流程(创建→批准) / 项目(建/申请) / CSV 导出 / 非法流转拦截
 * 结束自动清理本次创建的测试数据。全过退出码 0，有失败 1。
 */
require('dotenv').config();
const { initDatabase, getDb } = require('../db');

const BASE = 'http://127.0.0.1:39000';
const MARK = 'smoke';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  | ' + extra : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function poll(fn, max = 20) {
  for (let i = 0; i < max; i++) {
    const r = await fn();
    if (r) return r;
    await sleep(500);
  }
  return null;
}

(async () => {
  console.log('\n=== p390 冒烟测试 ===');
  await initDatabase();

  // 1. 基础
  const h = await api('GET', '/api/health');
  ok('health 200', h.status === 200 && h.data.status === 'ok');
  const m = await api('GET', '/v1/models');
  ok('/v1/models 含 human-llm', m.status === 200 && (m.data.data || []).some(x => x.id === 'human-llm'));

  // 2. 登录 + 工作台
  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  ok('admin 登录', login.status === 200 && login.data.success && !!login.data.data.token);
  const token = login.data.data.token;
  const w = await api('GET', '/api/workbench/summary', null, token);
  ok('workbench/summary', w.status === 200 && w.data.success);

  // 3. 人工任务完整流程（/v1 挂起 → 工作台完成 → 返回 OpenAI 结构）
  const chatPromise = api('POST', '/v1/chat/completions', {
    model: 'human-llm', stream: false, priority: 'low', project_code: MARK,
    messages: [{ role: 'user', content: '冒烟测试任务' }],
  });
  const taskId = await poll(async () => {
    const l = await api('GET', '/api/tasks?status=pending&size=5', null, token);
    const t = ((l.data.data && l.data.data.data) || []).find(x => x.project_code === MARK);
    return t ? t.id : null;
  });
  ok('人工任务已创建(pending)', !!taskId, 'taskId=' + taskId);

  if (taskId) {
    const c = await api('POST', '/api/tasks/' + taskId + '/claim', {}, token);
    ok('接单 → processing', c.status === 200 && c.data.data.status === 'processing');
    const bad = await api('POST', '/api/tasks/' + taskId + '/complete', { content: '完成' }, token);
    ok('质量校验拦截占位(400)', bad.status === 400 && !bad.data.success);
    const comp = await api('POST', '/api/tasks/' + taskId + '/complete',
      { content: '冒烟测试产出：核心链路正常（接单→提交→等待者唤醒→返回）' }, token);
    ok('提交真实产出 → completed', comp.status === 200 && comp.data.data.status === 'completed');
    const chat = await chatPromise;
    ok('/v1 返回 OpenAI 结构', chat.status === 200 &&
      (chat.data.choices || [])[0]?.message?.content.includes('冒烟测试产出'));
    const bad2 = await api('POST', '/api/tasks/' + taskId + '/claim', {}, token);
    ok('非法流转拦截(completed→claim 400)', bad2.status === 400);
  } else {
    ok('人工任务已创建(pending)', false, '未在超时窗口找到');
  }

  // 4. 审批流程（/v1 挂起 → 工作台批准 → 返回 approved）
  const apprPromise = api('POST', '/v1/approvals', {
    resource: '冒烟审批', amount: '1', purpose: '冒烟测试', requester: MARK,
  });
  const apprId = await poll(async () => {
    const l = await api('GET', '/api/approvals?status=pending&size=5', null, token);
    const a = ((l.data.data && l.data.data.data) || []).find(x => x.requester === MARK);
    return a ? a.id : null;
  });
  ok('审批已创建(pending)', !!apprId, 'apprId=' + apprId);
  if (apprId) {
    await api('POST', '/api/approvals/' + apprId + '/approve', { provided: '已提供' }, token);
    const appr = await apprPromise;
    ok('/v1 审批返回 approved', appr.status === 200 && appr.data.status === 'approved');
  }

  // 5. 项目
  const pj = await api('POST', '/api/projects', { code: 'smoke-proj', name: '冒烟项目' }, token);
  ok('管理员建项目', pj.status === 200 && pj.data.success);
  const ap = await api('POST', '/api/projects/apply', { code: 'smoke-proj2', name: '冒烟项目2' }, token);
  ok('申请建项目(走审批)', ap.status === 200 && ap.data.success);

  // 6. CSV 导出
  const csvRes = await fetch(BASE + '/api/tasks/export', { headers: { Authorization: 'Bearer ' + token } });
  const csvBuf = await csvRes.arrayBuffer();
  const csvBytes = new Uint8Array(csvBuf);
  const csvText = new TextDecoder('utf-8').decode(csvBuf);
  ok('CSV 导出(BOM字节+表头)', csvRes.status === 200 && csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF && csvText.includes('id,'));
  const noAuth = await fetch(BASE + '/api/tasks/export');
  ok('CSV 未带 token 401', noAuth.status === 401);

  // 7. 清理本次创建的测试数据
  const db = getDb();
  await db.run(`DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM request_logs WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM tasks WHERE project_code = $1`, [MARK]);
  await db.run(`DELETE FROM approvals WHERE requester = $1`, [MARK]);
  await db.run(`DELETE FROM projects WHERE code LIKE 'smoke-%'`, []);
  console.log('  （已清理冒烟测试数据）');

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('冒烟测试异常:', e.message); process.exit(1); });
