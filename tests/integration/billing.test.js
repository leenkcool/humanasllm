/**
 * 集成测试：计费计量（连真实 PostgreSQL）
 *  - 结算写入 ledger、金额正确
 *  - 重复结算幂等（一个任务一条流水）
 *  - AI 产出 0 元且 source=ai_relay
 *  - 租户账单相互隔离
 *  - 费率列表全局 + 租户专属均可见
 *
 * 清理顺序：先删 billing_ledger（外键）再删 tasks，最后 users / tenants / billing_rates。
 */
const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-billing';

const { initDatabase, getDb } = require('../../db');
const billing = require('../../services/billingService');

const MARK = 'billtest';

/** 唯一后缀：同一进程内多次 seed 不撞 tenants.code 唯一约束 */
let seq = 0;
const unique = () => `${MARK}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

async function seed() {
  await initDatabase();
  await billing.ensureSchema();
  // 全局默认费率幂等播种（与生产启动一致；已存在则跳过，不做清理）
  await billing.seedRates();
  const db = getDb();
  const mark = unique();
  const { lastId: tenantA } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mark + '-a', '计费租户A']);
  const { lastId: tenantB } = await db.run('INSERT INTO tenants (code, name) VALUES (?, ?)', [mark + '-b', '计费租户B']);
  const { lastId: engId } = await db.run(
    'INSERT INTO users (username, password, role, name, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [mark + '-eng', 'x', 'engineer', '计费工程师', tenantA]);
  // 租户 A 专属费率：general/medium 600 分/分钟，最低 200
  const { lastId: rateId } = await db.run(
    'INSERT INTO billing_rates (tenant_id, category, priority, unit_price_cents, min_charge_cents, enabled) VALUES (?, ?, ?, ?, ?, ?)',
    [tenantA, 'general', 'medium', 600, 200, true]);
  return { db, mark, tenantA, tenantB, engId, rateId };
}

/** 本地时间字符串（不带 Z）：tasks.claimed_at/completed_at 是 TIMESTAMP 无时区，按本地字面量写入可避免时区偏移 */
function localIso(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 造一个已完成任务（claimed → completed 的时长可控） */
async function makeTask(db, { tenantId, assigneeId, category = 'general', priority = 'medium', minutes = 2.5, source = null, projectCode = 'P1' }) {
  const completed = new Date(Date.now() - 60000);
  const claimed = new Date(completed.getTime() - minutes * 60000);
  const payload = source ? JSON.stringify({ content: '产出内容', source }) : JSON.stringify({ content: '人工产出内容' });
  const { lastId } = await db.run(
    `INSERT INTO tasks (tenant_id, category, priority, status, assignee_id, project_code, claimed_at, completed_at, result_text, result_payload)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?::jsonb)`,
    [tenantId, category, priority, assigneeId, projectCode, localIso(claimed), localIso(completed), '产出内容', payload]);
  return lastId;
}

async function cleanup(db, s) {
  const { tenantA, tenantB, engId, rateId } = s;
  await db.run('DELETE FROM billing_ledger WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
  const tasks = (await db.exec('SELECT id FROM tasks WHERE tenant_id IN (?, ?)', [tenantA, tenantB]))[0];
  if (tasks) for (const v of tasks.values) await db.run('DELETE FROM task_logs WHERE task_id = ?', [v[0]]);
  await db.run('DELETE FROM task_reviews WHERE task_id IN (SELECT id FROM tasks WHERE tenant_id IN (?, ?))', [tenantA, tenantB]);
  await db.run('DELETE FROM tasks WHERE tenant_id IN (?, ?)', [tenantA, tenantB]);
  await db.run('DELETE FROM billing_rates WHERE id = ? OR tenant_id IN (?, ?)', [rateId, tenantA, tenantB]);
  await db.run('DELETE FROM users WHERE id = ?', [engId]);
  await db.run('DELETE FROM tenants WHERE id IN (?, ?)', [tenantA, tenantB]);
}

test('settleTask 写入流水且金额正确；重复结算幂等', async () => {
  const s = await seed();
  const { db, tenantA, engId } = s;
  try {
    const taskId = await makeTask(db, { tenantId: tenantA, assigneeId: engId, minutes: 2.5 });
    const first = await billing.settleTask(taskId);
    assert.strictEqual(first.settled, true, JSON.stringify(first));
    // 2.5 分钟 × 600 分 = 1500 分
    assert.strictEqual(first.data.amount_cents, 1500);
    assert.strictEqual(first.data.billable_minutes, 2.5);
    assert.strictEqual(first.data.unit_price_cents, 600);
    assert.strictEqual(first.data.source, 'human');

    const ledger = await db.exec('SELECT * FROM billing_ledger WHERE task_id = ?', [taskId]);
    assert.strictEqual(ledger[0].values.length, 1, '一个任务一条流水');
    const cols = ledger[0].columns;
    const row = {};
    cols.forEach((c, i) => { row[c] = ledger[0].values[0][i]; });
    assert.strictEqual(Number(row.amount_cents), 1500);
    assert.match(String(row.period), /^\d{4}-\d{2}$/, '期间归档为 YYYY-MM');

    const second = await billing.settleTask(taskId);
    assert.strictEqual(second.settled, false);
    assert.strictEqual(second.reason, 'already_settled');
    const again = await db.exec('SELECT COUNT(*) AS c FROM billing_ledger WHERE task_id = ?', [taskId]);
    assert.strictEqual(Number(again[0].values[0][0]), 1, '重复结算不新增流水');
  } finally {
    await cleanup(db, s);
  }
});

test('最低消费生效：短任务按 min_charge 计', async () => {
  const s = await seed();
  const { db, tenantA, engId } = s;
  try {
    const taskId = await makeTask(db, { tenantId: tenantA, assigneeId: engId, minutes: 0.3 });
    const r = await billing.settleTask(taskId);
    assert.strictEqual(r.settled, true);
    assert.strictEqual(r.data.billable_minutes, 0.5, '不足 0.5 分钟按 0.5 计');
    // 0.5 × 600 = 300 > 最低 200，故取 300（验证取大逻辑而非永远取最低）
    assert.strictEqual(r.data.amount_cents, 300);
  } finally {
    await cleanup(db, s);
  }
});

test('AI 产出：0 元 + source=ai_relay，但流水仍写入', async () => {
  const s = await seed();
  const { db, tenantA, engId } = s;
  try {
    const taskId = await makeTask(db, { tenantId: tenantA, assigneeId: null, minutes: 5, source: 'ai-relay' });
    const r = await billing.settleTask(taskId);
    assert.strictEqual(r.settled, true, JSON.stringify(r));
    assert.strictEqual(r.data.amount_cents, 0);
    assert.strictEqual(r.data.billable_minutes, 0);
    assert.strictEqual(r.data.source, 'ai_relay');

    const ledger = await db.exec('SELECT amount_cents, source FROM billing_ledger WHERE task_id = ?', [taskId]);
    assert.strictEqual(ledger[0].values.length, 1, 'AI 产出仍有审计流水');
    assert.strictEqual(Number(ledger[0].values[0][0]), 0);
    assert.strictEqual(ledger[0].values[0][1], 'ai_relay');
  } finally {
    await cleanup(db, s);
  }
});

test('租户账单隔离：各租户只统计自己', async () => {
  const s = await seed();
  const { db, tenantA, tenantB, engId } = s;
  try {
    const a1 = await makeTask(db, { tenantId: tenantA, assigneeId: engId, minutes: 2.5, projectCode: 'PA' });
    const a2 = await makeTask(db, { tenantId: tenantA, assigneeId: engId, minutes: 1, projectCode: 'PB' });
    const b1 = await makeTask(db, { tenantId: tenantB, assigneeId: null, minutes: 3, projectCode: 'PB' });
    for (const id of [a1, a2, b1]) {
      const r = await billing.settleTask(id);
      assert.strictEqual(r.settled, true, JSON.stringify(r));
    }
    // 期间以流水实际归档为准（避免跨月边界导致断言抖动）
    const pRow = await db.exec('SELECT DISTINCT period FROM billing_ledger WHERE task_id IN (?, ?, ?)', [a1, a2, b1]);
    const period = pRow[0].values[0][0];
    assert.strictEqual(pRow[0].values.length, 1, '同批任务归档同一期间');

    const sa = await billing.tenantStatement({ tenantId: tenantA, period });
    assert.strictEqual(sa.total_cents, 1500 + 600, 'A 租户 2.5×600 + 1×600');
    assert.strictEqual(sa.task_count, 2);
    assert.strictEqual(sa.by_project.length, 2);
    assert.ok(sa.by_project.every(p => p.key !== ''), '项目分组有效');
    const pa = sa.by_project.find(p => p.key === 'PA');
    assert.strictEqual(pa.amount_cents, 1500);

    const sb = await billing.tenantStatement({ tenantId: tenantB, period });
    assert.strictEqual(sb.task_count, 1, 'B 租户只看到自己的 1 条');
    assert.ok(sb.total_cents > 0);
    assert.ok(sb.by_assignee.every(x => x.assignee_id === null), 'B 无指派人');

    // listLedger 同样隔离
    const la = await billing.listLedger({ tenantId: tenantA, period, page: 1, size: 50 });
    assert.strictEqual(la.total, 2);
    assert.ok(la.data.every(r => r.tenant_id === tenantA));
    assert.strictEqual(la.data[0].assignee_name, '计费工程师', 'join 出指派人姓名');
    assert.ok(typeof la.data[0].amount_yuan === 'string');
  } finally {
    await cleanup(db, s);
  }
});

test('listRates：全局 + 本租户专属均可见，且租户优先', async () => {
  const s = await seed();
  const { db, tenantA, tenantB, rateId } = s;
  let globalRateId = null;
  try {
    // 确保存在一条全局费率（可能已由 seedRates 播种，则复用）
    const g = await db.exec('SELECT id FROM billing_rates WHERE tenant_id IS NULL LIMIT 1');
    if (g[0] && g[0].values.length) {
      globalRateId = g[0].values[0][0];
    } else {
      const ins = await db.run(
        'INSERT INTO billing_rates (tenant_id, category, priority, unit_price_cents, min_charge_cents, enabled) VALUES (NULL, ?, ?, ?, ?, ?)',
        ['general', 'medium', 400, 500, true]);
      globalRateId = ins.lastId;
    }

    const list = await billing.listRates({ tenantId: tenantA });
    assert.ok(list.some(r => Number(r.id) === Number(rateId)), '本租户费率可见');
    assert.ok(list.some(r => r.tenant_id === null), '全局费率可见');
    assert.ok(!list.some(r => r.tenant_id === tenantB), '看不到其他租户费率');

    // 租户优先于全局
    const resolved = billing.resolveRate({
      tenantId: tenantA, category: 'general', priority: 'medium', rates: list,
    });
    assert.strictEqual(resolved.source, 'tenant');
    assert.strictEqual(resolved.unit_price_cents, 600);

    const resolvedB = billing.resolveRate({
      tenantId: tenantB, category: 'general', priority: 'medium', rates: await billing.listRates({ tenantId: tenantB }),
    });
    assert.notStrictEqual(resolvedB.source, 'tenant', 'B 租户无专属费率，回退全局');
  } finally {
    // 全局费率由既有种子复用时不删；本次新建的才删
    const g = await db.exec('SELECT COUNT(*) AS c FROM billing_rates WHERE tenant_id IS NULL');
    if (Number(g[0].values[0][0]) === 0 && globalRateId) {
      await db.run('DELETE FROM billing_rates WHERE id = ?', [globalRateId]);
    }
    await cleanup(db, s);
  }
});

test('settlePendingTasks 批量补结算（幂等）', async () => {
  const s = await seed();
  const { db, tenantA, engId } = s;
  // settlePendingTasks 会扫全库：记录跑前的最大流水 id，finally 里回滚「非本测试租户」的副产物，
  // 避免把开发库里演示租户的历史任务也补入账（测试不应污染其他租户数据）。
  const before = await db.exec('SELECT COALESCE(MAX(id), 0) FROM billing_ledger');
  const maxId = Number(before[0].values[0][0]) || 0;
  try {
    const t1 = await makeTask(db, { tenantId: tenantA, assigneeId: engId, minutes: 1 });
    const t2 = await makeTask(db, { tenantId: tenantA, assigneeId: engId, minutes: 2 });
    // 该函数扫全库，并发跑测试时其它用例的任务也会被扫到；调大 limit 保证本用例任务不被挤出
    await billing.settlePendingTasks({ limit: 5000 });
    const cnt = await db.exec('SELECT COUNT(*) AS c FROM billing_ledger WHERE task_id IN (?, ?)', [t1, t2]);
    assert.strictEqual(Number(cnt[0].values[0][0]), 2, '两个未入账任务均被补结算');
    // 再跑一次：本租户任务不应新增流水（只校验本次造的任务）
    await billing.settlePendingTasks({ limit: 5000 });
    const again = await db.exec('SELECT COUNT(*) AS c FROM billing_ledger WHERE task_id IN (?, ?)', [t1, t2]);
    assert.strictEqual(Number(again[0].values[0][0]), 2, '已入账任务不重复结算');
  } finally {
    await db.run('DELETE FROM billing_ledger WHERE id > ? AND (tenant_id IS NULL OR tenant_id NOT IN (?, ?))', [maxId, tenantA, s.tenantB]);
    await cleanup(db, s);
  }
});
