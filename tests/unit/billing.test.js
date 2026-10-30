/**
 * 单元测试：计费纯函数（不连库）
 * 覆盖 billableMinutes 边界 / calcAmount 取大 / resolveRate 层级回退
 */
const { test } = require('node:test');
const assert = require('node:assert');
const billing = require('../../services/billingService');

const iso = (s) => new Date(s);
const base = {
  status: 'completed',
  claimed_at: '2026-10-30T10:00:00',
  completed_at: '2026-10-30T10:03:20', // 3 分 20 秒 → 向上取整 3.5 分
  created_at: '2026-10-30T09:50:00',
  assignee_id: 7,
  result_payload: null,
};

test('billableMinutes：未接单时按 created_at 起算', () => {
  const t = { ...base, claimed_at: null, completed_at: '2026-10-30T09:52:30' }; // 2.5 分
  assert.strictEqual(billing.billableMinutes(t), 2.5);
});

test('billableMinutes：向上取整到 0.5 分钟', () => {
  assert.strictEqual(billing.billableMinutes(base), 3.5);
  const t = { ...base, claimed_at: '2026-10-30T10:00:00', completed_at: '2026-10-30T10:00:10' };
  assert.strictEqual(billing.billableMinutes(t), 0.5, '不足 0.5 分钟按 0.5 计');
  const t2 = { ...base, claimed_at: '2026-10-30T10:00:00', completed_at: '2026-10-30T10:00:30' };
  assert.strictEqual(billing.billableMinutes(t2), 0.5, '恰好 0.5 分钟');
  const t3 = { ...base, claimed_at: '2026-10-30T10:00:00', completed_at: '2026-10-30T10:01:01' };
  assert.strictEqual(billing.billableMinutes(t3), 1.5, '1 分 1 秒 → 1.5 分');
});

test('billableMinutes：负时长归 0、非 completed 归 0', () => {
  const neg = { ...base, claimed_at: '2026-10-30T10:05:00', completed_at: '2026-10-30T10:00:00' };
  assert.strictEqual(billing.billableMinutes(neg), 0);
  assert.strictEqual(billing.billableMinutes({ ...base, status: 'processing' }), 0);
  assert.strictEqual(billing.billableMinutes({ ...base, status: 'cancelled' }), 0);
  assert.strictEqual(billing.billableMinutes(null), 0);
});

test('billableMinutes：AI 产出（ai-relay / ai-shift）计 0 分钟', () => {
  assert.strictEqual(billing.billableMinutes({ ...base, result_payload: { source: 'ai-relay' } }), 0);
  assert.strictEqual(billing.billableMinutes({ ...base, result_payload: { source: 'ai-shift' } }), 0);
  assert.strictEqual(billing.billableMinutes({ ...base, result_payload: JSON.stringify({ source: 'ai-relay' }) }), 0,
    'JSON 字符串形式同样识别');
  assert.strictEqual(billing.billableMinutes({ ...base, result_payload: { content: '人工产出' } }), 3.5);
});

test('billableMinutes：支持 Date 入参', () => {
  const t = { ...base, claimed_at: iso('2026-10-30T10:00:00'), completed_at: iso('2026-10-30T10:02:00') };
  assert.strictEqual(billing.billableMinutes(t), 2);
});

test('calcAmount：单价×时长 与 最低消费取大', () => {
  assert.strictEqual(billing.calcAmount({ minutes: 3.5, unitPriceCents: 500, minChargeCents: 500 }), 1750);
  assert.strictEqual(billing.calcAmount({ minutes: 0.5, unitPriceCents: 400, minChargeCents: 500 }), 500, '低时长触发最低消费');
  assert.strictEqual(billing.calcAmount({ minutes: 0, unitPriceCents: 500, minChargeCents: 500 }), 0, '零时长不收最低消费');
  assert.strictEqual(billing.calcAmount({ minutes: 2, unitPriceCents: 750, minChargeCents: 0 }), 1500);
});

test('resolveRate：租户 > 全局 > 代码常量', () => {
  const rates = [
    { id: 1, tenant_id: null, category: 'general', priority: 'high', unit_price_cents: 500, min_charge_cents: 500, enabled: true },
    { id: 2, tenant_id: 9, category: 'general', priority: 'high', unit_price_cents: 800, min_charge_cents: 1000, enabled: true },
  ];
  const tenantHit = billing.resolveRate({ tenantId: 9, category: 'general', priority: 'high', rates });
  assert.deepStrictEqual(tenantHit, { unit_price_cents: 800, min_charge_cents: 1000, source: 'tenant', id: 2 });

  const globalHit = billing.resolveRate({ tenantId: 3, category: 'general', priority: 'high', rates });
  assert.deepStrictEqual(globalHit, { unit_price_cents: 500, min_charge_cents: 500, source: 'global', id: 1 });

  const fallback = billing.resolveRate({ tenantId: 3, category: 'ops', priority: 'low', rates });
  assert.deepStrictEqual(fallback, { unit_price_cents: 360, min_charge_cents: 500, source: 'default', id: null });

  // 停用的租户费率不参与匹配
  const disabled = [{ id: 3, tenant_id: 9, category: 'general', priority: 'high', unit_price_cents: 999, min_charge_cents: 0, enabled: false }];
  assert.strictEqual(billing.resolveRate({ tenantId: 9, category: 'general', priority: 'high', rates: disabled }).source, 'default');

  // 非法分级/优先级回退 general/medium
  assert.strictEqual(billing.resolveRate({ tenantId: 9, category: 'xxx', priority: 'yyy' }).unit_price_cents, 400);
});

test('DEFAULT_RATES：优先级系数 0.8/0.6、分级加成 1.2/1.5、最低消费 500', () => {
  assert.deepStrictEqual(billing.DEFAULT_RATES, {
    general: { high: 500, medium: 400, low: 300 },
    ops: { high: 600, medium: 480, low: 360 },
    confidential: { high: 750, medium: 600, low: 450 },
  });
  assert.strictEqual(billing.DEFAULT_MIN_CHARGE, 500);
});

test('periodOf / yuan：期间归档与金额格式化', () => {
  assert.strictEqual(billing.periodOf(new Date('2026-10-30T12:00:00')), '2026-10');
  assert.strictEqual(billing.periodOf('2026-01-05T00:00:00'), '2026-01');
  assert.strictEqual(billing.yuan(1750), '17.50');
  assert.strictEqual(billing.yuan(0), '0.00');
});

test('resultSource：产出来源识别', () => {
  assert.strictEqual(billing.resultSource({ result_payload: { source: 'ai-relay' } }), 'ai_relay');
  assert.strictEqual(billing.resultSource({ result_payload: { source: 'ai-shift' } }), 'ai_shift');
  assert.strictEqual(billing.resultSource({ result_payload: null, assignee_id: 5 }), 'human');
  assert.strictEqual(billing.resultSource({ result_payload: null, assignee_id: null }), 'manual');
});
