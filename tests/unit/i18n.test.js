const { test } = require('node:test');
const assert = require('node:assert');
const { toEn } = require('../../services/i18n');

test('字典直译', () => {
  assert.strictEqual(toEn('任务不存在'), 'Task not found');
  assert.strictEqual(toEn('用户名或密码错误'), 'Invalid username or password');
  assert.strictEqual(toEn('非法角色'), 'Invalid role');
});

test('前缀模板翻译（动态消息）', () => {
  assert.strictEqual(toEn('非法状态流转: pending → completed'), 'Illegal status transition: pending → completed');
  assert.strictEqual(toEn('任务被驳回: 内容不够'), 'Task rejected: 内容不够');
});

test('未知原文透传', () => {
  assert.strictEqual(toEn('某个未收录的中文消息'), '某个未收录的中文消息');
});
