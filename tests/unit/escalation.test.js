/**
 * 单元测试：告警升级序列（纯函数）
 * 级别：L1 过半 → L2 临近 → L3 违约 → L4/L5 驳回滞留
 */
const { test } = require('node:test');
const assert = require('node:assert');
const a = require('../../services/alertService');

const MIN = 60 * 1000;

/** 构造任务快照（毫秒时间戳） */
function task(over = {}) {
  const now = Date.now();
  return {
    id: 1, status: 'processing', priority: 'medium', category: 'general', tenant_id: 1,
    created_at: new Date(now - 100 * MIN), claimed_at: new Date(now - 100 * MIN),
    updated_at: new Date(now - 100 * MIN), timeout_at: new Date(now + 100 * MIN),
    escalation_level: 0, ...over,
  };
}

test('slaStart 取 claimed_at / created_at / updated_at 中最晚者', () => {
  const now = Date.now();
  const t = task({
    created_at: new Date(now - 200 * MIN),
    claimed_at: new Date(now - 100 * MIN),
    updated_at: new Date(now - 50 * MIN),
  });
  assert.strictEqual(a.slaStart(t), now - 50 * MIN);
});

test('SLA 比例边界：49% 不告警，50% 触发 L1', () => {
  const now = Date.now();
  // 总 SLA 200 分钟；已用 98 分钟 = 49%
  const under = task({
    created_at: new Date(now - 98 * MIN), claimed_at: new Date(now - 98 * MIN),
    updated_at: new Date(now - 98 * MIN), timeout_at: new Date(now + 102 * MIN),
  });
  assert.strictEqual(a.computeLevel(under, now), 0, '未到阈值不告警');

  const at50 = task({
    created_at: new Date(now - 100 * MIN), claimed_at: new Date(now - 100 * MIN),
    updated_at: new Date(now - 100 * MIN), timeout_at: new Date(now + 100 * MIN),
  });
  assert.strictEqual(a.computeLevel(at50, now), 1, '达到 50% → L1');
});

test('SLA 比例：79% 仍 L1，80% 升 L2', () => {
  const now = Date.now();
  const at79 = task({
    created_at: new Date(now - 158 * MIN), claimed_at: new Date(now - 158 * MIN),
    updated_at: new Date(now - 158 * MIN), timeout_at: new Date(now + 42 * MIN),
  });
  assert.strictEqual(a.computeLevel(at79, now), 1);
  const at80 = task({
    created_at: new Date(now - 160 * MIN), claimed_at: new Date(now - 160 * MIN),
    updated_at: new Date(now - 160 * MIN), timeout_at: new Date(now + 40 * MIN),
  });
  assert.strictEqual(a.computeLevel(at80, now), 2);
});

test('planEscalation：已达级别不重复发', () => {
  const now = Date.now();
  const t = task({
    created_at: new Date(now - 100 * MIN), claimed_at: new Date(now - 100 * MIN),
    updated_at: new Date(now - 100 * MIN), timeout_at: new Date(now + 100 * MIN),
    escalation_level: 1,
  });
  assert.strictEqual(a.planEscalation(t, now), null, '已是 L1 → 不再发 L1');

  const t2 = task({
    created_at: new Date(now - 160 * MIN), claimed_at: new Date(now - 160 * MIN),
    updated_at: new Date(now - 160 * MIN), timeout_at: new Date(now + 40 * MIN),
    escalation_level: 1,
  });
  const p = a.planEscalation(t2, now);
  assert.strictEqual(p.level, 2, 'L1 → 应升到 L2');
});

test('returned 滞留：30 分钟 L4，60 分钟 L5', () => {
  const now = Date.now();
  const min = a.levelsConfig().return_stale_min;
  const atN = task({ status: 'returned', updated_at: new Date(now - min * MIN), timeout_at: null, escalation_level: 3 });
  assert.strictEqual(a.computeLevel(atN, now), 4);
  const at2N = task({ status: 'returned', updated_at: new Date(now - 2 * min * MIN), timeout_at: null, escalation_level: 3 });
  assert.strictEqual(a.computeLevel(at2N, now), 5);
  const under = task({ status: 'returned', updated_at: new Date(now - Math.floor(min / 2) * MIN), timeout_at: null });
  assert.ok(a.computeLevel(under, now) < 4, '未到滞留阈值不告警');
});

test('终态任务不产生告警', () => {
  const now = Date.now();
  for (const status of ['completed', 'cancelled']) {
    const t = task({ status, created_at: new Date(now - 999 * MIN), timeout_at: new Date(now - 500 * MIN) });
    assert.strictEqual(a.planEscalation(t, now), null, `${status} 不应告警`);
  }
});

test('级别定义完整：5 级且 kind 命名符合约定', () => {
  assert.strictEqual(a.LEVELS.length, 5);
  const kinds = a.LEVELS.map(l => l.kind);
  assert.deepStrictEqual(kinds, ['sla_warn', 'sla_warn', 'sla_breach', 'return_stale', 'return_stale']);
});
