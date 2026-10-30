/**
 * 数据备份路由（工作台触发 + 历史查询）
 *  - GET  /api/backup/list    备份历史（读 data/backups/manifest.jsonl，倒序最近 50 条） admin
 *  - POST /api/backup/run     异步触发备份脚本，立即返回 started:true（同一时刻只允许一个） admin
 *  - GET  /api/backup/status  当前是否在跑 + 最近一次结果 admin
 *
 * 说明：
 *  - 备份脚本以子进程方式运行（node scripts/backup.js），密码仍走 .env 的 PGPASSWORD 机制
 *  - 进度通过 services/websocket.js 的 broadcast('backup:progress', ...) 推给已连工作台
 *  - 运行状态是进程内内存标志：多实例部署时需改用外部锁（本项目单实例）
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { authenticate, requireRole } = require('../middleware/auth');
const ws = require('../services/websocket');

const router = express.Router();

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backup.js');

/** 备份目录（与 scripts/backup.js 的默认值保持一致） */
function backupDir() {
  const dir = process.env.BACKUP_DIR || path.join('data', 'backups');
  return path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
}

/** 进程内运行状态（单实例） */
const state = {
  running: false,
  startedAt: null,
  lastResult: null, // { ok, at, file, bytes, error, duration_ms }
};

/** 广播进度（WebSocket 未初始化时是空操作，不会报错） */
function progress(payload) {
  try {
    ws.broadcast('backup:progress', { ts: new Date().toISOString(), ...payload });
  } catch (e) {
    // 推送失败不影响备份
  }
}

/** 读 manifest.jsonl，倒序返回最近 N 条 */
function readManifest(limit = 50) {
  const file = path.join(backupDir(), 'manifest.jsonl');
  if (!fs.existsSync(file)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [];
  }
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      // 跳过损坏行（手工编辑/写入中断）
    }
  }
  // manifest 是追加写，天然按时间升序；倒序取最近 limit 条
  return entries.reverse().slice(0, Math.max(1, limit));
}

/** 列出磁盘上的备份文件（manifest 丢失时的兜底数据源） */
function listFilesOnDisk() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((n) => n.startsWith('p390-') && n.endsWith('.sql.gz'))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { file: n, bytes: st.size, ts: st.mtime.toISOString(), source: 'disk' };
      })
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
  } catch (e) {
    return [];
  }
}

// ===== GET /api/backup/list =====
router.get('/list', authenticate, requireRole('admin'), (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const items = readManifest(limit);
    const withSource = items.length ? items.map((i) => ({ ...i, source: 'manifest' })) : listFilesOnDisk();
    res.json({
      success: true,
      data: {
        dir: path.relative(ROOT, backupDir()) || backupDir(),
        count: withSource.length,
        items: withSource.slice(0, limit),
      },
    });
  } catch (e) {
    console.error('[备份列表失败]', e.message);
    res.status(500).json({ success: false, message: '读取备份历史失败' });
  }
});

// ===== POST /api/backup/run =====
router.post('/run', authenticate, requireRole('admin'), (req, res) => {
  if (state.running) {
    return res.status(409).json({ success: false, message: '已有备份正在执行，请稍后再试', startedAt: state.startedAt });
  }

  if (!fs.existsSync(SCRIPT)) {
    return res.status(500).json({ success: false, message: '备份脚本不存在：scripts/backup.js' });
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  const startedMs = Date.now();

  // 立即返回，备份在后台跑
  res.json({ success: true, started: true, started_at: state.startedAt, operator: req.user && req.user.username });

  progress({ status: 'running', percent: 1, message: '备份任务已启动' });

  // 透传 --keep / --out（未传则脚本读 BACKUP_KEEP / BACKUP_DIR）
  const args = [SCRIPT];
  if (req.body && req.body.keep) args.push('--keep', String(parseInt(req.body.keep, 10) || 14));
  if (process.env.BACKUP_DIR) args.push('--out', backupDir());

  let stdoutBuf = '';
  let stderrBuf = '';
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      shell: false,
    });
  } catch (e) {
    state.running = false;
    state.lastResult = { ok: false, at: new Date().toISOString(), error: e.message, duration_ms: 0 };
    progress({ status: 'failed', percent: 100, message: `启动失败：${e.message}` });
    return;
  }

  child.stdout.on('data', (buf) => {
    stdoutBuf += buf.toString('utf8');
    if (stdoutBuf.length > 20000) stdoutBuf = stdoutBuf.slice(-20000);
  });
  child.stderr.on('data', (buf) => {
    stderrBuf += buf.toString('utf8');
    if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
  });

  child.on('error', (err) => {
    state.running = false;
    state.lastResult = { ok: false, at: new Date().toISOString(), error: err.message, duration_ms: Date.now() - startedMs };
    progress({ status: 'failed', percent: 100, message: `备份进程异常：${err.message}` });
  });

  child.on('close', (code) => {
    const duration = Date.now() - startedMs;
    // 从输出里提取产物文件名（脚本会打印「备份完成 → <path>」）
    const m = /备份完成\s*→\s*(.+?)\s*$/m.exec(`${stdoutBuf}\n${stderrBuf}`);
    const filePath = m ? m[1].trim() : null;
    let bytes = null;
    if (filePath) {
      try { bytes = fs.statSync(filePath).size; } catch (e) { bytes = null; }
    }
    const ok = code === 0;
    state.running = false;
    state.startedAt = null;
    state.lastResult = {
      ok,
      at: new Date().toISOString(),
      code,
      file: filePath ? path.basename(filePath) : null,
      bytes,
      duration_ms: duration,
      error: ok ? null : (stderrBuf.trim().split(/\r?\n/).pop() || `备份进程退出码 ${code}`),
    };
    progress({
      status: ok ? 'success' : 'failed',
      percent: 100,
      message: ok ? '备份完成' : (state.lastResult.error || '备份失败'),
      filename: state.lastResult.file || undefined,
      bytes: bytes || undefined,
    });
    if (!ok) console.error('[备份任务失败]', state.lastResult.error);
  });
});

// ===== GET /api/backup/status =====
router.get('/status', authenticate, requireRole('admin'), (req, res) => {
  const dir = backupDir();
  let fileCount = 0;
  let latest = null;
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((n) => /^p390-.*\.sql\.gz$/.test(n));
      fileCount = files.length;
      if (files.length) {
        const sorted = files
          .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        latest = {
          file: sorted[0].n,
          bytes: fs.statSync(path.join(dir, sorted[0].n)).size,
          mtime: new Date(sorted[0].m).toISOString(),
        };
      }
    }
  } catch (e) {
    // 目录不可读时返回零值
  }

  res.json({
    success: true,
    data: {
      running: state.running,
      started_at: state.startedAt,
      last_result: state.lastResult,
      dir: path.relative(ROOT, dir) || dir,
      file_count: fileCount,
      latest_file: latest,
      keep: parseInt(process.env.BACKUP_KEEP, 10) || 14,
    },
  });
});

module.exports = router;
// 便于单测/复用：不透出 state（避免外部篡改运行标志）
module.exports.readManifest = readManifest;
module.exports.backupDir = backupDir;
module.exports.listFilesOnDisk = listFilesOnDisk;
