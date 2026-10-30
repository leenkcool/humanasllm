/**
 * 备份/恢复脚本纯函数单元测试
 * 覆盖：备份名解析、保留策略、gzip 校验、require 不自动执行
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const backup = require('../../scripts/backup');

test('parseBackupName 解析合法文件名', () => {
  const r = backup.parseBackupName('p390-20261030-153012.sql.gz');
  assert.ok(r);
  assert.strictEqual(r.key, '20261030-153012');
  assert.strictEqual(r.ext, 'sql.gz');
  assert.strictEqual(r.date.getFullYear(), 2026);
  assert.strictEqual(r.date.getMonth(), 9); // 0-based：10 月
  assert.strictEqual(r.date.getDate(), 30);
});

test('parseBackupName 支持 .files 目录名', () => {
  const r = backup.parseBackupName('p390-20261030-153012.files');
  assert.ok(r);
  assert.strictEqual(r.ext, 'files');
  assert.strictEqual(r.key, '20261030-153012');
});

test('parseBackupName 拒绝非法文件名', () => {
  assert.strictEqual(backup.parseBackupName('foo.sql.gz'), null);
  assert.strictEqual(backup.parseBackupName('p390-2026-10-30.sql.gz'), null);
  assert.strictEqual(backup.parseBackupName('p390-20261030-153012.sql'), null);
  assert.strictEqual(backup.parseBackupName(''), null);
  assert.strictEqual(backup.parseBackupName(null), null);
});

test('selectExpired：20 份保留 14 → 删 6 份且删的是最旧的', () => {
  const names = [];
  for (let i = 1; i <= 20; i += 1) {
    const d = String(i).padStart(2, '0');
    names.push(`p390-202610${d}-000000.sql.gz`);
  }
  const expired = backup.selectExpired(names, 14);
  assert.strictEqual(expired.length, 6);
  assert.deepStrictEqual(expired, names.slice(0, 6));
});

test('selectExpired：份数不足时不删', () => {
  assert.deepStrictEqual(backup.selectExpired(['p390-20261030-120000.sql.gz'], 14), []);
  assert.deepStrictEqual(backup.selectExpired([], 14), []);
});

test('selectExpired：同一时间戳的 .sql.gz 与 .files 视为两份，均参与淘汰', () => {
  const names = [];
  for (let i = 1; i <= 15; i += 1) {
    const d = String(i).padStart(2, '0');
    names.push(`p390-202610${d}-000000.sql.gz`);
    names.push(`p390-202610${d}-000000.files`);
  }
  const expired = backup.selectExpired(names, 14);
  // 共 30 项，保留 14，删 16（最早 8 天的两份）
  assert.strictEqual(expired.length, 16);
  assert.ok(expired.every((n) => /2026100[1-8]/.test(n)));
});

test('selectExpired：非法名字被忽略', () => {
  const names = ['readme.txt', 'p390-20261030-120000.sql.gz', 'manifest.jsonl'];
  assert.deepStrictEqual(backup.selectExpired(names, 1), []);
});

test('timestampNow 输出 YYYYMMDD-HHmmss', () => {
  assert.strictEqual(backup.timestampNow(new Date(2026, 9, 30, 5, 6, 7)), '20261030-050607');
});

test('verifyGzipFile 对非法文件返回 false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p390-backup-test-'));
  try {
    // 够大但不是 gzip（先通过大小检查，再被魔数拦截）
    const bad = path.join(dir, 'bad.sql.gz');
    fs.writeFileSync(bad, 'not a gzip file at all\n'.repeat(100));
    const r1 = await backup.verifyGzipFile(bad);
    assert.strictEqual(r1.ok, false);
    assert.match(r1.reason, /不是 gzip/);

    const missing = await backup.verifyGzipFile(path.join(dir, 'nope.sql.gz'));
    assert.strictEqual(missing.ok, false);

    // 太小（< 1KB）也应被拒绝
    const tiny = path.join(dir, 'tiny.sql.gz');
    fs.writeFileSync(tiny, zlib.gzipSync('-- PostgreSQL database dump'));
    const r2 = await backup.verifyGzipFile(tiny);
    assert.strictEqual(r2.ok, false);
    assert.match(r2.reason, /过小/);

    // 可解压但不是 pg_dump 产物（用随机数据保证压缩后 > 1KB）
    const notDump = path.join(dir, 'other.sql.gz');
    fs.writeFileSync(notDump, zlib.gzipSync(Buffer.concat([Buffer.from('hello world\n'), require('crypto').randomBytes(4096)])));
    const r3 = await backup.verifyGzipFile(notDump);
    assert.strictEqual(r3.ok, false);
    assert.match(r3.reason, /PostgreSQL database dump/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyGzipFile 对合法 pg_dump 压缩包返回 true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p390-backup-test-'));
  try {
    const good = path.join(dir, 'good.sql.gz');
    // 随机数据防空压缩：确保压缩后体积 > 1KB
    const body = Buffer.concat([
      Buffer.from('--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\n'),
      require('crypto').randomBytes(8192),
    ]);
    fs.writeFileSync(good, zlib.gzipSync(body));
    const r = await backup.verifyGzipFile(good);
    assert.strictEqual(r.ok, true, r.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pgConfig 从环境变量读取 PG_* 配置', () => {
  const cfg = backup.pgConfig();
  assert.strictEqual(cfg.host, process.env.PG_HOST || 'localhost');
  assert.strictEqual(String(cfg.port), String(process.env.PG_PORT || '5432'));
  assert.strictEqual(typeof cfg.password, 'string');
});

test('pgEnv 注入 PGPASSWORD 且不改动 process.env', () => {
  const prev = process.env.PGPASSWORD;
  const env = backup.pgEnv({ password: 'secret' });
  assert.strictEqual(env.PGPASSWORD, 'secret');
  assert.strictEqual(process.env.PGPASSWORD, prev);
});

test('restore / drill 脚本可被 require 而不自动执行', () => {
  assert.strictEqual(typeof backup.runBackup, 'function');
  const restore = require('../../scripts/restore');
  assert.strictEqual(typeof restore.runRestore, 'function');
  assert.strictEqual(typeof restore.parseArgs, 'function');
  const drill = require('../../scripts/drill-restore');
  assert.strictEqual(typeof drill.runDrill, 'function');
  assert.match(drill.drillDbName('20261030-153012'), /^p390_drill_20261030153012$/);
});

test('restore.parseArgs 解析参数', () => {
  const restore = require('../../scripts/restore');
  const opts = restore.parseArgs(['node', 'restore.js', 'backup.sql.gz', '--dry-run', '--yes']);
  assert.strictEqual(opts.dryRun, true);
  assert.strictEqual(opts.yes, true);
  assert.ok(opts.file.endsWith('backup.sql.gz'));
});
