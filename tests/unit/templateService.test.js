const { test } = require('node:test');
const assert = require('node:assert');
const tplSvc = require('../../services/templateService');
const { parseChatRequest } = require('../../services/openaiEncoder');

const TPL = {
  id: 1, name: '数据库迁移', category: 'ops', priority: 'high', skills: 'postgres,ops',
  project_code: 'P1', system_prompt: '按迁移规范执行',
  payload_template: { messages: [{ role: 'user', content: '模板默认需求' }] },
};

test('模板提供默认值：上游未给时用模板', () => {
  const parsed = parseChatRequest({ messages: [{ role: 'user', content: '上游需求' }] });
  const m = tplSvc.mergeIntoParsed(TPL, parsed);
  assert.deepStrictEqual(m.extra, { priority: 'high', skills: 'postgres,ops', project_code: 'P1', category: 'ops' });
  assert.strictEqual(m.messages[0].role, 'system', '无 system 时插入模板 system_prompt');
  assert.strictEqual(m.messages[0].content, '按迁移规范执行');
  assert.strictEqual(m.messages[1].content, '上游需求');
});

test('上游显式值优先于模板', () => {
  const parsed = parseChatRequest({
    messages: [{ role: 'system', content: '上游自己的 system' }, { role: 'user', content: 'x' }],
    priority: 'low', skills: 'frontend', project_code: 'P9', category: 'general',
  });
  const m = tplSvc.mergeIntoParsed(TPL, parsed);
  assert.strictEqual(m.extra.priority, 'low');
  assert.strictEqual(m.extra.skills, 'frontend');
  assert.strictEqual(m.extra.project_code, 'P9');
  assert.strictEqual(m.extra.category, 'general');
  assert.strictEqual(m.messages.length, 2, '已有 system 时不重复插入');
  assert.strictEqual(m.messages[0].content, '上游自己的 system');
});

test('messages 为空时回退模板预置', () => {
  const parsed = parseChatRequest({ messages: [{ role: 'user', content: 'x' }] });
  const m = tplSvc.mergeIntoParsed({ ...TPL, system_prompt: null }, parsed);
  // 上游 messages 非空 → 用上游的
  assert.strictEqual(m.messages.length, 1);
  assert.strictEqual(m.messages[0].content, 'x');
});

test('meta_tags 合并：模板默认 ← 上游覆盖', () => {
  const tpl = { ...TPL, default_meta_tags: { env: 'prod', team: 'db' } };
  const parsed = parseChatRequest({ messages: [{ role: 'user', content: 'x' }], meta_tags: { team: 'web' } });
  const m = tplSvc.mergeIntoParsed(tpl, parsed);
  assert.deepStrictEqual(m.extra.meta_tags, { env: 'prod', team: 'web' });
});

test('tools：上游优先，否则模板预置', () => {
  const tools = [{ type: 'function', function: { name: 'run_sql' } }];
  const tpl = { ...TPL, payload_template: { tools } };
  const withUpstream = tplSvc.mergeIntoParsed(tpl,
    parseChatRequest({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'mine' } }] }));
  assert.strictEqual(withUpstream.tools[0].function.name, 'mine');
  const noUpstream = tplSvc.mergeIntoParsed(tpl, parseChatRequest({ messages: [{ role: 'user', content: 'x' }] }));
  assert.strictEqual(noUpstream.tools[0].function.name, 'run_sql');
});

test('normalizeSkills 去重去空白小写', () => {
  assert.deepStrictEqual(tplSvc.normalizeSkills(' Node, pg ,,NODE '), ['node', 'pg']);
  assert.deepStrictEqual(tplSvc.normalizeSkills(null), []);
});

test('validateTemplate 校验', () => {
  assert.ok(tplSvc.validateTemplate({}) !== null, 'name 必填');
  assert.ok(tplSvc.validateTemplate({ name: 'a', category: 'bad' }) !== null);
  assert.ok(tplSvc.validateTemplate({ name: 'a', priority: 'urgent' }) !== null);
  assert.ok(tplSvc.validateTemplate({ name: 'a', payload_template: [] }) !== null);
  assert.strictEqual(tplSvc.validateTemplate({ name: 'a', category: 'ops', priority: 'high' }), null);
});

test('templateVisible：全局模板对所有租户可见', () => {
  assert.ok(tplSvc.templateVisible({ tenant_id: null }, 7));
  assert.ok(tplSvc.templateVisible({ tenant_id: 7 }, 7));
  assert.ok(!tplSvc.templateVisible({ tenant_id: 8 }, 7));
  assert.ok(!tplSvc.templateVisible(null, 7));
});
