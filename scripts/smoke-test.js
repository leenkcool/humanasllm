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
  ok('合规报告按租户口径(含 scope)', report.status === 200 && !!report.data.data.scope);
  const reportHtmlRes = await fetch(BASE + '/api/audit/report?format=html', { headers: { Authorization: 'Bearer ' + token } });
  const reportHtml = await reportHtmlRes.text();
  ok('合规报告 HTML 自包含可打印',
    reportHtmlRes.status === 200 &&
    (reportHtmlRes.headers.get('content-type') || '').includes('text/html') &&
    reportHtml.includes('window.print()') && reportHtml.includes('@media print'));
  const reportHtmlEn = await (await fetch(BASE + '/api/audit/report?format=html&lang=en', { headers: { Authorization: 'Bearer ' + token } })).text();
  ok('合规报告英文版', reportHtmlEn.includes('Compliance Report') && !reportHtmlEn.includes('合规报告'));
  const reportNoAuth = await fetch(BASE + '/api/audit/report?format=html');
  ok('合规报告 HTML 未授权 401', reportNoAuth.status === 401);
  const ds = await api('GET', '/api/audit/dataset', null, token);
  ok('数据资产导出', ds.status === 200);
  const install = await api('GET', '/api/gateway/install?tool=agents');
  ok('网关安装包(agents→AGENTS.md)', install.status === 200 && install.data.data.files[0].path === 'AGENTS.md');
  const userz = await api('GET', '/api/users', null, token);
  const u0 = userz.data.data[0];
  ok('用户列表含租户+统计', 'tenant_name' in u0 && 'completed' in u0);

  // 7.1 工单模板（模板建单 + /v1 传 template_id）
  const tplList = await api('GET', '/api/templates', null, token);
  ok('模板列表(含示例)', tplList.status === 200 && Array.isArray(tplList.data.data));
  const tplNew = await api('POST', '/api/templates', {
    name: 'smoke-模板', category: 'ops', priority: 'high', skills: 'postgres,ops',
    payload_template: { messages: [{ role: 'user', content: '冒烟模板默认需求' }] },
  }, token);
  ok('新建模板', tplNew.status === 200 && tplNew.data.success && !!tplNew.data.data.id);
  const tplId = tplNew.data.data.id;
  const tplUse = await api('POST', `/api/templates/${tplId}/apply`, { overrides: { messages: [{ role: 'user', content: '冒烟模板建单' }] } }, token);
  ok('模板一键建单', tplUse.status === 200 && !!tplUse.data.data.task_id);
  if (tplUse.data && tplUse.data.data) {
    const tplTask = await api('GET', '/api/tasks/' + tplUse.data.data.task_id, null, token);
    ok('模板建单写入 template_id', tplTask.status === 200 && tplTask.data.data.template_id === tplId);
  }
  const tplV1 = await api('POST', '/v1/chat/completions', {
    model: 'human-llm', template_id: tplId, project_code: MARK,
    messages: [{ role: 'user', content: '冒烟 /v1 模板建单' }],
  });
  ok('/v1 传 template_id 建单', tplV1.status === 200 && !!tplV1.data.task_id);
  const tplBad = await api('POST', '/v1/chat/completions', {
    model: 'human-llm', template_id: 99999999, messages: [{ role: 'user', content: 'x' }],
  });
  ok('/v1 非法 template_id 拒绝(400)', tplBad.status === 400);

  // 7.2 智能派单
  const dTask = await api('POST', '/v1/chat/completions', {
    model: 'human-llm', project_code: MARK, skills: 'postgres,ops',
    messages: [{ role: 'user', content: '冒烟派单任务' }],
  });
  const dispatchTaskId = dTask.data && dTask.data.task_id;
  ok('/v1 建派单候选任务', dTask.status === 200 && !!dispatchTaskId);
  if (dispatchTaskId) {
    const sug = await api('GET', `/api/dispatch/tasks/${dispatchTaskId}/suggest`, null, token);
    ok('派单建议含候选人', sug.status === 200 && sug.data.success &&
      Array.isArray(sug.data.data.candidates) && !!sug.data.data.recommended);
    const dry = await api('POST', `/api/dispatch/tasks/${dispatchTaskId}/assign`, { dry_run: true }, token);
    ok('派单 dry_run 不改状态', dry.status === 200 && dry.data.success && dry.data.dry_run === true);
    const afterDry = await api('GET', '/api/tasks/' + dispatchTaskId, null, token);
    ok('dry_run 后任务仍 pending', afterDry.data.data.status === 'pending');
    const asg = await api('POST', `/api/dispatch/tasks/${dispatchTaskId}/assign`, {}, token);
    ok('一键派单 → processing', asg.status === 200 && asg.data.data.task.status === 'processing');
    const wl = await api('GET', '/api/dispatch/workload', null, token);
    ok('工程师负载概览', wl.status === 200 && Array.isArray(wl.data.data));
  }

  // 7.3 告警中心
  const aStats = await api('GET', '/api/alerts/stats', null, token);
  ok('告警统计', aStats.status === 200 && typeof aStats.data.data.active === 'number' &&
    !!aStats.data.data.by_level);
  const aList = await api('GET', '/api/alerts?status=all&size=5', null, token);
  ok('告警列表分页结构', aList.status === 200 && Array.isArray(aList.data.data.data));

  // 7.4 计费计量
  const bOv = await api('GET', '/api/billing/overview', null, token);
  ok('计费概览', bOv.status === 200 && bOv.data.success && typeof bOv.data.data.total_cents === 'number');
  const bRates = await api('GET', '/api/billing/rates', null, token);
  ok('费率列表含全局默认', bRates.status === 200 &&
    (bRates.data.data || []).some(r => r.tenant_id === null));
  const period = new Date().toISOString().slice(0, 7);
  const bLedger = await api('GET', '/api/billing/ledger?period=' + period, null, token);
  ok('计费明细分页', bLedger.status === 200 && Array.isArray(bLedger.data.data.data));
  const bExport = await fetch(BASE + '/api/billing/export?period=' + period, { headers: { Authorization: 'Bearer ' + token } });
  const bBuf = new Uint8Array(await bExport.arrayBuffer());
  const bText = new TextDecoder('utf-8').decode(bBuf);
  ok('计费导出 CSV(BOM)', bExport.status === 200 && bBuf[0] === 0xEF && bBuf[1] === 0xBB && bBuf[2] === 0xBF);

  // 7.5 多轮追问（会话）
  const c1 = await api('POST', '/v1/chat/completions', {
    model: 'human-llm', project_code: MARK,
    messages: [{ role: 'user', content: '冒烟会话第一轮' }],
  });
  ok('/v1 返回 conversation_id', c1.status === 200 && !!c1.data.conversation_id && c1.data.turn_index === 0);
  const convId = c1.data && c1.data.conversation_id;
  if (convId) {
    const c2 = await api('POST', '/v1/chat/completions', {
      model: 'human-llm', conversation_id: convId,
      messages: [{ role: 'user', content: '冒烟会话第二轮追问' }],
    });
    ok('追问挂到同一会话(turn=1)', c2.status === 200 && c2.data.conversation_id === convId && c2.data.turn_index === 1);
    if (c2.data && c2.data.task_id) {
      const cv = await api('GET', '/v1/tasks/' + c2.data.task_id);
      ok('/v1 回查带会话时间线', cv.status === 200 && !!cv.data.conversation && cv.data.conversation.turns.length >= 2);
    }
    const cbad = await api('POST', '/v1/chat/completions', {
      model: 'human-llm', conversation_id: 'conv-not-exist',
      messages: [{ role: 'user', content: 'x' }],
    });
    ok('非法 conversation_id 拒绝(400)', cbad.status === 400);
  }

  // 7.7 答复审核
  const rvStats = await api('GET', '/api/reviews/stats', null, token);
  ok('审核统计', rvStats.status === 200 && typeof rvStats.data.data.delivered === 'number');
  const rvPending = await api('GET', '/api/reviews/pending?size=5', null, token);
  ok('待审核队列分页结构', rvPending.status === 200 && Array.isArray(rvPending.data.data.data));
  // 冒烟任务里已完成的 general 任务应为免审（delivered）
  if (taskId) {
    const rvOne = await api('GET', '/api/reviews/' + taskId, null, token);
    ok('general 任务免审为 delivered', rvOne.status === 200 && rvOne.data.data
      && rvOne.data.data.status === 'delivered');
    const v1rv = await api('GET', '/v1/tasks/' + taskId);
    ok('上游回查带 review_status', v1rv.status === 200 && v1rv.data.review_status === 'delivered');
  }

  // 7.8 合规报告 HTML（已在上面断言） / 监控 / PWA 静态资源
  const met = await fetch(BASE + '/metrics');
  const metText = await met.text();
  ok('Prometheus /metrics', met.status === 200 && metText.includes('p390_'));
  const mf = await fetch(BASE + '/manifest.json');
  ok('PWA manifest', mf.status === 200 && (mf.headers.get('content-type') || '').includes('manifest'));
  const swRes = await fetch(BASE + '/sw.js');
  ok('PWA sw.js 可获取且不缓存', swRes.status === 200 &&
    (swRes.headers.get('cache-control') || '').includes('no-cache'));
  const offline = await fetch(BASE + '/offline.html');
  ok('PWA 离线页', offline.status === 200);


  // 8. 权限边界 / 多工具安装 / 服务器端安装越界 / 租户隔离
  const engLogin = await api('POST', '/api/auth/login', { username: 'engineer1', password: 'admin123' });
  const engToken = engLogin.data.data.token;
  const forbidden = await api('GET', '/api/rules', null, engToken);
  ok('工程师无权访问规则(403)', forbidden.status === 403);
  const tplForbidden = await api('POST', '/api/templates', { name: 'smoke-禁止' }, engToken);
  ok('工程师无权建模板(403)', tplForbidden.status === 403);
  const dForbidden = await api('POST', `/api/dispatch/tasks/${dispatchTaskId || 1}/assign`, {}, engToken);
  ok('工程师无权派单(403)', dForbidden.status === 403);
  const bForbidden = await api('POST', '/api/billing/rates', { category: 'general', priority: 'high', unit_price_cents: 1 }, engToken);
  ok('工程师无权改费率(403)', bForbidden.status === 403);
  const bkForbidden = await api('GET', '/api/backup/list', null, engToken);
  ok('工程师无权查看备份(403)', bkForbidden.status === 403);

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

  // 9. 清理本次创建的测试数据（顺序：子表 → 主表）
  const db = getDb();
  await db.run(`DELETE FROM alerts WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM billing_ledger WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM task_reviews WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  // 会话第二轮的任务没有 project_code，单独按会话清理
  await db.run(`DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id IN (SELECT conversation_id FROM tasks WHERE project_code = $1))`, [MARK]);
  await db.run(`DELETE FROM task_reviews WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id IN (SELECT conversation_id FROM tasks WHERE project_code = $1))`, [MARK]);
  await db.run(`DELETE FROM request_logs WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id IN (SELECT conversation_id FROM tasks WHERE project_code = $1))`, [MARK]);
  await db.run(`DELETE FROM billing_ledger WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id IN (SELECT conversation_id FROM tasks WHERE project_code = $1))`, [MARK]);
  await db.run(`DELETE FROM alerts WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id IN (SELECT conversation_id FROM tasks WHERE project_code = $1))`, [MARK]);
  await db.run(`DELETE FROM tasks WHERE conversation_id IN (SELECT conversation_id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM request_logs WHERE task_id IN (SELECT id FROM tasks WHERE project_code = $1)`, [MARK]);
  await db.run(`DELETE FROM tasks WHERE project_code = $1`, [MARK]);
  await db.run(`DELETE FROM approvals WHERE requester = $1`, [MARK]);
  await db.run(`DELETE FROM task_templates WHERE name LIKE 'smoke-%'`, []);
  await db.run(`DELETE FROM projects WHERE code LIKE 'smoke-%'`, []);
  await db.run(`DELETE FROM users WHERE username = 'smokeiso'`, []);
  await db.run(`DELETE FROM tenants WHERE code = 'smoke-iso'`, []);
  console.log('  （已清理冒烟测试数据）');

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('冒烟测试异常:', e.message); process.exit(1); });
