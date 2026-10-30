/**
 * 产出标注 + 私有评测集服务（数据飞轮后半段）
 *
 * 链路：人工答复 → 审核（已有）→ 标注（本服务）→ 私有评测集快照 → SFT / 评测 JSONL
 *
 * 设计要点：
 *   - 标注是幂等 upsert（一个任务一条），标签三档 good / partial / bad；
 *   - 不合格（partial / bad）必须给出原因或期望答复，否则标注无价值；
 *   - 评测集是**不可变快照**（生成时把标注内容复制进 eval_set_items），
 *     后续重新标注不会改写历史版本，便于「v1 vs v2」对比与追溯；
 *   - 涉密 / 运维类评测集导出仅 admin（与 /api/audit/dataset 同一门禁策略）。
 */
const { getDb } = require('../db');
const { rows, addLog } = require('./queueService');

const LABELS = ['good', 'partial', 'bad'];
const MAX_TEXT = 20000;

function labelText(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** 缺陷标签归一：中英文逗号 / 分号 / 空白分隔 → 数组去重（保持原大小写用于展示） */
function normTags(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(/[,，;；\n]/);
  const out = [];
  for (const s of list) {
    const k = String(s).trim();
    if (k && !out.some(x => x.toLowerCase() === k.toLowerCase())) out.push(k);
  }
  return out;
}

function clampText(v, max = MAX_TEXT) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

async function getTask(taskId) {
  return rows(await getDb().exec('SELECT * FROM tasks WHERE id = ?', [taskId]))[0] || null;
}

/** 上游请求的提示词（与审核/知识库同一口径：拼接全部 user 消息） */
function promptOf(task) {
  const msgs = (task.request_payload && task.request_payload.messages) || [];
  return msgs
    .filter(m => m && m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean).join('\n').trim();
}

async function getByTask(taskId) {
  return rows(await getDb().exec('SELECT * FROM task_annotations WHERE task_id = ?', [taskId]))[0] || null;
}

/**
 * 打标（幂等 upsert）
 * @returns {{ok:boolean, message?:string, annotation?:object}}
 */
async function annotate({ taskId, actor, label, tags, note, expected, tenantId }) {
  const task = await getTask(taskId);
  if (!task) return { ok: false, message: '任务不存在' };
  if (tenantId != null && task.tenant_id != null && task.tenant_id !== tenantId) {
    return { ok: false, message: '任务不存在' };
  }
  if (task.status !== 'completed') return { ok: false, message: '仅已完成的答复可标注' };

  const lb = labelText(label);
  if (!LABELS.includes(lb)) return { ok: false, message: '标注标签非法（good / partial / bad）' };

  const t = normTags(tags).join(',');
  const n = clampText(note);
  const exp = clampText(expected);
  // 不合格答复必须说明「哪里不行」或「应该怎么答」，否则标注对评测/精调无信息量
  if (lb !== 'good' && !n && !exp) {
    return { ok: false, message: '标注为 partial / bad 时必须填写缺陷说明或期望答复' };
  }

  const name = (actor && (actor.name || actor.username)) || '系统';
  const prev = await getByTask(taskId);
  await getDb().run(
    `INSERT INTO task_annotations (task_id, label, tags, note, expected, annotator_id, annotator_name, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE
       SET label = EXCLUDED.label, tags = EXCLUDED.tags, note = EXCLUDED.note,
           expected = EXCLUDED.expected, annotator_id = EXCLUDED.annotator_id,
           annotator_name = EXCLUDED.annotator_name, updated_at = NOW()`,
    [taskId, lb, t || null, n, exp, actor ? actor.id : null, name, task.tenant_id != null ? task.tenant_id : (tenantId || null)]);

  // 留痕进审计哈希链（与 review 同一链，可验证完整性）
  await addLog(taskId, 'annotate',
    prev ? { label: prev.label, tags: prev.tags } : null,
    { label: lb, tags: t || null, has_expected: !!exp },
    actor || { name }, n || exp || '').catch(() => {});

  return { ok: true, annotation: await getByTask(taskId) };
}

/**
 * 待标注队列
 * @param {object} o
 * @param {'unannotated'|'annotated'|'all'} o.filter
 */
async function listCandidates({ tenantId, filter = 'unannotated', category, page = 1, size = 20 }) {
  const db = getDb();
  const where = [`t.tenant_id = ?`, `t.status = 'completed'`];
  const params = [tenantId || null];
  if (filter === 'unannotated') where.push('a.id IS NULL');
  else if (filter === 'annotated') where.push('a.id IS NOT NULL');
  if (category && ['general', 'confidential', 'ops'].includes(category)) {
    where.push('t.category = ?');
    params.push(category);
  }
  const from = `FROM tasks t
      LEFT JOIN task_annotations a ON a.task_id = t.id
      LEFT JOIN task_feedback f ON f.task_id = t.id
      LEFT JOIN task_reviews r ON r.task_id = t.id
     WHERE ${where.join(' AND ')}`;
  const total = parseInt(rows(await db.exec(`SELECT COUNT(*) AS c ${from}`, params))[0].c, 10) || 0;
  const lim = Math.min(100, Math.max(1, parseInt(size, 10) || 20));
  const off = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;
  const data = rows(await db.exec(
    `SELECT t.id AS task_id, t.category, t.priority, t.result_text, t.completed_at, t.project_code,
            a.label, a.tags, a.note, a.expected, a.annotator_name, a.updated_at AS annotated_at,
            f.resolved AS feedback_resolved, r.score_total
       ${from}
      ORDER BY (a.id IS NULL) DESC, t.completed_at DESC NULLS LAST
      LIMIT ? OFFSET ?`, [...params, lim, off]));
  return { data, total, page: Math.max(1, parseInt(page, 10) || 1), size: lim };
}

/** 标注统计（覆盖率为治理关注点：答复是否真的被沉淀成数据资产） */
async function stats({ tenantId }) {
  const db = getDb();
  const completed = parseInt(rows(await db.exec(
    `SELECT COUNT(*) AS c FROM tasks WHERE tenant_id = ? AND status = 'completed'`, [tenantId || null]))[0].c, 10) || 0;
  const agg = rows(await db.exec(
    `SELECT COUNT(*) AS annotated,
            COUNT(*) FILTER (WHERE label = 'good') AS good,
            COUNT(*) FILTER (WHERE label = 'partial') AS partial,
            COUNT(*) FILTER (WHERE label = 'bad') AS bad,
            COUNT(*) FILTER (WHERE expected IS NOT NULL AND expected <> '') AS with_expected
       FROM task_annotations WHERE tenant_id = ?`, [tenantId || null]))[0] || {};
  const byCategory = rows(await db.exec(
    `SELECT t.category, COUNT(*) AS total,
            COUNT(*) FILTER (WHERE a.label = 'good') AS good,
            COUNT(*) FILTER (WHERE a.label = 'bad') AS bad
       FROM task_annotations a JOIN tasks t ON a.task_id = t.id
      WHERE a.tenant_id = ?
      GROUP BY t.category ORDER BY t.category`, [tenantId || null]));
  const tagRows = rows(await db.exec(
    `SELECT tags FROM task_annotations WHERE tenant_id = ? AND tags IS NOT NULL AND tags <> ''`,
    [tenantId || null]));
  const tagCount = new Map();
  for (const r of tagRows) {
    for (const tg of normTags(r.tags)) tagCount.set(tg, (tagCount.get(tg) || 0) + 1);
  }
  const annotated = parseInt(agg.annotated, 10) || 0;
  const sets = parseInt(rows(await db.exec(
    'SELECT COUNT(*) AS c FROM eval_sets WHERE tenant_id = ?', [tenantId || null]))[0].c, 10) || 0;
  return {
    completed,
    annotated,
    coverage: completed > 0 ? Math.round((annotated / completed) * 1000) / 10 : null,
    good: parseInt(agg.good, 10) || 0,
    partial: parseInt(agg.partial, 10) || 0,
    bad: parseInt(agg.bad, 10) || 0,
    with_expected: parseInt(agg.with_expected, 10) || 0,
    eval_sets: sets,
    by_category: byCategory.map(r => ({
      category: r.category,
      total: parseInt(r.total, 10) || 0,
      good: parseInt(r.good, 10) || 0,
      bad: parseInt(r.bad, 10) || 0,
    })),
    top_tags: Array.from(tagCount.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count })),
  };
}

