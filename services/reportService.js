/**
 * 合规报告服务（数据不出网关证明）
 *
 * collectReportData：唯一的报告数据出口，全部指标按租户过滤（修复原先 audit/report 全表聚合的越权）
 * renderHtml：自包含单文件 HTML（内嵌 CSS + @media print），浏览器「打印 → 另存为 PDF」即得报告
 */
const { getDb } = require('../db');
const queue = require('./queueService');

const { rows } = queue;

/** 哈希链批量复核上限（避免全表 N+1 拖垮请求） */
const CHAIN_SAMPLE_LIMIT = 500;

const zh = {
  title: '合规报告', subtitle: '数据不出网关证明',
  generated: '生成时间', tenant: '租户',
  verdict: '合规结论', pass: 'PASS', fail: 'FAIL',
  kpiTasks: '任务总数', kpiProtected: '受保护任务', kpiHuman: '人工产出占比', kpiChains: '审计链健康',
  secDist: '分级分布', secStatus: '状态分布', secAi: 'AI 兜底核查',
  secApproval: '审批统计', secChain: '审计哈希链校验', secQuality: '质量与一次通过率',
  secMethod: '校验方法与口径',
  cat: { general: '常规', confidential: '涉密', ops: '运维' },
  st: { pending: '待接单', processing: '处理中', completed: '已完成', returned: '驳回', paused: '暂停', cancelled: '取消' },
  colName: '指标', colValue: '数值',
  total: '总数', generalFallback: 'general 类 AI 兜底（设计允许）', protectedFallback: '受保护类 AI 兜底（违规）',
  aiShift: '智能漂移承接', approved: '已批准', rejected: '已驳回', pendingAppr: '待审批',
  avgDecide: '平均审批时长（分钟）', validChains: '有效', invalidChains: '异常', checked: '已校验（上限 500）',
  completed: '已完成', reopened: '被打回', passRate: '一次通过率',
  methodText: [
    '1) 受保护任务 = category 为 confidential / ops 的任务（分级由服务端规则引擎白名单锁死，上游不可降级）。',
    '2) AI 兜底核查：result_payload.source 为 ai-relay 的任务。general 类兜底属设计允许（无人接单时的降级），受保护类兜底即为违规。',
    '3) 审计哈希链：task_logs 每条日志含 prev_hash + hash，逐条复算 SHA-256 校验，任一环节被篡改即断裂。',
    '4) 本报告仅统计当前租户数据，跨租户数据不会出现。',
  ],
  print: '打印 / 导出 PDF', close: '关闭',
  hint: '点击「打印 / 导出 PDF」，在打印对话框中选择「另存为 PDF」即可导出。',
  footer: 'Human as Agent · 合规报告由服务端生成，数据未被修改',
  verdictPass: '受保护任务（涉密/运维）无 AI 兜底，数据未出网关',
  verdictFail: (n) => `${n} 个受保护任务被 AI 兜底，涉密/运维数据可能出网关，需核查`,
};

const en = {
  title: 'Compliance Report', subtitle: 'Proof that no data leaves the gateway',
  generated: 'Generated at', tenant: 'Tenant',
  verdict: 'Verdict', pass: 'PASS', fail: 'FAIL',
  kpiTasks: 'Total tasks', kpiProtected: 'Protected tasks', kpiHuman: 'Human output ratio', kpiChains: 'Audit chain health',
  secDist: 'Category distribution', secStatus: 'Status distribution', secAi: 'AI fallback audit',
  secApproval: 'Approvals', secChain: 'Audit hash chain verification', secQuality: 'Quality & first-pass rate',
  secMethod: 'Method & scope',
  cat: { general: 'General', confidential: 'Confidential', ops: 'Ops' },
  st: { pending: 'Pending', processing: 'Processing', completed: 'Completed', returned: 'Returned', paused: 'Paused', cancelled: 'Cancelled' },
  colName: 'Metric', colValue: 'Value',
  total: 'Total', generalFallback: 'General AI fallback (by design)', protectedFallback: 'Protected AI fallback (violation)',
  aiShift: 'AI shift handled', approved: 'Approved', rejected: 'Rejected', pendingAppr: 'Pending',
  avgDecide: 'Avg decision time (min)', validChains: 'Valid', invalidChains: 'Invalid', checked: 'Checked (max 500)',
  completed: 'Completed', reopened: 'Reopened', passRate: 'First-pass rate',
  methodText: [
    '1) Protected tasks = tasks whose category is confidential / ops. Categorisation is locked by the server-side rule engine; upstream cannot downgrade it.',
    '2) AI fallback audit: tasks whose result_payload.source is ai-relay. Fallback for general tasks is by design; fallback for protected tasks is a violation.',
    '3) Audit hash chain: every task_logs row carries prev_hash + hash; SHA-256 is recomputed row by row, any tampering breaks the chain.',
    '4) This report only covers the current tenant; no cross-tenant data is included.',
  ],
  print: 'Print / Export PDF', close: 'Close',
  hint: 'Click "Print / Export PDF" and choose "Save as PDF" in the print dialog.',
  footer: 'Human as Agent · generated server-side, data unmodified',
  verdictPass: 'No AI fallback for protected tasks (confidential/ops) — data never left the gateway',
  verdictFail: (n) => `${n} protected task(s) were handled by AI fallback — confidential/ops data may have left the gateway`,
};

