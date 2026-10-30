/**
 * 单元测试：答复审核（纯函数 + 分级策略）
 * - general 免审，ops/confidential 需审
 * - 四维评分加权
 * - 上游可见状态映射
 */
const { test } = require('node:test');
const assert = require('node:assert');

const review = require('../../services/reviewService');

test('分级策略：general 免审，ops/confidential 需审', () => {
  assert.strictEqual(review.requiresReview('general'), false);
  assert.strictEqual(review.requiresReview('ops'), true);
  assert.strictEqual(review.requiresReview('confidential'), true);
  assert.strictEqual(review.requiresReview(undefined), false, '缺省按 general');
});

test('仅 confidential 需要 admin 抽检', () => {
  assert.strictEqual(review.needsSpotCheck('confidential'), true);
  assert.strictEqual(review.needsSpotCheck('ops'), false);
  assert.strictEqual(review.needsSpotCheck('general'), false);
});

test('四维评分：等权平均，保留两位', () => {
  assert.strictEqual(review.totalScore({ completeness: 5, accuracy: 5, actionable: 4, boundary: 4 }), 4.5);
  assert.strictEqual(review.totalScore({ completeness: 5, accuracy: 5, actionable: 5, boundary: 5 }), 5);
  assert.strictEqual(review.totalScore({ completeness: 1, accuracy: 2, actionable: 3, boundary: 4 }), 2.5);
});

test('四维评分：部分缺省时按已给维度平均', () => {
  assert.strictEqual(review.totalScore({ completeness: 4, accuracy: 4 }), 4);
  assert.strictEqual(review.totalScore({ completeness: 3 }), 3);
});

test('四维评分：空输入返回 null，不炸', () => {
  assert.strictEqual(review.totalScore({}), null);
  assert.strictEqual(review.totalScore(null), null);
  assert.strictEqual(review.totalScore(undefined), null);
});

test('上游可见状态映射', () => {
  assert.strictEqual(review.upstreamStatus(null), null);
  assert.strictEqual(review.upstreamStatus({ status: 'draft' }), 'reviewing');
  assert.strictEqual(review.upstreamStatus({ status: 'needs_revision' }), 'needs_revision');
  assert.strictEqual(review.upstreamStatus({ status: 'reviewed' }), 'reviewed');
  assert.strictEqual(review.upstreamStatus({ status: 'delivered' }), 'delivered');
  assert.strictEqual(review.upstreamStatus({ status: 'spot_checked' }), 'delivered');
});

test('SCORE_FIELDS 恰好四维', () => {
  assert.deepStrictEqual(review.SCORE_FIELDS, ['completeness', 'accuracy', 'actionable', 'boundary']);
});