/** 版本号：v20261030-1530（同分钟内重复生成时自动追加序号） */
async function nextVersion(tenantId, now) {
  const d = now || new Date();
  const p = n => String(n).padStart(2, '0');
  const base = `v${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  let v = base;
  for (let i = 2; i < 100; i++) {
    const dup = rows(await getDb().exec(
      'SELECT id FROM eval_sets WHERE tenant_id = ? AND version = ?', [tenantId || null, v]))[0];
    if (!dup) return v;
    v = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * 生成私有评测集（不可变快照）
 * @param {object} o
 * @param {'general'|'confidential'|'ops'|null} o.category  null = 全部（仅 admin 可用）
 */
async function createEvalSet({ tenantId, actor, name, category, labels }) {
  const db = getDb();
  const cat = category && ['general', 'confidential', 'ops'].includes(category) ? category : null;
  const picked = Array.isArray(labels) && labels.length
    ? labels.map(labelText).filter(l => LABELS.includes(l))
    : LABELS.slice();
  if (!picked.length) return { ok: false, message: '标签筛选非法' };

  const params = [tenantId || null];
  let where = 'a.tenant_id = ?';
  if (cat) { where += ' AND t.category = ?'; params.push(cat); }
  where += ` AND a.label IN (${picked.map(() => '?').join(', ')})`;
  params.push(...picked);

  const anns = rows(await db.exec(
    `SELECT a.task_id, a.label, a.tags, a.expected, t.category, t.request_payload, t.result_text
       FROM task_annotations a JOIN tasks t ON a.task_id = t.id
      WHERE ${where}
      ORDER BY a.id`, params));
  if (!anns.length) return { ok: false, message: '没有符合筛选条件的标注，无法生成评测集' };

  const items = [];
  for (const a of anns) {
    const prompt = promptOf(a);
    if (!prompt) continue; // 无提示词就没有训练/评测价值
    const completion = a.result_text || null;
    const target = a.expected || (a.label === 'good' ? completion : null);
    items.push({ task_id: a.task_id, category: a.category, label: a.label, tags: a.tags || null, prompt, completion, target });
  }
  if (!items.length) return { ok: false, message: '标注任务的提示词为空，无法生成评测集' };

  const version = await nextVersion(tenantId);
  const stat = { good: 0, partial: 0, bad: 0, with_target: 0 };
  for (const it of items) {
    stat[it.label] = (stat[it.label] || 0) + 1;
    if (it.target) stat.with_target += 1;
  }
  const nm = (actor && (actor.name || actor.username)) || '系统';
  const { lastId: setId } = await db.run(
    `INSERT INTO eval_sets (version, name, category, item_count, stats, tenant_id, created_by)
     VALUES (?, ?, ?, ?, ?::jsonb, ?, ?)`,
    [version, clampText(name, 128) || `${version} 评测集`, cat, items.length,
      JSON.stringify(stat), tenantId || null, actor ? actor.id : null]);
  for (const it of items) {
    await db.run(
      `INSERT INTO eval_set_items (set_id, task_id, category, label, tags, prompt, completion, target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [setId, it.task_id, it.category, it.label, it.tags, it.prompt, it.completion, it.target]);
  }
  return { ok: true, set: await getEvalSet({ id: setId, tenantId, withItems: false }), created_by: nm };
}