function dict(lang) { return lang === 'en' ? en : zh; }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 采集报告数据（全部按租户过滤） */
async function collectReportData({ tenantId }) {
  const db = getDb();
  const tenant = tenantId
    ? rows(await db.exec('SELECT id, code, name FROM tenants WHERE id = ?', [tenantId]))[0] || null
    : null;

  const tasks = rows(await db.exec(
    `SELECT id, category, rule_id, status, result_payload, created_at, completed_at
       FROM tasks WHERE tenant_id = ? ORDER BY id`, [tenantId || null]));

  const categories = { general: 0, confidential: 0, ops: 0 };
  const status = { pending: 0, processing: 0, completed: 0, returned: 0, paused: 0, cancelled: 0 };
  let aiFallback = 0, protectedAi = 0, aiShift = 0, humanOutput = 0;
  for (const t of tasks) {
    if (categories[t.category] !== undefined) categories[t.category]++;
    if (status[t.status] !== undefined) status[t.status]++;
    const rp = t.result_payload || {};
    if (rp.source === 'ai-relay') {
      aiFallback++;
      if (t.category !== 'general') protectedAi++;
    } else if (rp.source === 'ai-shift') {
      aiShift++;
    } else if (t.status === 'completed') {
      humanOutput++;
    }
  }
  const protectedTotal = categories.confidential + categories.ops;
  const producedTotal = humanOutput + aiFallback + aiShift;

  // 审批统计（同样按租户过滤）
  const appr = rows(await db.exec(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'approved') AS approved,
            COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending,
            AVG(EXTRACT(EPOCH FROM (decided_at - created_at)) / 60) AS avg_decide_min
       FROM approvals WHERE tenant_id = ?`, [tenantId || null]))[0] || {};

  // 哈希链：一次 join 查询 + 内存分组复算（避免 N+1）
  const sampled = rows(await db.exec(
    `SELECT l.* FROM task_logs l JOIN tasks t ON l.task_id = t.id
      WHERE t.tenant_id = ? ORDER BY l.task_id, l.id LIMIT ?`, [tenantId || null, CHAIN_SAMPLE_LIMIT]));
  const byTask = new Map();
  for (const l of sampled) {
    if (!byTask.has(l.task_id)) byTask.set(l.task_id, []);
    byTask.get(l.task_id).push(l);
  }
  let validChains = 0, invalidChains = 0;
  const broken = [];
  for (const [taskId, logs] of byTask) {
    const v = queue.verifyAuditChainFromLogs(logs);
    if (v.valid) validChains++;
    else { invalidChains++; broken.push({ task_id: taskId, broken_at: v.broken_at }); }
  }

  // 质量：一次通过率
  const qa = rows(await db.exec(
    `SELECT (SELECT COUNT(*) FROM tasks WHERE status = 'completed' AND tenant_id = ?) AS completed,
            (SELECT COUNT(*) FROM task_logs l JOIN tasks t ON l.task_id = t.id
              WHERE l.action = 'reopen' AND t.tenant_id = ?) AS reopened`,
    [tenantId || null, tenantId || null]))[0] || {};
  const completed = parseInt(qa.completed) || 0;
  const reopened = parseInt(qa.reopened) || 0;

  const compliancePass = protectedAi === 0;
  return {
    generated_at: new Date().toISOString(),
    scope: { tenant_id: tenantId || null, tenant_code: tenant ? tenant.code : null, tenant_name: tenant ? tenant.name : null },
    total_tasks: tasks.length,
    categories,
    status,
    // 向后兼容：保留原有字段结构（既有前端与冒烟测试依赖）
    protected: { confidential: categories.confidential, ops: categories.ops, total: protectedTotal },
    ai_fallback: { total: aiFallback, general: aiFallback - protectedAi, protected: protectedAi },
    ai_shift_used: aiShift,
    compliance: compliancePass
      ? 'PASS：受保护任务（涉密/运维）无 AI 兜底，数据未出网关'
      : `FAIL：${protectedAi} 个受保护任务被 AI 兜底，涉密/运维数据可能出网关，需核查`,
    compliance_pass: compliancePass,
    human_ratio: producedTotal > 0 ? Math.round((humanOutput / producedTotal) * 1000) / 10 : null,
    audit_chains: { valid: validChains, invalid: invalidChains, checked: byTask.size, broken },
    approvals: {
      total: parseInt(appr.total) || 0,
      approved: parseInt(appr.approved) || 0,
      rejected: parseInt(appr.rejected) || 0,
      pending: parseInt(appr.pending) || 0,
      avg_decide_min: appr.avg_decide_min != null ? Math.round(parseFloat(appr.avg_decide_min) * 10) / 10 : null,
    },
    quality: {
      completed, reopened,
      pass_rate: completed > 0 ? Math.max(0, Math.round((1 - reopened / completed) * 1000) / 10) : null,
    },
  };
}

/** 渲染自包含 HTML 报告（无外部资源、无脚本依赖，可直接打印） */
function renderHtml(data, { lang = 'zh' } = {}) {
  const d = dict(lang);
  const pass = !!data.compliance_pass;
  const fmtTime = (iso) => {
    const dt = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
  };
  const row = (name, value) => `<tr><td>${escapeHtml(name)}</td><td class="v">${escapeHtml(value)}</td></tr>`;
  const pct = (v) => (v == null ? '-' : v + '%');

  const catRows = Object.entries(data.categories)
    .map(([k, v]) => row(d.cat[k] || k, v)).join('');
  const stRows = Object.entries(data.status)
    .map(([k, v]) => row(d.st[k] || k, v)).join('');

  const chainOk = data.audit_chains.invalid === 0;

  return `<!DOCTYPE html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(d.title)} · ${escapeHtml(data.scope.tenant_name || '-')}</title>
<style>
  :root{
    --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --soft:#f6f7fb;
    --brand:#2563eb; --ok:#16a34a; --bad:#dc2626; --warn:#d97706;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:var(--ink);
       background:#eef1f6;font-size:13px;line-height:1.65;padding:24px 16px}
  .sheet{max-width:820px;margin:0 auto;background:#fff;border-radius:12px;
         box-shadow:0 2px 16px rgba(15,23,42,.08);padding:38px 44px}
  header{border-bottom:2px solid var(--brand);padding-bottom:14px;margin-bottom:22px;
         display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
  header h1{font-size:22px;letter-spacing:.5px}
  header .sub{color:var(--muted);font-size:12px;margin-top:2px}
  header .meta{text-align:right;color:var(--muted);font-size:12px;line-height:1.7}
  .verdict{display:flex;align-items:center;gap:14px;border-radius:10px;padding:16px 18px;margin-bottom:22px;
           border:1px solid ${pass ? '#bbf7d0' : '#fecaca'};background:${pass ? '#f0fdf4' : '#fef2f2'}}
  .verdict .badge{font-size:20px;font-weight:800;letter-spacing:1px;color:#fff;border-radius:8px;
                  padding:6px 16px;background:${pass ? 'var(--ok)' : 'var(--bad)'}}
  .verdict .txt{font-size:13px;color:${pass ? '#166534' : '#991b1b'}}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .kpi{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:14px}
  .kpi .n{font-size:22px;font-weight:700}
  .kpi .l{font-size:11px;color:var(--muted);margin-top:2px}
  h2{font-size:14px;margin:24px 0 10px;padding-left:9px;border-left:3px solid var(--brand)}
  table{width:100%;border-collapse:collapse;margin-bottom:6px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);font-size:12.5px}
  th{background:var(--soft);color:var(--muted);font-weight:500}
  td.v{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .chain{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px}
  .pill{border-radius:20px;padding:3px 12px;font-size:12px;border:1px solid var(--line);background:var(--soft)}
  .pill.ok{color:var(--ok);border-color:#bbf7d0;background:#f0fdf4}
  .pill.bad{color:var(--bad);border-color:#fecaca;background:#fef2f2}
  ol.method{color:var(--muted);font-size:12px;padding-left:18px}
  ol.method li{margin-bottom:5px}
  footer{margin-top:28px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:11px;
         display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .toolbar{position:sticky;top:0;z-index:5;max-width:820px;margin:0 auto 14px;display:flex;
           justify-content:flex-end;gap:8px}
  .toolbar button{font:inherit;font-size:13px;padding:8px 18px;border-radius:8px;cursor:pointer;
                  border:1px solid var(--brand);background:var(--brand);color:#fff}
  .toolbar button.ghost{background:#fff;color:var(--ink);border-color:var(--line)}
  .hint{max-width:820px;margin:0 auto 14px;color:var(--muted);font-size:12px;text-align:right}
  @media print{
    body{background:#fff;padding:0;font-size:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .sheet{box-shadow:none;border-radius:0;padding:0;max-width:none}
    .no-print{display:none !important}
    h2{break-after:avoid}
    table,.kpi,.verdict,.chain{break-inside:avoid}
    @page{size:A4;margin:14mm}
  }
  @media (max-width:640px){
    body{padding:10px}
    .sheet{padding:20px 16px}
    .kpis{grid-template-columns:repeat(2,1fr)}
    .two{grid-template-columns:1fr}
  }
</style>
</head>
<body>
<div class="toolbar no-print">
  <button onclick="window.print()">${escapeHtml(d.print)}</button>
  <button class="ghost" onclick="window.close()">${escapeHtml(d.close)}</button>
</div>
<div class="hint no-print">${escapeHtml(d.hint)}</div>

<div class="sheet">
  <header>
    <div>
      <h1>${escapeHtml(d.title)}</h1>
      <div class="sub">${escapeHtml(d.subtitle)}</div>
    </div>
    <div class="meta">
      ${escapeHtml(d.tenant)}: <strong>${escapeHtml(data.scope.tenant_name || data.scope.tenant_code || '-')}</strong><br>
      ${escapeHtml(d.generated)}: ${escapeHtml(fmtTime(data.generated_at))}
    </div>
  </header>

  <div class="verdict">
    <div class="badge">${pass ? d.pass : d.fail}</div>
    <div class="txt">${escapeHtml(pass ? d.verdictPass : d.verdictFail(data.ai_fallback.protected))}</div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="n">${data.total_tasks}</div><div class="l">${escapeHtml(d.kpiTasks)}</div></div>
    <div class="kpi"><div class="n">${data.protected.total}</div><div class="l">${escapeHtml(d.kpiProtected)}</div></div>
    <div class="kpi"><div class="n">${pct(data.human_ratio)}</div><div class="l">${escapeHtml(d.kpiHuman)}</div></div>
    <div class="kpi"><div class="n" style="color:${chainOk ? 'var(--ok)' : 'var(--bad)'}">${data.audit_chains.valid}/${data.audit_chains.checked}</div><div class="l">${escapeHtml(d.kpiChains)}</div></div>
  </div>

  <div class="two">
    <div>
      <h2>${escapeHtml(d.secDist)}</h2>
      <table><tbody>${catRows}</tbody></table>
    </div>
    <div>
      <h2>${escapeHtml(d.secStatus)}</h2>
      <table><tbody>${stRows}</tbody></table>
    </div>
  </div>

  <h2>${escapeHtml(d.secAi)}</h2>
  <table><tbody>
    ${row(d.total, data.ai_fallback.total)}
    ${row(d.generalFallback, data.ai_fallback.general)}
    ${row(d.protectedFallback, data.ai_fallback.protected)}
    ${row(d.aiShift, data.ai_shift_used)}
  </tbody></table>

  <h2>${escapeHtml(d.secApproval)}</h2>
  <table><tbody>
    ${row(d.total, data.approvals.total)}
    ${row(d.approved, data.approvals.approved)}
    ${row(d.rejected, data.approvals.rejected)}
    ${row(d.pendingAppr, data.approvals.pending)}
    ${row(d.avgDecide, data.approvals.avg_decide_min == null ? '-' : data.approvals.avg_decide_min)}
  </tbody></table>

  <h2>${escapeHtml(d.secChain)}</h2>
  <div class="chain">
    <span class="pill ok">${escapeHtml(d.validChains)}: ${data.audit_chains.valid}</span>
    <span class="pill ${data.audit_chains.invalid ? 'bad' : 'ok'}">${escapeHtml(d.invalidChains)}: ${data.audit_chains.invalid}</span>
    <span class="pill">${escapeHtml(d.checked)}: ${data.audit_chains.checked}</span>
  </div>
  ${data.audit_chains.broken.length
    ? `<table><thead><tr><th>task_id</th><th>broken_at</th></tr></thead><tbody>${
      data.audit_chains.broken.map(b => `<tr><td>${b.task_id}</td><td>#${b.broken_at}</td></tr>`).join('')}</tbody></table>`
    : ''}

  <h2>${escapeHtml(d.secQuality)}</h2>
  <table><tbody>
    ${row(d.completed, data.quality.completed)}
    ${row(d.reopened, data.quality.reopened)}
    ${row(d.passRate, pct(data.quality.pass_rate))}
  </tbody></table>

  <h2>${escapeHtml(d.secMethod)}</h2>
  <ol class="method">${d.methodText.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ol>

  <footer>
    <span>${escapeHtml(d.footer)}</span>
    <span>p390 · ${escapeHtml(fmtTime(data.generated_at))}</span>
  </footer>
</div>
</body>
</html>`;
}

module.exports = { collectReportData, renderHtml, escapeHtml, CHAIN_SAMPLE_LIMIT };
