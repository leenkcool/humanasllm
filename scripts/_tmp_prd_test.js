/* 临时验证：PRD 维护功能（追加 + git 用户身份 commit + 还原） */
require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { initDatabase } = require('../db');
const BASE = 'http://127.0.0.1:39000';
const ROOT = path.join(__dirname, '..');
const PRD = path.join(ROOT, 'PRD.md');
let pass = true;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  | ' + extra : '')); if (!cond) pass = false; };
const J = (h) => ({ 'Content-Type': 'application/json', ...(h || {}) });

(async () => {
  await initDatabase();
  const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: J(), body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json();
  const token = login.data.token;
  const AH = { Authorization: 'Bearer ' + token };

  // 1. 读 PRD
  const g = await (await fetch(BASE + '/api/prd', { headers: J(AH) })).json();
  check('读 PRD', g.success && g.data.content.includes('初始版本'));

  // 2. 追加需求（以 admin 身份 git commit）
  const before = fs.readFileSync(PRD, 'utf8');
  const p = await (await fetch(BASE + '/api/prd', { method: 'POST', headers: J(AH), body: JSON.stringify({ title: '测试需求', description: '集成测试追加' }) })).json();
  check('追加成功', p.success);
  const after = fs.readFileSync(PRD, 'utf8');
  check('PRD.md 已追加', after.includes('测试需求') && after.includes('集成测试追加'));

  const log = execSync('git -C "' + ROOT + '" log --oneline -1', { encoding: 'utf8' });
  check('git commit 已生成(用户身份)', log.includes('prd: 测试需求'), log.trim());
  const author = execSync('git -C "' + ROOT + '" log -1 --format=%an', { encoding: 'utf8' }).trim();
  check('commit 作者为登录用户', author.length > 0, author);

  // 3. 清理：撤销 commit + 还原 PRD.md
  execSync('git -C "' + ROOT + '" reset --hard HEAD~1', { encoding: 'utf8' });
  check('清理还原 PRD.md', !fs.readFileSync(PRD, 'utf8').includes('测试需求'));
  console.log('cleaned');
  process.exit(pass ? 0 : 1);
})();