async function listEvalSets({ tenantId, limit = 50 }) {
  return rows(await getDb().exec(
    `SELECT s.*, u.name AS creator_name
       FROM eval_sets s LEFT JOIN users u ON s.created_by = u.id
      WHERE s.tenant_id = ?
      ORDER BY s.id DESC LIMIT ?`,
    [tenantId || null, Math.min(200, Math.max(1, parseInt(limit, 10) || 50))]));
}

async function getEvalSet({ id, tenantId, withItems = true }) {
  const db = getDb();
  const set = rows(await db.exec(
    'SELECT * FROM eval_sets WHERE id = ? AND tenant_id = ?', [id, tenantId || null]))[0];
  if (!set) return null;
  if (!withItems) return set;
  const items = rows(await db.exec(
    'SELECT * FROM eval_set_items WHERE set_id = ? ORDER BY id', [id]));
  return { ...set, items };
}

/** SFT 训练样本：good → 原答复；partial/bad → 人工给出的期望答复 */
function buildSftLine(item) {
  return JSON.stringify({
    messages: [
      { role: 'user', content: item.prompt },
      { role: 'assistant', content: item.target },
    ],
    metadata: {
      task_id: item.task_id, category: item.category, label: item.label,
      tags: item.tags || null,
    },
  });
}

/** 评测样本：保留金标标签与参考答复，供离线打分使用 */
function buildEvalLine(item) {
  return JSON.stringify({
    input: item.prompt,
    expected_output: item.target || null,
    actual_output: item.completion || null,
    label: item.label,
    tags: item.tags || null,
    metadata: { task_id: item.task_id, category: item.category },
  });
}

/**
 * 导出评测集
 * @param {'sft'|'eval'} format  sft 仅含有参考答复的样本；eval 全量
 */
async function exportLines({ id, tenantId, format = 'sft' }) {
  const set = await getEvalSet({ id, tenantId });
  if (!set) return { ok: false, message: '评测集不存在' };
  const fmt = format === 'eval' ? 'eval' : 'sft';
  const picked = fmt === 'sft' ? set.items.filter(i => i.target) : set.items;
  const lines = picked.map(fmt === 'sft' ? buildSftLine : buildEvalLine);
  return {
    ok: true, format: fmt, set,
    lines,
    skipped: set.items.length - picked.length,
  };
}

module.exports = {
  LABELS, MAX_TEXT, normTags, promptOf,
  getTask, getByTask, annotate, listCandidates, stats,
  nextVersion, createEvalSet, listEvalSets, getEvalSet, exportLines,
  buildSftLine, buildEvalLine,
};
