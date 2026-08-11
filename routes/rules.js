/**
 * 分级规则管理（治理配置后台，admin）
 * 让「分级是人的边界」可配置：管理员可视化维护 task_rules，无需改代码
 *  - GET    /api/rules        规则列表（priority 升序）
 *  - POST   /api/rules        新建规则
 *  - PUT    /api/rules/:id    更新规则
 *  - DELETE /api/rules/:id    删除规则
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { CATEGORIES } = require('../services/categoryEngine');

const admin = [authenticate, requireRole('admin')];

function rows(result) {
  if (!result || !result.length) return [];
  return result[0].values.map(row => {
    const o = {};
    result[0].columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

// 列表
router.get('/', admin, async (req, res) => {
  try {
    const list = rows(await getDb().exec('SELECT * FROM task_rules ORDER BY priority ASC, id ASC', []));
    res.json({ success: true, data: list });
  } catch (e) {
    console.error('[规则列表失败]', e.message);
    res.status(500).json({ success: false, message: '获取规则失败' });
  }
});

// 新建
router.post('/', admin, async (req, res) => {
  try {
    const { name, category, match_field, keywords, priority, enabled } = req.body || {};
    if (!name || !keywords) return res.status(400).json({ success: false, message: 'name 与 keywords 必填' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ success: false, message: 'category 非法' });
    const { lastId } = await getDb().run(
      'INSERT INTO task_rules (name, category, match_field, keywords, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      [name, category, match_field || 'content', keywords, parseInt(priority) || 100, enabled !== false]);
    res.json({ success: true, data: { id: lastId } });
  } catch (e) {
    console.error('[新建规则失败]', e.message);
    res.status(500).json({ success: false, message: '新建规则失败' });
  }
});

// 更新
router.put('/:id', admin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, category, match_field, keywords, priority, enabled } = req.body || {};
    const sets = [];
    const params = [];
    for (const [k, v] of [['name', name], ['category', category], ['match_field', match_field], ['keywords', keywords], ['priority', priority], ['enabled', enabled]]) {
      if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
    }
    if (!sets.length) return res.status(400).json({ success: false, message: '无更新字段' });
    if (category !== undefined && !CATEGORIES.includes(category)) return res.status(400).json({ success: false, message: 'category 非法' });
    params.push(id);
    await getDb().run(`UPDATE task_rules SET ${sets.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (e) {
    console.error('[更新规则失败]', e.message);
    res.status(500).json({ success: false, message: '更新规则失败' });
  }
});

// 删除
router.delete('/:id', admin, async (req, res) => {
  try {
    await getDb().run('DELETE FROM task_rules WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (e) {
    console.error('[删除规则失败]', e.message);
    res.status(500).json({ success: false, message: '删除规则失败' });
  }
});

module.exports = router;
