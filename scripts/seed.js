/**
 * 种子数据脚本
 * 初始化管理员与工程师账户
 * 运行：npm run seed 或 node scripts/seed.js
 */
require('dotenv').config();
const bcryptjs = require('bcryptjs');
const { initDatabase, getDb } = require('../db');

async function seed() {
  await initDatabase();
  const db = getDb();

  const accounts = [
    { username: 'admin', password: 'admin123', role: 'admin', name: '管理员' },
    { username: 'engineer1', password: 'admin123', role: 'engineer', name: '工程师-张' },
    { username: 'engineer2', password: 'admin123', role: 'engineer', name: '工程师-李' },
  ];

  for (const acc of accounts) {
    const exists = await db.exec('SELECT id FROM users WHERE username = ?', [acc.username]);
    if (exists.length > 0 && exists[0].values.length > 0) {
      console.log(`[种子] 用户 ${acc.username} 已存在，跳过`);
      continue;
    }
    const hash = bcryptjs.hashSync(acc.password, 10);
    await db.run(
      'INSERT INTO users (username, password, role, name, is_active) VALUES (?, ?, ?, ?, true)',
      [acc.username, hash, acc.role, acc.name]
    );
    console.log(`[种子] 已创建用户: ${acc.username} / ${acc.password} (${acc.role})`);
  }

  console.log('[种子] 数据初始化完成！');
  process.exit(0);
}

seed().catch(err => {
  console.error('[种子] 初始化失败:', err);
  process.exit(1);
});
