const { test } = require('node:test');
const assert = require('node:assert');
const enc = require('../../services/openaiEncoder');

test('parseChatRequest 透传扩展字段(skills/category/priority/project)', () => {
  const p = enc.parseChatRequest({
    model: 'human-llm', messages: [{ role: 'user', content: 'x' }],
    skills: '数据库,运维', category: 'ops', priority: 'high', project_code: 'P1',
  });
  assert.strictEqual(p.extra.skills, '数据库,运维');
  assert.strictEqual(p.extra.category, 'ops');
  assert.strictEqual(p.extra.priority, 'high');
  assert.strictEqual(p.extra.project_code, 'P1');
});

test('parseChatRequest messages 空报错', () => {
  assert.throws(() => enc.parseChatRequest({}), /messages/);
});

test('makeChatCompletion 结构', () => {
  const r = enc.makeChatCompletion({ id: 'x', model: 'human-llm', created: 1, content: '人工产出' });
  assert.strictEqual(r.choices[0].message.content, '人工产出');
  assert.strictEqual(r.choices[0].finish_reason, 'stop');
  assert.strictEqual(r.object, 'chat.completion');
});

test('makeStreamChunks 以 [DONE] 结尾', () => {
  const chunks = enc.makeStreamChunks({ id: 'x', model: 'human-llm', created: 1, content: '你好' });
  assert.ok(chunks[chunks.length - 1].includes('[DONE]'));
  assert.ok(chunks[0].includes('role'));
});

test('makeError 结构', () => {
  const e = enc.makeError(400, 'bad request');
  assert.strictEqual(e.error.message, 'bad request');
  assert.strictEqual(e.error.type, 'invalid_request_error');
});
