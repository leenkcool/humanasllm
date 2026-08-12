const { test } = require('node:test');
const assert = require('node:assert');
const { qualityCheck } = require('../../services/queueService');

test('general：空/过短(<20)/占位拦截', () => {
  assert.ok(qualityCheck('', 'general'));
  assert.ok(qualityCheck('太短了', 'general'));
  assert.ok(qualityCheck('完成', 'general'), '占位词拦截');
  assert.ok(qualityCheck('OK', 'general'));
});

test('general：足够长非占位通过', () => {
  assert.strictEqual(qualityCheck('这是一段足够长的实际实现内容满足质量校验要求二十字以上', 'general'), null);
});

test('ops/confidential：允许简短(<20 但 >=10)', () => {
  assert.ok(qualityCheck('完成', 'ops'), '占位仍拦');
  assert.ok(qualityCheck('很短', 'confidential'), 'ops 类 <10 拦截');
  assert.strictEqual(qualityCheck('已执行迁移并验证备份恢复成功', 'ops'), null);
  assert.strictEqual(qualityCheck('已执行迁移并验证备份恢复成功', 'confidential'), null);
});
