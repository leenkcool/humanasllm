/**
 * PostgreSQL 逻辑备份脚本（跨平台，零新增依赖）
 *
 * 用法：
 *   node scripts/backup.js                 # 备份到 data/backups/
 *   node scripts/backup.js --out <dir>     # 指定输出目录
 *   node scripts/backup.js --keep 14       # 保留最近 N 份（默认 14，可用 BACKUP_KEEP 覆盖）
 *   node scripts/backup.js --dry-run       # 只打印将要执行的命令，不落盘
 *
 * 安全说明：
 *   - 密码只通过 PGPASSWORD 环境变量传给子进程，绝不拼进命令行（避免进入 shell 历史 / ps 列表）
 *   - 全程 spawn，不经过 shell，路径含空格也安全
 *   - 备份后校验：文件 > 1KB、gzip 头可解、内容含 "PostgreSQL database dump"
 *
 * 作为模块被 require 时不会自动执行（require.main 守卫）。
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_KEEP = 14;
const MIN_BACKUP_BYTES = 1024;
const DUMP_MARKER = 'PostgreSQL database dump';
// 需要随库一起备份的运行时配置文件（相对项目根）
const RUNTIME_FILES = [
  'data/gateway_config.json',
  'data/gateway_files.json',
  'data/gateway_skill.md',
  'data/gateway_agent.md',
];

// ===== 通用工具 =====

/** 子进程可执行文件名（Windows 需要 .exe 后缀） */
function exeName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/** 平台常见 PG 安装根目录 */
function pgRoots() {
  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\PostgreSQL',
      'D:\\Program Files\\PostgreSQL',
      'C:\\PostgreSQL',
      'D:\\PostgreSQL',
    ];
    // 兜底：从 PATH 里已存在的 psql 反推
    return roots;
  }
  return ['/usr/lib/postgresql', '/usr/pgsql', '/opt/postgresql', '/usr/local/pgsql'];
}

/** 从目录名解析主版本号（如 18 / 16），非数字返回 0 */
function dirMajor(name) {
  const m = /^(\d+)/.exec(name || '');
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 解析可执行工具路径
 * 顺序：PG_BIN 环境变量 → PATH → 常见安装目录（取主版本最高者）
 * @param {string} base 如 'pg_dump'
 * @returns {{cmd: string, source: string}}
 */
function resolvePgTool(base) {
  const fileName = exeName(base);

  if (process.env.PG_BIN) {
    const direct = path.join(process.env.PG_BIN, fileName);
    if (fs.existsSync(direct)) return { cmd: direct, source: `PG_BIN=${process.env.PG_BIN}` };
  }

  // PATH 中直接可用
  const probe = spawnSync(fileName, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (!probe.error && probe.status === 0) return { cmd: fileName, source: 'PATH' };

  // 扫描常见安装目录，取最高版本
  const found = [];
  for (const root of pgRoots()) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (e) { continue; }
    for (const d of dirs) {
      const bin = path.join(root, d, 'bin');
      if (fs.existsSync(path.join(bin, fileName))) {
        found.push({ bin, major: dirMajor(d) });
      }
    }
  }
  found.sort((a, b) => b.major - a.major);
  if (found.length) {
    return { cmd: path.join(found[0].bin, fileName), source: `安装目录（v${found[0].major}）` };
  }
  return { cmd: fileName, source: '未找到，回退 PATH' };
}

/** 解析工具版本字符串，返回 {major, raw} */
function parseToolVersion(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) return null;
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  return { major: m ? parseInt(m[1], 10) : 0, raw: text };
}

/** 服务端 PG 主版本号（用 psql 查询；失败返回 null） */
function serverMajor(psqlCmd, cfg, env) {
  const args = [
    '--host', cfg.host,
    '--port', cfg.port,
    '--username', cfg.user,
    '--dbname', cfg.database,
    '-tAc', 'SHOW server_version_num',
  ];
  const r = spawnSync(psqlCmd, args, { encoding: 'utf8', timeout: 15000, env });
  if (r.error || r.status !== 0) return null;
  const num = parseInt(String(r.stdout || '').trim(), 10);
  if (!Number.isFinite(num)) return null;
  return Math.floor(num / 10000);
}

/** 本地时间戳 YYYYMMDD-HHmmss */
function timestampNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 解析备份名（兼容 p390-YYYYMMDD-HHmmss.sql.gz 与同名 .files 目录）
 * @returns {{name:string, key:string, date:Date}|null}
 */
function parseBackupName(name) {
  const base = path.basename(String(name || ''));
  const m = /^p390-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.(sql\.gz|files)$/.exec(base);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (Number.isNaN(date.getTime())) return null;
  return { name: base, key: `${y}${mo}${d}-${h}${mi}${s}`, date, ext: m[7] };
}

