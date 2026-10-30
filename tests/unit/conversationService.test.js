/**
 * 单元测试：会话服务（多轮追问）
 * 核心保证：
 *  - 不传 conversation_id 时行为完全不变（新会话）
 *  - 追问挂到同一会话，turn_index 递增
 *  - 受保护类会话不允许因追问内容降级
 */
const { test } = require('node:test');
const assert = require('node:assert');

const conv = require('../../services/conversationService');

test('生成会话 id 格式稳定且唯一', () => {
  const a = conv.makeConversationId();
  const b = conv.makeConversationId();
  assert.ok(a.startsWith('conv-'));
  assert.notStrictEqual(a, b);
});

test('新建会话：无 conversation_id 时返回 turn_index=0 且无可继承字段', async () => {
  const r = await conv.resolveConversation({ conversationId: null, tenantId: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.turn_index, 0);
  assert.strictEqual(r.parent_task_id, null);
  assert.strictEqual(r.inherit, null);
  assert.ok(r.conversation_id.startsWith('conv-'));
});

test('受保护类会话：追问内容无害也不得降级', () => {
  const prev = { id: 1, category: 'confidential', priority: 'high', project_code: 'P1', skills: 'security' };
  const parsed = { messages: [{ role: 'user', content: '谢谢，请补充时间节奏' }], extra: {} };
  // 本轮规则判成 general
  const { parsed: out, categoryOverride } = conv.applyInheritance(parsed, prev, { category: 'general' });
  assert.strictEqual(categoryOverride, 'confidential', '首轮涉密必须继承');
  assert.strictEqual(out.extra.project_code, 'P1', '项目强制继承');
  assert.strictEqual(out.extra.priority, 'high', '上游未指定优先级时继承');
  assert.strictEqual(out.extra.skills, 'security', '上游未指定技能时继承');
});

test('受保护类会话：本轮规则判成更严格级别时采用更严格', () => {
  const prev = { id: 1, category: 'ops' };
  const parsed = { messages: [{ role: 'user', content: 'x' }], extra: {} };
  const { categoryOverride } = conv.applyInheritance(parsed, prev, { category: 'confidential' });
  assert.strictEqual(categoryOverride, null, '本轮已是更严格级别，不需要覆盖');
});

test('general 会话：追问不强制继承分级（允许规则重新判定）', () => {
  const prev = { id: 1, category: 'general' };
  const parsed = { messages: [{ role: 'user', content: 'x' }], extra: {} };
  const { categoryOverride } = conv.applyInheritance(parsed, prev, { category: 'general' });
  assert.strictEqual(categoryOverride, null);
});

test('上游显式指定优先级时不覆盖', () => {
  const prev = { id: 1, category: 'general', priority: 'high', project_code: 'P1' };
  const parsed = { messages: [{ role: 'user', content: 'x' }], extra: { priority: 'low' } };
  const { parsed: out } = conv.applyInheritance(parsed, prev, null);
  assert.strictEqual(out.extra.priority, 'low', '上游显式值优先');
  assert.strictEqual(out.extra.project_code, 'P1', '项目仍强制继承');
});

test('applyInheritance 对 null prev 原样返回', () => {
  const parsed = { messages: [], extra: { priority: 'low' } };
  const r = conv.applyInheritance(parsed, null, null);
  assert.strictEqual(r.categoryOverride, null);
  assert.deepStrictEqual(r.parsed, parsed);
});

test('MAX_TURNS 上限存在且合理', () => {
  assert.ok(conv.MAX_TURNS >= 10 && conv.MAX_TURNS <= 200);
});
