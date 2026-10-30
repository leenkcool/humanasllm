/**
 * 集成测试：答复审核
 * - general 免审直接 delivered；ops/confidential 需审核
 * - 审核前上游拿 reviewing 不带内容，审核后放行
 * - 退回修改 → needs_revision；重新提交 → draft
 * - 不能审核自己的答复
 * - 抽检仅 confidential 且仅 admin
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-review';

const { initDatabase, getDb } = require('../../db');
const q = require('../../services/queueService');
const review = require('../../services/reviewService');
const taskView = require('../../services/taskView');

let seq = 0;
const unique = () => `rvtest-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  const db = getDb();
  const mk = unique();
  const { lastId: tenantId } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mk, '审核租户']);
  const mkUser = async (suffix, role) => (await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [mk + '-' + suffix, 'x', role, '审核' + suffix, tenantId])).lastId;
  return { db, mk, tenantId, admin: await mkUser('admin', 'admin'), eng: await mkUser('eng', 'engineer'), eng2: await mkUser('eng2', 'engineer') };
}

async function mkTask(tenantId, category) {
  const { taskId } = await q.createTaskFromRequest({
    parsed: {
      model: 'human-llm', stream: false,
      messages: [{ role: 'user', content: `审核测试任务 ${category}` }],
      extra: { priority: 'low', category }, tools: null,
    },
    chatId: 'rv-' + Math.random().toString(36).slice(2, 9), created: 1, tenantId,
  });
  return taskId;
}

async function complete(taskId, engineerId, content) {
  await q.claimTask(taskId, engineerId, '审核 eng');
  return q.completeTask(taskId, content, { id: engineerId, name: '审核 eng' }, {
    completion_note: categoryNote(taskId),
  });
}

function categoryNote() { return '已完成并自检，详见答复正文'; }

async function cleanup(s, taskIds) {
  for (const id of taskIds) {
    await s.db.run('DELETE FROM alerts WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM billing_ledger WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_reviews WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM task_logs WHERE task_id = ?', [id]);
    await s.db.run('DELETE FROM request_logs WHERE task_id = ?', [id]);
  }
  for (const id of taskIds) await s.db.run('DELETE FROM tasks WHERE id = ?', [id]);
  await s.db.run('DELETE FROM task_reviews WHERE task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)', [s.tenantId]);
  await s.db.run('DELETE FROM users WHERE tenant_id = ?', [s.tenantId]);
  await s.db.run('DELETE FROM tenants WHERE id = ?', [s.tenantId]);
}

test('general 免审：完成后直接 delivered，上游可立即拿到内容', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkTask(s.tenantId, 'general');
    ids.push(id);
    await complete(id, s.eng, '这是通用类任务的完整答复内容，长度足够通过质量校验。');
    await new Promise(r => setTimeout(r, 200)); // 审核记录异步创建
    const rev = await review.getByTask(id);
    assert.ok(rev, '应创建审核记录');
    assert.strictEqual(rev.status, 'delivered', 'general 免审直接放行');
    const view = await taskView.buildTaskView(await q.getTask(id));
    assert.strictEqual(view.review_status, 'delivered');
    assert.ok(String(view.content).includes('完整答复内容'));
  } finally {
    await cleanup(s, ids);
  }
});

test('ops 需审：审核前上游拿 reviewing 不带内容，审核后放行', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkTask(s.tenantId, 'ops');
    ids.push(id);
    await complete(id, s.eng, '已完成磁盘清理：删除 /var/log 下 7 天前日志，释放 12GB。');
    await new Promise(r => setTimeout(r, 200));

    const rev = await review.getByTask(id);
    assert.strictEqual(rev.status, 'draft', 'ops 类应进入待审');
    const before = await taskView.buildTaskView(await q.getTask(id));
    assert.strictEqual(before.review_status, 'reviewing');
    assert.ok(String(before.content).includes('待审核'), '审核前不应返回正文');

    const ap = await review.approve({
      taskId: id, actor: { id: s.admin, name: '审核 admin' },
      scores: { completeness: 5, accuracy: 5, actionable: 4, boundary: 4 }, note: '可执行',
    });
    assert.strictEqual(ap.ok, true, ap.message);
    assert.strictEqual(ap.score_total, 4.5);

    const after = await taskView.buildTaskView(await q.getTask(id));
    assert.strictEqual(after.review_status, 'delivered');
    assert.ok(String(after.content).includes('释放 12GB'));

    // 审核留痕进哈希链
    const logs = q.rows(await s.db.exec('SELECT action FROM task_logs WHERE task_id = ?', [id]));
    assert.ok(logs.some(l => l.action === 'review'), '应有 review 审计记录');
    const chain = await q.verifyAuditChain(id);
    assert.strictEqual(chain.valid, true, '审核后哈希链仍完整');
  } finally {
    await cleanup(s, ids);
  }
});

test('退回修改 → needs_revision；重新提交 → draft', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkTask(s.tenantId, 'ops');
    ids.push(id);
    await complete(id, s.eng, '已处理磁盘告警，具体细节待补充。');
    await new Promise(r => setTimeout(r, 200));

    const rv = await review.requestRevision({
      taskId: id, actor: { id: s.admin, name: '审核 admin' }, reason: '缺少清理后的磁盘占用截图与验证结果',
    });
    assert.strictEqual(rv.ok, true);
    assert.strictEqual((await review.getByTask(id)).status, 'needs_revision');

    const view = await taskView.buildTaskView(await q.getTask(id));
    assert.strictEqual(view.review_status, 'needs_revision');

    await review.resubmit({ taskId: id });
    assert.strictEqual((await review.getByTask(id)).status, 'draft', '重新提交回到待审');

    // 退回无原因应拒绝
    const bad = await review.requestRevision({ taskId: id, actor: { id: s.admin, name: 'a' }, reason: '  ' });
    assert.strictEqual(bad.ok, false);
  } finally {
    await cleanup(s, ids);
  }
});

test('不能审核自己提交的答复', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkTask(s.tenantId, 'ops');
    ids.push(id);
    await complete(id, s.eng, '已完成磁盘清理并验证，占用从 96% 降到 68%。');
    await new Promise(r => setTimeout(r, 200));
    // 先让 eng 成为审核人（模拟自审）
    await s.db.run('UPDATE task_reviews SET reviewer_id = ? WHERE task_id = ?', [s.eng, id]);
    const r = await review.approve({ taskId: id, actor: { id: s.eng, name: '审核 eng' }, scores: {} });
    assert.strictEqual(r.ok, false);
    assert.ok(r.message.includes('自己'));
  } finally {
    await cleanup(s, ids);
  }
});

test('抽检：仅 confidential 已放行的答复可抽检', async () => {
  const s = await seed();
  const ids = [];
  try {
    const id = await mkTask(s.tenantId, 'confidential');
    ids.push(id);
    await complete(id, s.eng, '涉密整改方案已完成，含权限矩阵与访问审计配置说明。');
    await new Promise(r => setTimeout(r, 200));
    await review.approve({ taskId: id, actor: { id: s.admin, name: '审核 admin' }, scores: { completeness: 5 } });

    const pending = await review.listSpotCheck({ tenantId: s.tenantId });
    assert.ok(pending.some(x => x.task_id === id), 'confidential 已放行应进抽检队列');

    const sc = await review.spotCheck({ taskId: id, actor: { id: s.admin, name: '审核 admin' }, pass: true, note: '复核无误' });
    assert.strictEqual(sc.ok, true);
    assert.strictEqual(sc.status, 'spot_checked');

    // ops 类不进抽检队列
    const id2 = await mkTask(s.tenantId, 'ops');
    ids.push(id2);
    await complete(id2, s.eng2 || s.eng, '运维类答复内容，已完成并验证，详情见正文说明。');
    await new Promise(r => setTimeout(r, 200));
    await review.approve({ taskId: id2, actor: { id: s.admin, name: '审核 admin' }, scores: {} });
    const p2 = await review.listSpotCheck({ tenantId: s.tenantId });
    assert.ok(!p2.some(x => x.task_id === id2), 'ops 不进抽检队列');
  } finally {
    await cleanup(s, ids);
  }
});

test('审核统计', async () => {
  const s = await seed();
  const ids = [];
  try {
    const a = await mkTask(s.tenantId, 'ops');
    ids.push(a);
    await complete(a, s.eng, '运维答复一：已完成并自检，详见说明。');
    await new Promise(r => setTimeout(r, 200));
    await review.approve({ taskId: a, actor: { id: s.admin, name: 'admin' }, scores: { completeness: 4 } });

    const b = await mkTask(s.tenantId, 'ops');
    ids.push(b);
    await complete(b, s.eng, '运维答复二：等待审核中，内容完整。');
    await new Promise(r => setTimeout(r, 200));

    const st = await review.stats({ tenantId: s.tenantId });
    assert.strictEqual(st.delivered, 1);
    assert.strictEqual(st.pending, 1);
    assert.strictEqual(st.avg_score, 4);
  } finally {
    await cleanup(s, ids);
  }
});
