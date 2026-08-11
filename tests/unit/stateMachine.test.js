const { test } = require('node:test');
const assert = require('node:assert');
const { TASK_TRANSITIONS, APPROVAL_TRANSITIONS, validateTransition, createStateMachine } = require('../../services/stateMachine');

test('任务合法流转', () => {
  assert.ok(validateTransition(TASK_TRANSITIONS, 'pending', 'processing'));
  assert.ok(validateTransition(TASK_TRANSITIONS, 'completed', 'returned'), 'completed→returned 打回');
  assert.ok(validateTransition(TASK_TRANSITIONS, 'returned', 'pending'), 'returned→pending 重派');
});

test('任务非法流转', () => {
  assert.ok(!validateTransition(TASK_TRANSITIONS, 'completed', 'claim'));
  assert.ok(!validateTransition(TASK_TRANSITIONS, 'pending', 'processingX'));
  assert.ok(!validateTransition(TASK_TRANSITIONS, 'cancelled', 'pending'), 'cancelled 终态不可流转');
});

test('审批流转', () => {
  assert.ok(validateTransition(APPROVAL_TRANSITIONS, 'pending', 'approved'));
  assert.ok(!validateTransition(APPROVAL_TRANSITIONS, 'approved', 'pending'));
});

test('状态机实例 can/allowed', () => {
  const sm = createStateMachine(TASK_TRANSITIONS);
  assert.ok(sm.can('pending', 'processing'));
  assert.deepStrictEqual(sm.allowed('completed'), ['returned']);
});
