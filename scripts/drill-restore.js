/**
 * 备份恢复演练脚本（可用于 CI）
 *
 * 用法：
 *   node scripts/drill-restore.js             # 备份 → 恢复到临时库 → 比对 → 删临时库
 *   node scripts/drill-restore.js --keep-backup  # 保留本次演练产生的备份文件
 *
 * 流程：
 *   1. 调用 backup.runBackup() 产生一份真实备份
 *   2. createdb 临时库 p390_drill_<ts>
 *   3. psql --single-transaction 把备份灌入临时库
 *   4. 对比源库与临时库的「表数量 + 每表行数」
 *   5. finally 一定 dropdb 清理临时库
 *
 * 输出：{ backup_file, backup_bytes, tables, rows_before, rows_after, match, duration_ms }
 * 退出码：全部一致 0，任一不一致/出错 1
 *
 * 依赖：pg_dump / psql / createdb / dropdb（PostgreSQL 自带；Windows 常不在 PATH，脚本会自动探测安装目录）
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const backup = require('./backup');
const restore = require('./restore');

const ROOT = path.resolve(__dirname, '..');
// 演练产物单独放子目录：走真实的备份/校验代码路径，但不污染正式备份的 manifest.jsonl
const DRILL_BACKUP_DIR = path.join(ROOT, 'data', 'backups', 'drill');

function log(...args) { console.log('[演练]', ...args); }
function warn(...args) { console.warn('[演练]', ...args); }
function error(...args) { console.error('[演练]', ...args); }

/** 生成临时库名（PG 标识符限 63 字节；用下划线避免带连字符时到处要加引号） */
function drillDbName(platformTs) {
  return `p390_drill_${String(platformTs || '').replace(/[^0-9A-Za-z_]/g, '')}`;
}

/** 执行外部命令（spawn，无 shell），返回退出码 */
function runCmd(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, windowsHide: true, shell: false });
    let stderrText = '';
    child.stderr.on('data', (b) => { stderrText += b.toString('utf8'); });
    child.stdout.on('data', () => { /* 丢弃 */ });
    child.on('error', (e) => resolve({ code: -1, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stderr: stderrText }));
  });
}

/** 把 gz 备份灌入目标库 */
function pipeGzIntoPsql(psqlCmd, cfg, dbName, file) {
  return new Promise((resolve) => {
    const env = backup.pgEnv(cfg);
    const child = spawn(psqlCmd, [
      '--host', cfg.host,
      '--port', cfg.port,
      '--username', cfg.user,
      '--dbname', dbName,
      '--single-transaction',
      '--set', 'ON_ERROR_STOP=1',
      '--quiet',
    ], { env, windowsHide: true, shell: false });

    const rs = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();
    let stderrText = '';
    let settled = false;
    const done = (code) => { if (!settled) { settled = true; resolve({ code, stderr: stderrText }); } };

    child.stderr.on('data', (b) => { stderrText += b.toString('utf8'); if (stderrText.length > 8000) stderrText = stderrText.slice(-8000); });
    child.stdout.on('data', () => { /* 丢弃 */ });
    child.on('error', (e) => { stderrText += e.message; done(-1); });
    child.on('close', (code) => done(code));
    rs.on('error', (e) => { stderrText += `读取失败: ${e.message}`; try { child.kill('SIGKILL'); } catch (err) { /* 忽略 */ } done(-1); });
    gunzip.on('error', (e) => { stderrText += `解压失败: ${e.message}`; try { child.kill('SIGKILL'); } catch (err) { /* 忽略 */ } done(-1); });

    rs.pipe(gunzip).pipe(child.stdin);
    child.stdin.on('error', () => { /* psql 提前退出时的 EPIPE */ });
  });
}

/**
 * 执行一次演练
 * @param {object} options { keepBackup }
 * @returns {Promise<{ok:boolean, report:object}>}
 */
