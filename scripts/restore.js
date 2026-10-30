/**
 * PostgreSQL 备份恢复脚本（跨平台，零新增依赖）
 *
 * 用法：
 *   node scripts/restore.js <backup.sql.gz>            # 恢复到 PG_DATABASE
 *   node scripts/restore.js <backup.sql.gz> --dry-run  # 只校验文件，不恢复
 *   node scripts/restore.js <backup.sql.gz> --yes      # 跳过交互确认
 *   node scripts/restore.js <backup.sql.gz> --no-safety-backup  # 跳过恢复前自动备份（不推荐）
 *
 * 安全护栏：
 *   1. 非 --yes 时必须手输 RESTORE 才继续
 *   2. 恢复前强制自动备份当前库，并打印备份路径（失败即中止）
 *   3. 校验 gzip 可解且含 "PostgreSQL database dump"
 *   4. psql 使用 --single-transaction + ON_ERROR_STOP=1，失败整体回滚
 *
 * 密码只通过 PGPASSWORD 环境变量传递，不上命令行。
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const backup = require('./backup');

// ===== 工具 =====

function log(...args) { console.log('[恢复]', ...args); }
function warn(...args) { console.warn('[恢复]', ...args); }
function error(...args) { console.error('[恢复]', ...args); }

/** 用 psql 执行单条 SQL，返回去空白字符串（失败返回 null） */
function psqlQuery(psqlCmd, cfg, dbName, sql) {
  const args = [
    '--host', cfg.host,
    '--port', cfg.port,
    '--username', cfg.user,
    '--dbname', dbName,
    '-tAc', sql,
  ];
  const r = spawnSync(psqlCmd, args, { encoding: 'utf8', env: backup.pgEnv(cfg), timeout: 60000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim();
}

/** 构造 psql 子进程环境（含 PGPASSWORD） */
function buildEnv(cfg) {
  return backup.pgEnv(cfg);
}

/** 读取用户表清单 + 每表行数（用于恢复前后比对） */
function collectTableStats(psqlCmd, cfg, dbName) {
  const sql = `SELECT c.relname, (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM ' || quote_ident(c.relname), false, true, '')))[1]::text::bigint AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`;
  const out = psqlQuery(psqlCmd, cfg, dbName, sql);
  if (out == null) return null;
  const rows = {};
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, n] = line.split('|');
    if (!name) continue;
    rows[name] = Number(n) || 0;
  }
  return rows;
}

/** 询问用户确认（非 TTY 时直接拒绝，避免 CI 挂起） */
function askConfirm(question, expected) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      warn('非交互终端，无法确认。请显式加 --yes。');
      return resolve(false);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim() === expected);
    });
  });
}

/** 解析命令行参数 */
function parseArgs(argv) {
  const opts = { file: null, dryRun: false, yes: false, safetyBackup: true, help: false };
  const args = argv.slice(2);
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--no-safety-backup') opts.safetyBackup = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-') && !opts.file) opts.file = path.resolve(process.cwd(), a);
  }
  return opts;
}

const HELP = `用法: node scripts/restore.js <backup.sql.gz> [选项]

  --dry-run               只校验备份文件，不恢复
  --yes, -y               跳过交互确认（危险，仅用于自动化演练）
  --no-safety-backup      跳过恢复前的自动备份（不推荐）
  -h, --help              显示帮助

环境变量（.env）：PG_HOST / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD / PG_BIN
`;

/**
 * 恢复主流程
 * @param {object} opts { file, dryRun, yes, safetyBackup }
 * @returns {Promise<{ok:boolean, code:number, error?:string, safetyBackup?:string}>}
 */
