/**
 * 集成测试：产出标注 + 私有评测集
 * - 标注只允许已完成任务；partial/bad 必须给原因或期望答复
 * - 跨租户不可标注（按 404 语义，不泄露存在性）
 * - 评测集快照不可变（生成后重新标注不影响历史版本）
 * - SFT 导出只含有期望答复的样本；评测导出全量
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-annotation-int';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const an = require('../../services/annotationService');

let seq = 0;
const unique = () => `antest-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, '标注租户']);
  const mkUser = async (suffix, role) => (await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [mk + '-' + suffix, 'x', role, '标注' + suffix, tenantId])).lastId;
  return {
    db, mk, tenantId,
    admin: await mkUser('admin', 'admin'),
    eng: await mkUser('eng', 'engineer'),
    other: await mkUser('other', 'admin'),
  };
}

async function mkCompleted(tenantId, category, question, answer) {
  const { taskId } = await q.createTaskFromRequest({
    parsed: {
      model: 'human-llm', stream: false,
      messages: [{ role: 'user', content: question }],
      extra: { priority: 'low', category }, tools: null,
    },
    chatId: 'an-' + Math.random().toString(36).slice(2, 9), created: 1, tenantId,
  });
  return taskId;
}

async function finish(taskId, engineerId, answer) {
  const claimed = await q.claimTask(taskId, engineerId, '标注 eng');
  assert.ok(claimed === undefined || claimed.ok !== false, '接单失败：' + JSON.stringify(claimed));
  const done = await q.completeTask(taskId, answer, { id: engineerId, name: '标注 eng' }, {
    completion_note: '已完成并自检，详见答复正文',
  });
  assert.ok(done && done.ok !== false, '完成失败：' + JSON.stringify(done));
  return done;
}

async function cleanup(s, taskIds) {
  // 顺序：子表 → 主表（漏一张就会外键失败并把测试进程挂死）
  for (const id of taskIds) {
    await s.db.run('DELETE FROM alerts WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM billing_ledger WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_reviews WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_feedback WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_annotations WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
  }
  await s.db.run(`DELETE FROM eval_set_items WHERE set_id IN (SELECT id FROM eval_sets WHERE tenant_id = ?)`, [s.tenantId]);
  await s.db.run('DELETE FROM eval_sets WHERE tenant_id = ?', [s.tenantId]);
  for (const id of taskIds) await s.db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await s.db.run('DELETE FROM users WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM tenants WHERE id = ?', [s.tenantId]);
}

test('标注：仅已完成任务可标；partial/bad 必须给原因或期望答复', async () => {
  const s = await seed();
  const ids = [];
  try {
    const pending = await mkCompleted(s.tenantId, 'general', '待处理问题', '');
    ids.push(pending);
    const r0 = await an.annotate({
      taskId: pending, actor: { id: s.admin, name: 'admin' }, label: 'good', tenantId: s.tenantId,
    });
    assert.strictEqual(r0.ok, false);
    assert.ok(r0.message.includes('已完成'));

    const id = await mkCompleted(s.tenantId, 'general', '如何在 PostgreSQL 建只读账号', '');
    ids.push(id);
    await finish(id, s.eng, '先 CREATE ROLE，再 GRANT CONNECT 与 SELECT，最后在 pg_hba 中限制来源。');

    const bad = await an.annotate({
      taskId: id, actor: { id: s.admin, name: 'admin' }, label: 'bogus', tenantId: s.tenantId,
    });
    assert.strictEqual(bad.ok, false, '未知标签应拒绝');

    const noWhy = await an.annotate({
      taskId: id, actor: { id: s.admin, name: 'admin' }, label: 'bad', tenantId: s.tenantId,
    });
    assert.strictEqual(noWhy.ok, false);
    assert.ok(noWhy.message.includes('期望答复'));

    const ok = await an.annotate({
      taskId: id, actor: { id: s.admin, name: 'admin' }, label: 'bad',
      tags: '不完整, 未验证', note: '缺少 pg_hba 具体写法',
      expected: 'CREATE ROLE ro LOGIN PASSWORD ...; GRANT SELECT ON ALL TABLES ...', tenantId: s.tenantId,
    });
    assert.strictEqual(ok.ok, true, ok.message);
    assert.strictEqual(ok.annotation.label, 'bad');

    // 幂等：再标一次是更新而非新增
    await an.annotate({
      taskId: id, actor: { id: s.eng, name: 'eng' }, label: 'good', tenantId: s.tenantId,
    });
    const cnt = q.rows(await s.db.exec('SELECT COUNT(*) AS c FROM task_annotations WHERE task_id = ?', [id]))[0];
    assert.strictEqual(parseInt(cnt.c, 10), 1);
    assert.strictEqual((await an.getByTask(id)).label, 'good');

    // 标注留痕进哈希链
    const logs = q.rows(await s.db.exec('SELECT action FROM task_logs WHERE task_id = ?', [id]));
    assert.ok(logs.some(l => l.action === 'annotate'), '应有 annotate 审计记录');
    const chain = await q.verifyAuditChain(id);
    assert.strictEqual(chain.valid, true, '标注后哈希链仍完整');
  } finally {
    await cleanup(s, ids);
  }
});

test('跨租户不可标注（按不存在处理）', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkCompleted(s.tenantId, 'general', '跨租户测试问题', '');
    ids.push(id);
    await finish(id, s.eng, '这是一段足够长的答复内容，用于跨租户校验。');
    const r = await an.annotate({
      taskId: id, actor: { id: s.other, name: 'other' }, label: 'good', tenantId: s.tenantId + 99999,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.message, '任务不存在');
  } finally {
    await cleanup(s, ids);
  }
});

test('评测集：快照不可变 + SFT 只导有期望答复的样本', async () => {
  const s = await seed();
  const ids = [];
  try {
    const good = await mkCompleted(s.tenantId, 'general', '前端组件目录怎么组织更清晰', '');
    const bad = await mkCompleted(s.tenantId, 'general', '接口文档怎么写才清楚', '');
    ids.push(good, bad);
    await finish(good, s.eng, '按 QPS 设最大连接数，开启 statement_timeout，用 pgBouncer 复用连接。');
    await finish(bad, s.eng, '先看慢日志，再结合执行计划分析，具体做法待补充说明。');

    await an.annotate({
      taskId: good, actor: { id: s.admin, name: 'admin' }, label: 'good', tenantId: s.tenantId,
    });
    await an.annotate({
      taskId: bad, actor: { id: s.admin, name: 'admin' }, label: 'partial',
      expected: '开启 pg_stat_statements，按总耗时排序取 TOP N，逐条看执行计划。', tenantId: s.tenantId,
    });

    const created = await an.createEvalSet({
      tenantId: s.tenantId, actor: { id: s.admin, name: 'admin' }, name: '通用评测集', category: 'general',
    });
    assert.strictEqual(created.ok, true, created.message);
    const set = created.set;
    assert.strictEqual(set.item_count, 2);
    assert.strictEqual(set.stats.good, 1);
    assert.strictEqual(set.stats.partial, 1);
    assert.strictEqual(set.stats.with_target, 2, 'good 取原答复，partial 取期望答复');

    // 快照不可变：重新标注后历史版本内容不变
    await an.annotate({
      taskId: bad, actor: { id: s.admin, name: 'admin' }, label: 'bad', note: '答复过短', tenantId: s.tenantId,
    });
    const again = await an.getEvalSet({ id: set.id, tenantId: s.tenantId });
    assert.strictEqual(again.items.length, 2);
    assert.strictEqual(again.items.find(i => i.task_id === bad).label, 'partial', '历史快照不应被改写');

    // 导出
    const sft = await an.exportLines({ id: set.id, tenantId: s.tenantId, format: 'sft' });
    assert.strictEqual(sft.ok, true);
    assert.strictEqual(sft.lines.length, 2);
    assert.strictEqual(sft.skipped, 0);
    const parsed = JSON.parse(sft.lines[0]);
    assert.ok(parsed.messages[1].content.length > 0);

    const evalOut = await an.exportLines({ id: set.id, tenantId: s.tenantId, format: 'eval' });
    assert.strictEqual(evalOut.lines.length, 2);
    assert.ok('expected_output' in JSON.parse(evalOut.lines[0]));

    // 无匹配标注时拒绝生成
    const empty = await an.createEvalSet({
      tenantId: s.tenantId, actor: { id: s.admin, name: 'admin' }, category: 'confidential',
    });
    assert.strictEqual(empty.ok, false);
  } finally {
    await cleanup(s, ids);
  }
});

test('统计：覆盖率与高频缺陷标签', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkCompleted(s.tenantId, 'general', '统计口径问题', '');
    ids.push(id);
    await finish(id, s.eng, '这是一段完整的答复内容，用于统计口径的校验与验证。');
    await an.annotate({
      taskId: id, actor: { id: s.admin, name: 'admin' }, label: 'bad',
      tags: '过时,不完整', expected: '给出更新后的做法', tenantId: s.tenantId,
    });
    const st = await an.stats({ tenantId: s.tenantId });
    assert.strictEqual(st.completed, 1);
    assert.strictEqual(st.annotated, 1);
    assert.strictEqual(st.coverage, 100);
    assert.strictEqual(st.bad, 1);
    assert.strictEqual(st.top_tags.length, 2);
    assert.strictEqual(st.top_tags[0].count, 1);
  } finally {
    await cleanup(s, ids);
  }
});