async function runDrill(options = {}) {
  const started = Date.now();
  const cfg = backup.pgConfig();
  const ts = backup.timestampNow();

  const pgDump = backup.resolvePgTool('pg_dump');
  const psqlTool = backup.resolvePgTool('psql');
  const createdbTool = backup.resolvePgTool('createdb');
  const dropdbTool = backup.resolvePgTool('dropdb');

  // 工具齐全性预检（缺失直接失败，别等备份完才发现）
  for (const [name, tool] of [['pg_dump', pgDump], ['psql', psqlTool], ['createdb', createdbTool], ['dropdb', dropdbTool]]) {
    const ver = backup.parseToolVersion(tool.cmd);
    if (!ver) {
      const msg = `未找到可执行的 ${name}（尝试路径：${tool.cmd}）。Windows 上 PostgreSQL 的 bin 目录通常不在 PATH，请设置 PG_BIN，例如 "D:\\Program Files\\PostgreSQL\\18\\bin"。`;
      error(msg);
      return { ok: false, report: { error: msg, duration_ms: Date.now() - started } };
    }
  }

  // 版本一致性提醒（演练比生产更怕版本错配）
  const dumpVer = backup.parseToolVersion(pgDump.cmd);
  const psqlVer = backup.parseToolVersion(psqlTool.cmd);
  if (dumpVer && psqlVer && dumpVer.major !== psqlVer.major) {
    warn(`pg_dump v${dumpVer.major} 与 psql v${psqlVer.major} 主版本不一致，建议统一。`);
  }

  // ===== 1. 源库当前状态 =====
  const rowsBefore = restore.collectTableStats(psqlTool.cmd, cfg, cfg.database);
  if (!rowsBefore) {
    const msg = `无法读取源库 ${cfg.database} 的表统计，演练中止。`;
    error(msg);
    return { ok: false, report: { error: msg, duration_ms: Date.now() - started } };
  }
  const tablesBefore = Object.keys(rowsBefore).length;
  log(`源库 ${cfg.database}：${tablesBefore} 张表`);

  // ===== 2. 备份 =====
  log('生成备份…');
  const backupResult = await backup.runBackup({ quiet: true, outDir: DRILL_BACKUP_DIR });
  if (!backupResult.ok) {
    error(`备份失败：${backupResult.error}`);
    return { ok: false, report: { error: `备份失败：${backupResult.error}`, duration_ms: Date.now() - started } };
  }
  log(`备份完成：${backupResult.fileName}（${backupResult.bytes} 字节）`);

  const dbName = drillDbName(ts);
  const env = backup.pgEnv(cfg);
  let tempDbCreated = false;
  let rowsAfter = null;
  let tablesAfter = 0;
  let restoreOk = false;
  let restoreErr = '';

  try {
    // ===== 3. 建临时库 =====
    log(`创建临时库 ${dbName}…`);
    const created = await runCmd(createdbTool.cmd, [
      '--host', cfg.host, '--port', cfg.port, '--username', cfg.user, dbName,
    ], env);
    if (created.code !== 0) {
      const msg = `createdb 失败（退出码 ${created.code}）：${created.stderr.trim()}`;
      error(msg);
      return { ok: false, report: { error: msg, backup_file: backupResult.file, duration_ms: Date.now() - started } };
    }
    tempDbCreated = true;

    // ===== 4. 恢复 =====
    log('恢复到临时库…');
    const res = await pipeGzIntoPsql(psqlTool.cmd, cfg, dbName, backupResult.file);
    restoreOk = res.code === 0;
    if (!restoreOk) {
      restoreErr = `psql 退出码 ${res.code}：${res.stderr.trim()}`;
      error(restoreErr);
    } else {
      log('恢复完成，统计临时库…');
      rowsAfter = restore.collectTableStats(psqlTool.cmd, cfg, dbName);
      if (!rowsAfter) {
        restoreOk = false;
        restoreErr = '临时库统计读取失败';
      } else {
        tablesAfter = Object.keys(rowsAfter).length;
      }
    }
  } finally {
    // ===== 5. 清理（一定执行） =====
    if (tempDbCreated) {
      log(`清理临时库 ${dbName}…`);
      const dropped = await runCmd(dropdbTool.cmd, [
        '--host', cfg.host, '--port', cfg.port, '--username', cfg.user,
        '--if-exists', '--force', dbName,
      ], env);
      if (dropped.code !== 0) {
        // --force 是 PG 13+ 才有，老版本回退到普通 drop
        const retry = await runCmd(dropdbTool.cmd, [
          '--host', cfg.host, '--port', cfg.port, '--username', cfg.user,
          '--if-exists', dbName,
        ], env);
        if (retry.code !== 0) {
          warn(`临时库 ${dbName} 删除失败，请手工清理：${retry.stderr.trim() || dropped.stderr.trim()}`);
        }
      }
    }
    if (!options.keepBackup && backupResult.file) {
      try {
        fs.unlinkSync(backupResult.file);
        const filesDir = backupResult.file.replace(/\.sql\.gz$/, '.files');
        if (fs.existsSync(filesDir)) fs.rmSync(filesDir, { recursive: true, force: true });
        log('已删除演练用备份文件（--keep-backup 可保留）');
      } catch (e) {
        warn(`删除演练备份失败：${e.message}`);
      }
    }
  }

  // ===== 6. 比对 =====
  const diffs = [];
  if (restoreOk && rowsAfter) {
    for (const [table, n] of Object.entries(rowsBefore)) {
      const after = rowsAfter[table];
      if (after === undefined) diffs.push({ table, before: n, after: '缺失' });
      else if (after !== n) diffs.push({ table, before: n, after });
    }
    for (const table of Object.keys(rowsAfter)) {
      if (!(table in rowsBefore)) diffs.push({ table, before: '缺失', after: rowsAfter[table] });
    }
  }

  const rowsBeforeTotal = Object.values(rowsBefore).reduce((a, b) => a + b, 0);
  const rowsAfterTotal = rowsAfter ? Object.values(rowsAfter).reduce((a, b) => a + b, 0) : 0;
  const match = restoreOk && diffs.length === 0 && tablesBefore === tablesAfter && rowsBeforeTotal === rowsAfterTotal;

  const report = {
    backup_file: backupResult.file || backupResult.fileName,
    backup_bytes: backupResult.bytes,
    tables: { before: tablesBefore, after: tablesAfter },
    rows_before: rowsBeforeTotal,
    rows_after: rowsAfterTotal,
    match,
    duration_ms: Date.now() - started,
  };
  if (restoreErr) report.error = restoreErr;
  if (diffs.length) report.diffs = diffs;

  console.log('\n===== 恢复演练报告 =====');
  console.log(JSON.stringify(report, null, 2));
  console.log('=========================\n');

  if (!match) {
    error(restoreErr ? `演练失败：${restoreErr}` : '演练失败：表/行数不一致');
  } else {
    log(`演练通过，耗时 ${report.duration_ms}ms`);
  }

  return { ok: match, report };
}

async function main() {
  const keepBackup = process.argv.includes('--keep-backup');
  const { ok } = await runDrill({ keepBackup });
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error('[演练] 未捕获异常：', e);
    process.exit(1);
  });
}

module.exports = { runDrill, drillDbName };