async function runRestore(opts = {}) {
  const cfg = backup.pgConfig();
  const psqlTool = backup.resolvePgTool('psql');
  const env = buildEnv(cfg);

  // ===== 1. 文件校验 =====
  if (!opts.file) return { ok: false, code: 2, error: '必须指定备份文件路径' };
  log(`备份文件：${opts.file}`);
  if (!fs.existsSync(opts.file)) {
    error(`文件不存在：${opts.file}`);
    return { ok: false, code: 1, error: '文件不存在' };
  }
  const verify = await backup.verifyGzipFile(opts.file);
  if (!verify.ok) {
    error(`校验失败：${verify.reason}`);
    return { ok: false, code: 1, error: verify.reason };
  }
  const stat = fs.statSync(opts.file);
  log(`校验通过：${(stat.size / 1024).toFixed(1)} KB，gzip 与 pg_dump 标识均正常`);

  // ===== 2. 目标库与工具检查 =====
  log(`目标：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}（psql: ${psqlTool.cmd}）`);
  if (psqlTool.source === '未找到，回退 PATH') {
    warn(`未探测到 psql 安装路径，尝试直接执行 ${psqlTool.cmd}；如失败请设置 PG_BIN`);
  }
  const psqlVer = backup.parseToolVersion(psqlTool.cmd);
  if (!psqlVer) {
    error(`无法执行 psql（${psqlTool.cmd}）。请安装 PostgreSQL 客户端或用 PG_BIN 指定 bin 目录。`);
    return { ok: false, code: 1, error: 'psql 不可用' };
  }
  log(`psql 版本：${psqlVer.raw}`);

  const ping = psqlQuery(psqlTool.cmd, cfg, cfg.database, 'SELECT 1');
  if (ping !== '1') {
    error('无法连接目标数据库（psql 执行 SELECT 1 失败），请检查 PG_* 配置与服务状态。');
    return { ok: false, code: 1, error: '数据库连接失败' };
  }

  const before = collectTableStats(psqlTool.cmd, cfg, cfg.database);
  if (before) {
    const total = Object.values(before).reduce((a, b) => a + b, 0);
    log(`恢复前：${Object.keys(before).length} 张表，共 ${total} 行`);
  }

  if (opts.dryRun) {
    log('[dry-run] 校验完成，未执行恢复。');
    return { ok: true, code: 0 };
  }

  // ===== 3. 交互确认 =====
  if (!opts.yes) {
    warn('警告：恢复会覆盖目标库现有数据！');
    const ok = await askConfirm('请输入 RESTORE 确认继续：', 'RESTORE');
    if (!ok) {
      log('已取消。');
      return { ok: false, code: 1, error: '用户取消' };
    }
  }

  // ===== 4. 恢复前自动备份（强制） =====
  let safetyBackupPath = null;
  if (opts.safetyBackup) {
    log('恢复前自动备份当前库…');
    const result = await backup.runBackup({ quiet: false });
    if (!result.ok || !result.file) {
      error(`恢复前自动备份失败：${result.error || '未知原因'}。已中止恢复。`);
      return { ok: false, code: 1, error: '恢复前自动备份失败' };
    }
    safetyBackupPath = result.file;
    log(`当前库已备份到：${safetyBackupPath}`);
    log('如需回滚，执行：node scripts/restore.js ' + safetyBackupPath);
  } else {
    warn('已跳过恢复前自动备份（--no-safety-backup）。');
  }

  // ===== 5. 执行 psql 恢复 =====
  log('开始恢复（--single-transaction + ON_ERROR_STOP=1）…');
  const started = Date.now();
  const args = [
    '--host', cfg.host,
    '--port', cfg.port,
    '--username', cfg.user,
    '--dbname', cfg.database,
    '--single-transaction',
    '--set', 'ON_ERROR_STOP=1',
    '--quiet',
  ];

  const code = await new Promise((resolve) => {
    const child = spawn(psqlTool.cmd, args, { env, windowsHide: true, shell: false });
    const gunzip = zlib.createGunzip();
    const rs = fs.createReadStream(opts.file);
    let stderrText = '';

    let settled = false;
    const done = (c) => { if (!settled) { settled = true; resolve(c); } };

    child.stderr.on('data', (buf) => {
      stderrText += buf.toString('utf8');
      if (stderrText.length > 12000) stderrText = stderrText.slice(-12000);
    });
    child.stdout.on('data', () => { /* 丢弃，避免大包占内存 */ });

    child.on('error', (err) => {
      error(`psql 启动失败：${err.message}`);
      try { rs.destroy(); } catch (e) { /* 忽略 */ }
      done(-1);
    });
    child.on('close', (c) => {
      if (c !== 0 && stderrText) error(`psql 输出：${stderrText.trim()}`);
      done(c);
    });

    rs.on('error', (err) => {
      error(`读取备份文件失败：${err.message}`);
      try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      done(-1);
    });
    gunzip.on('error', (err) => {
      error(`gzip 解压失败：${err.message}`);
      try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      done(-1);
    });

    rs.pipe(gunzip).pipe(child.stdin);
    child.stdin.on('error', () => { /* psql 提前退出时忽略 EPIPE */ });
  });

  if (code !== 0) {
    error(`恢复失败（psql 退出码 ${code}）。事务已回滚，数据库保持恢复前状态。`);
    if (safetyBackupPath) log(`可用备份：${safetyBackupPath}`);
    return { ok: false, code: 1, error: `psql 退出码 ${code}`, safetyBackup: safetyBackupPath };
  }

  log(`恢复完成，耗时 ${Date.now() - started}ms`);

  // ===== 6. 恢复后校验 =====
  const after = collectTableStats(psqlTool.cmd, cfg, cfg.database);
  if (after) {
    const total = Object.values(after).reduce((a, b) => a + b, 0);
    log(`恢复后：${Object.keys(after).length} 张表，共 ${total} 行`);
    const users = after.users != null ? after.users : '?';
    const tasks = after.tasks != null ? after.tasks : '?';
    log(`关键表：users=${users} 行，tasks=${tasks} 行`);
    if (before) {
      const missing = Object.keys(before).filter((k) => !(k in after));
      if (missing.length) warn(`备份中缺少以下表（恢复前存在）：${missing.join(', ')}`);
    }
  } else {
    warn('恢复后统计查询失败（可能权限不足），请手工核对。');
  }

  return { ok: true, code: 0, safetyBackup: safetyBackupPath };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.file) { console.log(HELP); return 2; }
  const result = await runRestore(opts);
  return result.code;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error('[恢复] 未捕获异常：', e);
    process.exit(1);
  });
}

module.exports = {
  runRestore,
  parseArgs,
  buildEnv,
  collectTableStats,
  psqlQuery,
  askConfirm,
};