/**
 * 保留策略：选出需要删除的旧备份（按时间戳倒序，保留最新 keep 份）
 * @param {string[]} names 备份文件名/目录名列表
 * @param {number} keep 保留份数
 * @returns {string[]} 待删除的名字（升序，便于日志稳定）
 */
function selectExpired(names, keep) {
  const n = Number.isFinite(Number(keep)) && Number(keep) > 0 ? Number(keep) : DEFAULT_KEEP;
  const parsed = (names || []).map(parseBackupName).filter(Boolean);
  parsed.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // 新 → 旧
  return parsed.slice(n).map((x) => x.name).sort();
}

/** 计算文件 sha256 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('error', reject);
    rs.on('data', (buf) => h.update(buf));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 校验 gzip 备份文件
 * @returns {Promise<{ok:boolean, reason:string, text:string}>}
 */
function verifyGzipFile(file, options = {}) {
  const marker = options.marker || DUMP_MARKER;
  const maxBytes = options.maxBytes || 4096;

  return new Promise((resolve) => {
    if (!fs.existsSync(file)) return resolve({ ok: false, reason: '文件不存在', text: '' });

    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) {
      return resolve({ ok: false, reason: `无法读取文件：${e.message}`, text: '' });
    }
    if (size <= MIN_BACKUP_BYTES) {
      return resolve({ ok: false, reason: `文件过小（${size} 字节，至少 ${MIN_BACKUP_BYTES}）`, text: '' });
    }

    // gzip 魔数 1f 8b
    let magic = Buffer.alloc(2);
    try {
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, magic, 0, 2, 0);
      fs.closeSync(fd);
    } catch (e) {
      return resolve({ ok: false, reason: `读取失败：${e.message}`, text: '' });
    }
    if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
      return resolve({ ok: false, reason: '不是 gzip 文件', text: '' });
    }

    const rs = fs.createReadStream(file, { start: 0, end: Math.min(size - 1, 256 * 1024) });
    const gunzip = zlib.createGunzip();
    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      try { rs.destroy(); } catch (e) { /* 忽略 */ }
      try { gunzip.destroy(); } catch (e) { /* 忽略 */ }
      const text = Buffer.concat(chunks).toString('utf8');
      if (ok && marker && !text.includes(marker)) {
        return resolve({ ok: false, reason: `gzip 可解但内容不含 "${marker}"（可能不是 pg_dump 产物）`, text });
      }
      resolve({ ok, reason, text });
    };

    rs.on('error', (e) => finish(false, `读取失败：${e.message}`));
    gunzip.on('error', () => {
      // 只读了前 256KB，gzip 尾部必然截断；只要已解出内容即视为通过
      finish(chunks.length > 0, chunks.length > 0 ? '校验通过（流截断，已解出内容）' : 'gzip 解压失败');
    });
    gunzip.on('data', (buf) => {
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes) finish(true, '校验通过');
    });
    gunzip.on('end', () => finish(true, '校验通过'));

    rs.pipe(gunzip);
  });
}

/** PG 连接配置（来自 .env） */
function pgConfig() {
  return {
    host: process.env.PG_HOST || 'localhost',
    port: String(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'postgres',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
  };
}

/** 子进程环境（注入 PGPASSWORD / PGSSLMODE） */
function pgEnv(cfg) {
  const env = { ...process.env, PGPASSWORD: cfg.password };
  if (!env.PGSSLMODE) env.PGSSLMODE = 'prefer';
  return env;
}

/** 日志（统一 [备份] 前缀） */
function makeLogger(quiet = false) {
  return {
    info: (...args) => { if (!quiet) console.log('[备份]', ...args); },
    warn: (...args) => { if (!quiet) console.warn('[备份]', ...args); },
    error: (...args) => console.error('[备份]', ...args),
  };
}

/** 参数解析 */
function parseArgs(argv) {
  const opts = {
    out: process.env.BACKUP_DIR ? path.resolve(ROOT, process.env.BACKUP_DIR) : path.join(ROOT, 'data', 'backups'),
    keep: parseInt(process.env.BACKUP_KEEP, 10) || DEFAULT_KEEP,
    dryRun: false,
    quiet: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--out') { opts.out = path.resolve(process.cwd(), args[++i] || opts.out); }
    else if (a === '--keep') { opts.keep = parseInt(args[++i], 10); }
    else if (a === '--dry-run') { opts.dryRun = true; }
    else if (a === '--quiet') { opts.quiet = true; }
    else if (a === '--help' || a === '-h') { opts.help = true; }
  }
  if (!Number.isFinite(opts.keep) || opts.keep < 1) opts.keep = DEFAULT_KEEP;
  return opts;
}

const HELP = `用法: node scripts/backup.js [选项]

  --out <dir>    备份输出目录（默认 data/backups/，可用 BACKUP_DIR）
  --keep <n>     保留最近 N 份（默认 14，可用 BACKUP_KEEP）
  --dry-run      只打印将要执行的命令，不实际备份
  --quiet        静默模式（仅输出错误）
  -h, --help     显示帮助

环境变量（.env）：PG_HOST / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD / PG_BIN
`;

/** 复制运行时配置文件到 .files 目录 */
function copyRuntimeFiles(targetDir, logger) {
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  for (const rel of RUNTIME_FILES) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(targetDir, path.basename(rel));
    try {
      fs.copyFileSync(src, dst);
      copied.push(path.basename(rel));
    } catch (e) {
      logger.warn(`配置文件复制失败 ${rel}: ${e.message}`);
    }
  }
  return copied;
}

