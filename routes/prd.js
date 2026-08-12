/**
 * PRD 需求沉淀路由
 *  - GET  /api/prd            读取 PRD.md（需求记录全文）
 *  - POST /api/prd            追加验证过的需求（以当前登录用户身份 git 本地 commit）
 * 二次开发（AI Agent 或人）完成并验证后，通过此接口把需求沉淀进 PRD.md。
 * 注：按项目 Git 规则仅本地提交，绝不 git push（见 CLAUDE.md）。
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { authenticate } = require('../middleware/auth');

const ROOT = path.join(__dirname, '..');
const PRD_FILE = path.join(ROOT, 'PRD.md');

function safeArg(s) { return String(s == null ? '' : s).replace(/["'`$]/g, '').trim(); }

// 读取 PRD.md
router.get('/', authenticate, (req, res) => {
  const content = fs.existsSync(PRD_FILE) ? fs.readFileSync(PRD_FILE, 'utf8') : '';
  res.json({ success: true, data: { content } });
});

// 追加需求（git 账号身份 = 当前登录用户）
router.post('/', authenticate, (req, res) => {
  try {
    const title = safeArg(req.body && req.body.title);
    const description = String((req.body && req.body.description) || '').trim();
    if (!title || !description) return res.status(400).json({ success: false, message: '标题与描述必填' });

    const today = new Date().toISOString().slice(0, 10);
    const entry = `\n## ${today} - ${title}\n- 描述：${description}\n`;
    fs.appendFileSync(PRD_FILE, entry, 'utf8');

    // 以当前登录用户身份 git 本地提交（author 用 username + email；仅本地，不 push）
    const name = safeArg(req.user.name || req.user.username);
    const email = safeArg(req.user.email || req.user.username + '@local');
    const msg = safeArg('prd: ' + title);
    execSync(`git -c user.name="${name}" -c user.email="${email}" add PRD.md`, { cwd: ROOT });
    execSync(`git -c user.name="${name}" -c user.email="${email}" commit -m "${msg}"`, { cwd: ROOT });

    res.json({ success: true, data: { appended: true, entry } });
  } catch (e) {
    console.error('[PRD 追加失败]', e.message);
    res.status(500).json({ success: false, message: 'PRD 追加失败: ' + e.message });
  }
});

module.exports = router;
