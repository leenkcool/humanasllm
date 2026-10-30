const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../../services/dispatchService');

const CAND = (over = {}) => ({
  id: 1, username: 'u1', name: 'U1', skills: 'node,pg',
  active_count: 0, completed: 10, reopened: 0, ...over,
});

test('技能全匹配 / 部分匹配 / 无技能任务', () => {
  const task = { skills: 'node,pg' };
  assert.strictEqual(d.skillRatio(task.skills, 'node,pg'), 1);
  assert.strictEqual(d.skillRatio(task.skills, 'node'), 0.5);
  assert.strictEqual(d.skillRatio(task.skills, 'java'), 0);
  // 任务无技能要求 → 中性分（不因技能误判）
  assert.strictEqual(d.skillRatio(null, 'node,pg'), d.NO_SKILL_TASK_RATIO);
});

test('负载分随进行中任务增加而下降，超限夹到 0', () => {
  const task = { skills: 'node' };
  const cap = d.loadCap();
  const free = d.scoreCandidate(CAND({ active_count: 0 }), task);
  const busy = d.scoreCandidate(CAND({ active_count: Math.floor(cap / 2) }), task);
  const over = d.scoreCandidate(CAND({ active_count: cap + 3 }), task);
  assert.strictEqual(free.load_score, 1, '空闲负载满分');
  assert.ok(busy.load_score < free.load_score);
  assert.strictEqual(over.load_score, 0, '超限夹到 0，不为负');
});

test('无历史质量分按 0.7 兜底，不埋没新人', () => {
  const s = d.scoreCandidate(CAND({ completed: 0, reopened: 0 }), { skills: 'node' });
  assert.strictEqual(s.quality_score, d.NO_HISTORY_QUALITY);
  assert.strictEqual(s.pass_rate, null);
  assert.ok(s.reasons.some(r => r.includes('暂无历史')));
});

test('一次通过率：reopen 拉低质量分', () => {
  const good = d.scoreCandidate(CAND({ completed: 10, reopened: 0 }), { skills: 'node' });
  const bad = d.scoreCandidate(CAND({ completed: 10, reopened: 5 }), { skills: 'node' });
  assert.strictEqual(good.quality_score, 1);
  assert.strictEqual(bad.quality_score, 0.5);
  assert.ok(good.score > bad.score);
});

test('权重生效：技能高但满负载 vs 技能低但空闲', () => {
  const task = { skills: 'node,pg' };
  const skilledBusy = d.scoreCandidate(CAND({ skills: 'node,pg', active_count: d.loadCap() }), task);
  const unskilledFree = d.scoreCandidate(CAND({ skills: 'java', active_count: 0 }), task);
  // 技能权重 0.5 大于负载 0.3：技能匹配者即便满负载仍应领先
  assert.ok(skilledBusy.score > unskilledFree.score,
    `skilled=${skilledBusy.score} unskilled=${unskilledFree.score}`);
});

test('排序确定性：同分时负载低者优先，再按 id', () => {
  const mk = (id, active, score) => ({ user_id: id, score, active_count: active, completed: 0 });
  const list = [mk(3, 2, 80), mk(1, 1, 80), mk(2, 2, 80), mk(4, 0, 90)].sort(d.compareCandidates);
  assert.deepStrictEqual(list.map(x => x.user_id), [4, 1, 2, 3]);
});

test('分数范围 0..100 且 reasons 含三项依据', () => {
  const s = d.scoreCandidate(CAND(), { skills: 'node' });
  assert.ok(s.score >= 0 && s.score <= 100);
  assert.strictEqual(s.reasons.length, 3);
});

test('DISPATCH_ENABLED=false 关闭派单', () => {
  const old = process.env.DISPATCH_ENABLED;
  process.env.DISPATCH_ENABLED = 'false';
  try { assert.strictEqual(d.enabled(), false); } finally {
    if (old === undefined) delete process.env.DISPATCH_ENABLED; else process.env.DISPATCH_ENABLED = old;
  }
});
