const { test } = require('node:test');
const assert = require('node:assert');
const { matchKeywords, explicitCategory } = require('../../services/categoryEngine');

test('matchKeywords 命中任一关键字', () => {
  assert.ok(matchKeywords('处理等保备案材料', '备案,等保'));
  assert.ok(matchKeywords('渗透测试', '备案,渗透'));
  assert.ok(!matchKeywords('普通开发任务', '备案,等保'));
  assert.ok(!matchKeywords('', '备案'));
});

test('explicitCategory 合法返回/非法回 null', () => {
  assert.strictEqual(explicitCategory('ops'), 'ops');
  assert.strictEqual(explicitCategory('confidential'), 'confidential');
  assert.strictEqual(explicitCategory('bogus'), null);
  assert.strictEqual(explicitCategory(undefined), null);
});
