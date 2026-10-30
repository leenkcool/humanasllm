/**
 * 单元测试：AI 起草服务
 * 重点验证「分级红线」——confidential/ops 绝不允许 AI 起草（上下文不得出网关）
 */
const { test } = require('node:test');
const assert = require('node:assert');

const draft = require('../../services/draftService');

const TASK = (over = {}) => ({
  id: 1, category: 'general', status: 'processing',
  request_payload: { messages: [{ role: 'user', content: '如何排查 PostgreSQL 死锁？' }] },
  ...over,
});

test('分级红线：confidential / ops 禁止起草', () => {
  for (const category of ['confidential', 'ops']) {
    const r = draft.canDraft(TASK({ category }));
    assert.strictEqual(r.ok, false, `${category} 必须拒绝`);
    assert.ok(r.message.includes('禁止'), `应说明原因：${r.message}`);
  }
});

test('general 类在中继未配置时也拒绝（降级安全）', () => {
  const old = process.env.AI_RELAY_API_KEY;
  process.env.AI_RELAY_API_KEY = '';
  try {
    const r = draft.canDraft(TASK());
    assert.strictEqual(r.ok, false);
    assert.ok(r.message.includes('中继'));
  } finally {
    if (old === undefined) delete process.env.AI_RELAY_API_KEY;
    else process.env.AI_RELAY_API_KEY = old;
  }
});

test('buildContext 拼接多轮消息并标注角色', () => {
  const ctx = draft.buildContext(TASK({
    request_payload: { messages: [
      { role: 'system', content: '你是运维专家' },
      { role: 'user', content: '磁盘满了怎么办' },
      { role: 'assistant', content: '先看 df -h' },
    ] },
  }));
  assert.ok(ctx.includes('[system] 你是运维专家'));
  assert.ok(ctx.includes('[user] 磁盘满了怎么办'));
  assert.ok(ctx.includes('[assistant] 先看 df -h'));
});

test('buildContext 超长截断，避免把大上下文全量外发', () => {
  const long = 'x'.repeat(20000);
  const ctx = draft.buildContext(TASK({
    request_payload: { messages: [{ role: 'user', content: long }] },
  }));
  assert.ok(ctx.length < 20000, '必须截断');
  assert.ok(ctx.includes('已截断'));
});

test('buildContext 对空请求返回空串', () => {
  assert.strictEqual(draft.buildContext(TASK({ request_payload: {} })), '');
  assert.strictEqual(draft.buildContext(TASK({ request_payload: null })), '');
});

test('canDraft 对不存在的任务返回不可起草', () => {
  const r = draft.canDraft(null);
  assert.strictEqual(r.ok, false);
});

test('DRAFTABLE_CATEGORIES 只含 general', () => {
  assert.deepStrictEqual(draft.DRAFTABLE_CATEGORIES, ['general']);
});
