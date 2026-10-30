/**
 * 单元测试：标注纯函数（不连库）
 * - 缺陷标签归一（中英文逗号 / 去重）
 * - 提示词抽取口径与审核 / 知识库一致
 * - SFT / 评测 JSONL 结构稳定（下游训练脚本依赖字段名）
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-annotation';

const an = require('../../services/annotationService');

test('normTags：中英文分隔符、去重、保留原始大小写', () => {
  assert.deepStrictEqual(an.normTags('过时,不完整'), ['过时', '不完整']);
  assert.deepStrictEqual(an.normTags('过时，不完整；越权'), ['过时', '不完整', '越权']);
  assert.deepStrictEqual(an.normTags(['A', 'a', ' b ']), ['A', 'b']);
  assert.deepStrictEqual(an.normTags(''), []);
  assert.deepStrictEqual(an.normTags(null), []);
});

test('promptOf：拼接全部 user 消息，忽略非字符串内容', () => {
  const task = {
    request_payload: {
      messages: [
        { role: 'system', content: '忽略我' },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '中间答复' },
        { role: 'user', content: '第二问' },
        { role: 'user', content: { part: '结构化' } },
      ],
    },
  };
  assert.strictEqual(an.promptOf(task), '第一问\n第二问');
  assert.strictEqual(an.promptOf({}), '');
  assert.strictEqual(an.promptOf({ request_payload: null }), '');
});

test('buildSftLine：user/assistant 结构 + 元数据', () => {
  const line = JSON.parse(an.buildSftLine({
    prompt: '怎么备份数据库', target: '用 pg_dump 全量备份并校验', completion: '旧答复',
    task_id: 7, category: 'ops', label: 'bad', tags: '不完整',
  }));
  assert.strictEqual(line.messages.length, 2);
  assert.strictEqual(line.messages[0].role, 'user');
  assert.strictEqual(line.messages[1].role, 'assistant');
  assert.strictEqual(line.messages[1].content, '用 pg_dump 全量备份并校验');
  assert.strictEqual(line.metadata.task_id, 7);
  assert.strictEqual(line.metadata.label, 'bad');
});

test('buildEvalLine：金标 / 实际产出 / 标签', () => {
  const line = JSON.parse(an.buildEvalLine({
    prompt: 'Q', target: null, completion: 'A', task_id: 9, category: 'general', label: 'good', tags: null,
  }));
  assert.strictEqual(line.input, 'Q');
  assert.strictEqual(line.expected_output, null, '无期望答复时保留 null，评测侧自行决定是否计分');
  assert.strictEqual(line.actual_output, 'A');
  assert.strictEqual(line.label, 'good');
  assert.strictEqual(line.metadata.category, 'general');
});

test('LABELS 只允许三档（防止写入未知标签污染评测集）', () => {
  assert.deepStrictEqual(an.LABELS, ['good', 'partial', 'bad']);
});
