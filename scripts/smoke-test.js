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

  // 3. 人工任务完整流程（/v1 异步受理 → 工作台完成 → 回查取结果）
  const chat = await api('POST', '/v1/chat/completions', {
    model: 'human-llm', stream: false, priority: 'low', project_code: MARK,
    messages: [{ role: 'user', content: '冒烟测试任务' }],
  });
  ok('/v1 异步受理返回 task_id', chat.status === 200 && !!chat.data.task_id && chat.data.status === 'pending');
  const taskId = chat.data.task_id;

  if (taskId) {
    const c = await api('POST', '/api/tasks/' + taskId + '/claim', {}, token);
    ok('接单 → processing', c.status === 200 && c.data.data.status === 'processing');
    const bad = await api('POST', '/api/tasks/' + taskId + '/complete', { content: '完成' }, token);
    ok('质量校验拦截占位(400)', bad.status === 400 && !bad.data.success);
    const comp = await api('POST', '/api/tasks/' + taskId + '/complete',
      { content: '冒烟测试产出：核心链路正常（异步受理→接单→提交→回查）' }, token);
    ok('提交真实产出 → completed', comp.status === 200 && comp.data.data.status === 'completed');
    const back = await api('GET', '/v1/tasks/' + taskId);
    ok('/v1 回查取回产出', back.status === 200 && back.data.status === 'completed' &&
      (back.data.content || '').includes('冒烟测试产出'));
    const bad2 = await api('POST', '/api/tasks/' + taskId + '/claim', {}, token);
    ok('非法流转拦截(completed→claim 400)', bad2.status === 400);
  } else {
    ok('/v1 异步受理返回 task_id', false, '未拿到 task_id');
  }

  // 4. 审批流程（/v1 异步受理 → 回查 pending → 工作台批准 → 回查 approved）
  const appr = await api('POST', '/v1/approvals', {
    resource: '冒烟审批', amount: '1', purpose: '冒烟测试', requester: MARK,
  });
  ok('/v1 审批异步受理返回 approval_no', appr.status === 200 && !!appr.data.id && appr.data.status === 'pending');
  const approvalNo = appr.data.id;
  let back = await api('GET', '/v1/approvals/' + approvalNo, null, token);
  ok('/v1 审批回查1 pending', back.status === 200 && back.data.data.status === 'pending');
  const apprId = await poll(async () => {
    const l = await api('GET', '/api/approvals?status=pending&size=5', null, token);
    const a = ((l.data.data && l.data.data.data) || []).find(x => x.requester === MARK);
    return a ? a.id : null;
  });
  ok('审批已创建(pending)', !!apprId, 'apprId=' + apprId);
  if (apprId) {
    await api('POST', '/api/approvals/' + apprId + '/approve', { provided: '已提供' }, token);
    back = await api('GET', '/v1/approvals/' + approvalNo, null, token);
    ok('/v1 审批回查2 approved+provided', back.status === 200 && back.data.data.status === 'approved' && back.data.data.provided === '已提供');
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

  // 7. 治理 / 新功能
  const rules = await api('GET', '/api/rules', null, token);
  ok('分级规则列表', rules.status === 200 && rules.data.data.length >= 7, 'count=' + (rules.data.data || []).length);
  const gov = await api('GET', '/api/workbench/governance', null, token);
  ok('治理概览', gov.status === 200 && gov.data.data.qa && Array.isArray(gov.data.data.engineers) && 'ai_shift' in gov.data.data);
  const report = await api('GET', '/api/audit/report', null, token);
  ok('合规报告', report.status === 200 && !!report.data.data.compliance);
  const ds = await api('GET', '/api/audit/dataset', null, token);
  ok('数据资产导出', ds.status === 200);
  const install = await api('GET', '/api/gateway/install?tool=agents');
  ok('网关安装包(agents→AGENTS.md)', install.status === 200 && install.data.data.files[0].path === 'AGENTS.md');
  const users = await api('GET', '/api/users', null, token);
  const u0 = users.data.data[0];
  ok('用户列表含租户+统计', 'tenant_name' in u0 && 'completed' in u0);

  // 8. 权限边界 / 多工具安装 / 服务器端安装越界 / 租户隔离
  const engLogin = await api('POST', '/api/auth/login', { username: 'engineer1', password: 'admin123' });
  const engToken = engLogin.data.data.token;
  const forbidden = await api('GET', '/api/rules', null, engToken);
  ok('工程师无权访问规则(403)', forbidden.status === 403);

  const instOpen = await api('GET', '/api/gateway/install?tool=opencode');
  ok('多工具安装(opencode→AGENTS+command)', instOpen.status === 200 && instOpen.data.data.files.length === 2 && instOpen.data.data.files[1].path.includes('.opencode'));
  const instGemini = await api('GET', '/api/gateway/install?tool=gemini');
  ok('多工具安装(gemini→GEMINI.md)', instGemini.status === 200 && instGemini.data.data.files[0].path === 'GEMINI.md');

  const serverBad = await api('POST', '/api/gateway/install-server', { tool: 'codex', target: '../escape' }, token);
  ok('服务器端安装越界拒绝', serverBad.status === 400 || (serverBad.data.message || '').includes('越界'));

  const tn = await api('POST', '/api/tenants', { code: 'smoke-iso', name: '冒烟租户' }, token);
  ok('建租户(隔离测试)', tn.status === 200 && tn.data.success);
  await api('POST', '/api/users', { username: 'smokeiso', password: 'admin123', role: 'engineer', name: '冒烟租户工程师', tenant_id: tn.data.data.id }, token);
  const isoLogin = await api('POST', '/api/auth/login', { username: 'smokeiso', password: 'admin123' });
  const isoTasks = await api('GET', '/api/tasks?size=5', null, isoLogin.data.data.token);
  ok('租户隔离(新租户任务空)', isoTasks.status === 200 && isoTasks.data.data.data.length === 0);

  // 9. 清理本次创建的测试数据
  const db = getDb();
  await db.run(`DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM request_logs WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM tasks WHERE project_code = $1`, [MARK]);
  await db.run(`DELETE FROM approvals WHERE requester = $1`, [MARK]);
  await db.run(`DELETE FROM projects WHERE code LIKE 'smoke-%'`, []);
  await db.run(`DELETE FROM users WHERE username = 'smokeiso'`, []);
  await db.run(`DELETE FROM tenants WHERE code = 'smoke-iso'`, []);
  console.log('  （已清理冒烟测试数据）');

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('冒烟测试异常:', e.message); process.exit(1); });
