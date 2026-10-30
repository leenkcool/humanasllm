/**
 * 集成测试：工单模板
 * - CRUD + 租户可见性（全局模板 vs 租户专属）
 * - /api/templates/:id/apply 建单（预填 priority/skills/template_id）
 * - /v1 传 template_id 建单（套用模板）与非法 template_id 拒绝
 * - 分级不被模板绕过：模板含涉密关键字仍被判 confidential
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-templates';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const tplSvc = require('../../services/templateService');

const MARK = 'tpltest';

/** 唯一后缀：同一进程内多次 seed 不撞 tenants.code 唯一约束 */
let seq = 0;
const unique = () => `${MARK}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mark = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mark + '-a', '模板租户A']);
  const { lastId: tenantB } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mark + '-b', '模板租户B']);
  const { lastId: adminId } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [mark + '-admin', 'x', 'admin', '模板管理员', tenantId]);
  const { lastId: engId } = await db.run(
    'INSERT INTO users (username, password, role, name, skills, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
    [mark + '-eng', 'x', 'engineer', '模板工程师', 'postgres,ops', tenantId]);
  const created = await tplSvc.createTemplate({
    name: mark + '-迁移', category: 'ops', priority: 'high', skills: 'postgres,ops',
    system_prompt: '按迁移规范执行',
    payload_template: { messages: [{ role: 'user', content: '数据库迁移默认需求' }] },
  }, { id: adminId }, tenantId);
  return { db, mark, tenantId, tenantB, adminId, engId, tplId: created.id };
}

async function cleanup(db, tenantId, tenantB, adminId, engId, tplId) {
  const tasks = (await db.exec('SELECT id FROM tasks WHERE tenant_id IN (?, ?)', [tenantId, tenantB]))[0];
  const ids = tasks ? tasks.values.map(v => v[0]) : [];
  for (const id of ids) {
    await db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
  }
  const alerts = (await db.exec('SELECT id FROM alerts WHERE tenant_id IN (?, ?)', [tenantId, tenantB]))[0];
  if (alerts) for (const v of alerts.values) await db.run('DELETE FROM alerts WHERE id = ?', [v[0]]);
  for (const id of ids) await db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await db.run('DELETE FROM task_templates WHERE id = ?', [tplId]);
  await db.run('DELETE FROM users WHERE id IN (?, ?)', [adminId, engId]);
  await db.run('DELETE FROM tenants WHERE id IN (?, ?)', [tenantId, tenantB]);
}

test('模板 CRUD 与租户可见性', async () => {
  const s = await seed();
  const { db, tenantId, tenantB, tplId } = s;
  try {
    const own = await tplSvc.listTemplates({ tenantId });
    assert.ok(own.some(x => x.id === tplId), '本租户可见自己的模板');
    assert.ok(own.some(x => x.tenant_id === null), '全局示例模板对所有租户可见');

    const other = await tplSvc.listTemplates({ tenantId: tenantB });
    assert.ok(!other.some(x => x.id === tplId), '其他租户看不到本租户专属模板');
    assert.ok(!tplSvc.templateVisible(await tplSvc.getTemplate(tplId), tenantB), '跨租户不可见');

    const bad = await tplSvc.createTemplate({ name: '' }, null, tenantId);
    assert.strictEqual(bad.ok, false, 'name 必填');

    const upd = await tplSvc.updateTemplate(tplId, { priority: 'low' });
    assert.strictEqual(upd.ok, true);
    assert.strictEqual((await tplSvc.getTemplate(tplId)).priority, 'low');

    await tplSvc.deleteTemplate(tplId);
    assert.strictEqual((await tplSvc.getTemplate(tplId)).enabled, false, '软删置 enabled=false');
    const visible = await tplSvc.listTemplates({ tenantId });
    assert.ok(!visible.some(x => x.id === tplId), '停用模板不出现在默认列表');
  } finally {
    await cleanup(db, tenantId, tenantB, s.adminId, s.engId, tplId);
  }
});

test('/api/templates/:id/apply 建单 + /v1 传 template_id 建单', async () => {
  const s = await seed();
  const { db, mark, tenantId, tenantB, adminId, engId, tplId } = s;
  const app = express();
  app.use(express.json());
  app.use('/api/templates', require('../../routes/templates'));
  app.use('/v1', require('../../routes/v1'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ id: adminId, username: mark + '-admin', role: 'admin', tenant_id: tenantId }, process.env.JWT_SECRET);
  // /v1 无 JWT：用 upstream_key 路由租户，才能看到本租户专属模板
  const upKey = mark + '-key';
  await db.run('UPDATE tenants SET upstream_key = ? WHERE id = ?', [upKey, tenantId]);
  const upAuth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + upKey };
  try {
    // 1) apply 建单
    const res = await fetch(`${base}/api/templates/${tplId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ overrides: { messages: [{ role: 'user', content: '迁移生产库' }] } }),
    });
    const j = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(j));
    const t1 = await q.getTask(j.data.task_id);
    assert.strictEqual(t1.template_id, tplId, 'apply 建单写入 template_id');
    assert.strictEqual(t1.priority, 'high', 'priority 来自模板');
    assert.strictEqual(t1.skills, 'postgres,ops', 'skills 来自模板');
    assert.strictEqual(t1.status, 'pending');
    assert.strictEqual(t1.request_payload.messages[0].role, 'system', 'system_prompt 已插入');

    // 2) /v1 传 template_id
    const v1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: upAuth,
      body: JSON.stringify({ model: 'human-llm', template_id: tplId, messages: [{ role: 'user', content: '迁移测试库' }] }),
    });
    const v1j = await v1.json();
    assert.strictEqual(v1.status, 200, JSON.stringify(v1j));
    const t2 = await q.getTask(v1j.task_id);
    assert.strictEqual(t2.template_id, tplId);
    assert.strictEqual(t2.priority, 'high');

    // 3) 非法 template_id → 400，不建单
    const before = (await db.exec('SELECT COUNT(*) FROM tasks WHERE tenant_id = ?', [tenantId]))[0].values[0][0];
    const bad = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'human-llm', template_id: 99999999, messages: [{ role: 'user', content: 'x' }] }),
    });
    const badj = await bad.json();
    assert.strictEqual(bad.status, 400);
    assert.ok(String(badj.error && badj.error.message).includes('template'));
    const after = (await db.exec('SELECT COUNT(*) FROM tasks WHERE tenant_id = ?', [tenantId]))[0].values[0][0];
    assert.strictEqual(after, before, '非法模板不建单');

    // 4) 跨租户模板不可用
    const tplB = await tplSvc.createTemplate({ name: mark + '-B专属', category: 'general', payload_template: { messages: [{ role: 'user', content: 'B 模板' }] } }, { id: adminId }, tenantB);
    const cross = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: upAuth,
      body: JSON.stringify({ model: 'human-llm', template_id: tplB.id, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.strictEqual(cross.status, 400, '跨租户模板应拒绝');
    await db.run('DELETE FROM task_templates WHERE id = ?', [tplB.id]);
  } finally {
    await new Promise(r => server.close(r));
    await cleanup(db, tenantId, tenantB, adminId, engId, tplId);
  }
});

test('模板不能绕过分级白名单：含涉密关键字仍判 confidential', async () => {
  const s = await seed();
  const { db, mark, tenantId, tenantB } = s;
  try {
    // 建一个“general”模板，但需求文本命中涉密规则
    const t = await tplSvc.createTemplate({
      name: mark + '-伪装general', category: 'general', priority: 'low',
      payload_template: { messages: [{ role: 'user', content: '请处理涉密数据，不能外传' }] },
    }, null, tenantId);
    const merged = tplSvc.mergeIntoParsed(await tplSvc.getTemplate(t.id),
      require('../../services/openaiEncoder').parseChatRequest({ messages: [{ role: 'user', content: '请处理涉密数据，不能外传' }] }));
    const { taskId } = await q.createTaskFromRequest({ parsed: merged, chatId: 'tpl-cls', created: 1, tenantId, templateId: t.id });
    const task = await q.getTask(taskId);
    assert.strictEqual(task.category, 'confidential', '规则命中白名单锁死，模板的 general 不能降级');
    await db.run('DELETE FROM task_templates WHERE id = ?', [t.id]);
  } finally {
    await cleanup(db, tenantId, tenantB, s.adminId, s.engId, s.tplId);
  }
});