/**
 * 执行一次备份
 * @param {object} options { outDir, keep, dryRun, quiet, onProgress(evt) }
 * @returns {Promise<{ok:boolean, file?:string, bytes?:number, sha256?:string, files?:string[], deleted?:string[], error?:string, dryRun?:boolean}>}
 */
async function runBackup(options = {}) {
  const logger = makeLogger(!!options.quiet);
  const outDir = options.outDir || path.join(ROOT, 'data', 'backups');
  const keep = Number.isFinite(Number(options.keep)) && Number(options.keep) > 0 ? Number(options.keep) : DEFAULT_KEEP;
  const dryRun = !!options.dryRun;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const cfg = pgConfig();
  const ts = timestampNow();
  const fileName = `p390-${ts}.sql.gz`;
  const filePath = path.join(outDir, fileName);
  const filesDir = path.join(outDir, `p390-${ts}.files`);

  const dumper = resolvePgTool('pg_dump');
  const psqlTool = resolvePgTool('psql');
  const env = pgEnv(cfg);

  // --clean --if-exists：让备份可直接覆盖恢复到已有库（配合 psql --single-transaction 实现原子回滚）
  // 不带这两个参数时，恢复到已存在的库会因 "relation already exists" 整体失败
  const dumpArgs = [
    '--no-owner', '--no-privileges', '--format=plain',
    '--clean', '--if-exists',
    '--host', cfg.host,
    '--port', cfg.port,
    '--username', cfg.user,
    '--dbname', cfg.database,
  ];
  const maskedCmd = `PGPASSWORD=*** ${dumper.cmd} ${dumpArgs.join(' ')} | gzip > ${filePath}`;

  if (dryRun) {
    logger.info('[dry-run] 将执行：');
    logger.info(`  ${maskedCmd}`);
    logger.info(`  复制运行时文件到 ${filesDir}`);
    logger.info(`  保留策略：保留最近 ${keep} 份，目录 ${outDir}`);
    logger.info(`  连接：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
    logger.info(`  pg_dump：${dumper.cmd}（来源：${dumper.source}）`);
    // dry-run 也提前暴露版本错配，避免真跑时才发现
    const dv = parseToolVersion(dumper.cmd);
    const sv = serverMajor(psqlTool.cmd, cfg, env);
    if (dv && sv && dv.major < sv) {
      logger.warn(`[dry-run] 版本检查未通过：pg_dump ${dv.major} < 服务端 ${sv}，实际备份会失败（请设置 PG_BIN）`);
    } else if (dv && sv) {
      logger.info(`[dry-run] 版本检查通过：pg_dump ${dv.major} / 服务端 ${sv}`);
    }
    return { ok: true, dryRun: true, file: filePath, command: maskedCmd };
  }

  fs.mkdirSync(outDir, { recursive: true });
  onProgress({ status: 'running', percent: 5, message: '启动 pg_dump…' });

  // ===== 版本兼容检查（pg_dump 主版本必须 >= 服务端） =====
  const dumperVer = parseToolVersion(dumper.cmd);
  if (dumperVer) {
    const sMajor = serverMajor(psqlTool.cmd, cfg, env);
    if (sMajor && dumperVer.major < sMajor) {
      const msg = `pg_dump ${dumperVer.major} 低于服务端 PostgreSQL ${sMajor}，无法备份。`
        + `请用 PG_BIN 指定 v${sMajor}+ 的 bin 目录（例如 Windows: set PG_BIN=D:\\Program Files\\PostgreSQL\\18\\bin）。`;
      logger.error(msg);
      onProgress({ status: 'failed', percent: 100, message: msg });
      return { ok: false, error: msg };
    }
  }

  // ===== 执行 pg_dump → gzip 流式压缩 =====
  let exitCode = null;
  let stderrText = '';
  const started = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(dumper.cmd, dumpArgs, { env, windowsHide: true, shell: false });
      const gzip = zlib.createGzip({ level: 6 });
      const out = fs.createWriteStream(filePath);

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
        reject(err);
      };

      child.stderr.on('data', (buf) => {
        stderrText += buf.toString('utf8');
        if (stderrText.length > 8000) stderrText = stderrText.slice(-8000);
      });
      child.on('error', (err) => {
        const hint = err.code === 'ENOENT'
          ? ` 未找到 pg_dump（${dumper.cmd}）。请安装 PostgreSQL 客户端或用 PG_BIN 指定 bin 目录。`
          : '';
        fail(new Error(`pg_dump 启动失败：${err.message}${hint}`));
      });

      // 必须同时等「流写完」与「进程退出码为 0」，否则 pg_dump 中途失败会被当成成功
      let streamDone = false;
      let closeCode = null;
      const maybeResolve = () => {
        if (settled || !streamDone || closeCode === null) return;
        if (closeCode !== 0) {
          fail(new Error(`pg_dump 退出码 ${closeCode}${stderrText ? `：${stderrText.trim()}` : ''}`));
          return;
        }
        settled = true;
        resolve();
      };

      pipeline(child.stdout, gzip, out)
        .then(() => { streamDone = true; maybeResolve(); })
        .catch((err) => fail(new Error(`备份流写入失败：${err.message}${stderrText ? `；pg_dump: ${stderrText.trim()}` : ''}`)));

      child.on('close', (code) => {
        exitCode = code;
        closeCode = code;
        maybeResolve();
      });
    });
  } catch (e) {
    logger.error(`备份失败：${e.message}`);
    onProgress({ status: 'failed', percent: 100, message: e.message });
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { /* 忽略 */ }
    return { ok: false, error: e.message };
  }

  onProgress({ status: 'running', percent: 70, message: '备份完成，校验中…' });
  logger.info(`pg_dump 完成（退出码 ${exitCode}），耗时 ${Date.now() - started}ms`);

  // ===== 校验 =====
  const verify = await verifyGzipFile(filePath);
  if (!verify.ok) {
    logger.error(`备份校验失败：${verify.reason}`);
    onProgress({ status: 'failed', percent: 100, message: `校验失败：${verify.reason}` });
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { /* 忽略 */ }
    return { ok: false, error: `校验失败：${verify.reason}` };
  }

  const bytes = fs.statSync(filePath).size;
  const sha256 = await sha256File(filePath);
  logger.info(`校验通过：${fileName}（${bytes} 字节，sha256 ${sha256.slice(0, 16)}…）`);

  // ===== 运行时文件 =====
  const files = copyRuntimeFiles(filesDir, logger);
  if (files.length) logger.info(`已复制运行时文件：${files.join(', ')}`);

  // ===== manifest =====
  const entry = {
    ts: new Date().toISOString(),
    file: fileName,
    bytes,
    sha256,
    db: cfg.database,
    host: `${cfg.host}:${cfg.port}`,
    files,
  };
  try {
    fs.appendFileSync(path.join(outDir, 'manifest.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) {
    logger.warn(`manifest 写入失败：${e.message}`);
  }

  // ===== 保留策略 =====
  onProgress({ status: 'running', percent: 90, message: '清理旧备份…' });
  let deleted = [];
  try {
    const names = fs.readdirSync(outDir).filter((n) => n.startsWith('p390-'));
    const expired = selectExpired(names, keep);
    for (const name of expired) {
      const p = path.join(outDir, name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
        deleted.push(name);
      } catch (e) {
        logger.warn(`删除旧备份失败 ${name}：${e.message}`);
      }
    }
  } catch (e) {
    logger.warn(`读取备份目录失败：${e.message}`);
  }
  if (deleted.length) logger.info(`清理旧备份 ${deleted.length} 项：${deleted.join(', ')}`);

  onProgress({ status: 'success', percent: 100, message: `备份完成：${fileName}`, filename: fileName });
  logger.info(`备份完成 → ${filePath}`);
  return { ok: true, file: filePath, fileName, bytes, sha256, files, deleted, keep };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const result = await runBackup({ outDir: opts.out, keep: opts.keep, dryRun: opts.dryRun, quiet: opts.quiet });
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error('[备份] 未捕获异常：', e);
    process.exit(1);
  });
}

module.exports = {
  // 纯函数（供测试 / 其他脚本复用）
  parseBackupName,
  selectExpired,
  verifyGzipFile,
  timestampNow,
  pgConfig,
  pgEnv,
  resolvePgTool,
  parseToolVersion,
  // 主流程
  runBackup,
  RUNTIME_FILES,
  DEFAULT_KEEP,
  MIN_BACKUP_BYTES,
  DUMP_MARKER,
};
