const { test } = require('node:test');
const assert = require('node:assert');
const { renderHtml, escapeHtml } = require('../../services/reportService');

const DATA = {
  generated_at: '2026-10-30T02:00:00.000Z',
  scope: { tenant_id: 1, tenant_code: 'default', tenant_name: '默认租户' },
  total_tasks: 12,
  categories: { general: 8, confidential: 1, ops: 3 },
  status: { pending: 2, processing: 1, completed: 6, returned: 2, paused: 0, cancelled: 1 },
  protected: { confidential: 1, ops: 3, total: 4 },
  ai_fallback: { total: 2, general: 2, protected: 0 },
  ai_shift_used: 1,
  compliance: 'PASS：受保护任务（涉密/运维）无 AI 兜底，数据未出网关',
  compliance_pass: true,
  human_ratio: 66.7,
  audit_chains: { valid: 12, invalid: 0, checked: 12, broken: [] },
  approvals: { total: 5, approved: 3, rejected: 1, pending: 1, avg_decide_min: 42.5 },
  quality: { completed: 6, reopened: 1, pass_rate: 83.3 },
};

test('escapeHtml 转义脚本注入', () => {
  assert.strictEqual(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(escapeHtml(`a & "b" 'c'`), 'a &amp; &quot;b&quot; &#39;c&#39;');
  assert.strictEqual(escapeHtml(null), '');
});

test('renderHtml 自包含：打印样式、打印按钮、关键指标、租户名', () => {
  const html = renderHtml(DATA, { lang: 'zh' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('@media print'), '含打印样式');
  assert.ok(html.includes('window.print()'), '含打印按钮');
  assert.ok(html.includes('@page'), '含 A4 页面设置');
  assert.ok(html.includes('默认租户'), '含租户名');
  assert.ok(html.includes('PASS'), '含结论徽章');
  assert.ok(html.includes('12'), '含任务总数');
  assert.ok(html.includes('83.3%'), '含一次通过率');
  assert.ok(!html.includes('<script'), '不注入任何脚本');
  assert.ok(!/<link\b/i.test(html), '无外部样式依赖');
});

test('renderHtml 英文版不含中文标题', () => {
  const en = renderHtml(DATA, { lang: 'en' });
  assert.ok(en.includes('Compliance Report'));
  assert.ok(en.includes('Print / Export PDF'));
  assert.ok(!en.includes('合规报告'));
  assert.ok(!en.includes('受保护任务'));
});

test('renderHtml FAIL 结论与断链明细', () => {
  const fail = renderHtml({
    ...DATA,
    compliance: 'FAIL：1 个受保护任务被 AI 兜底',
    compliance_pass: false,
    ai_fallback: { total: 3, general: 2, protected: 1 },
    audit_chains: { valid: 11, invalid: 1, checked: 12, broken: [{ task_id: 9, broken_at: 33 }] },
  }, { lang: 'zh' });
  assert.ok(fail.includes('FAIL'));
  assert.ok(fail.includes('broken_at') || fail.includes('#33'), '断链明细可见');
});

test('renderHtml 租户名含 HTML 时被转义', () => {
  const html = renderHtml({ ...DATA, scope: { ...DATA.scope, tenant_name: '<img src=x onerror=alert(1)>' } }, { lang: 'zh' });
  assert.ok(!html.includes('<img src=x'), '租户名被转义');
  assert.ok(html.includes('&lt;img'), '转义后可见原文');
});
