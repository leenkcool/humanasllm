/**
 * 网关接入配置（不同企业不同域名 → 一键生成 SKILL/AGENT 文件 + 在线微调）
 *  - GET/PUT /api/gateway/config    读取/保存接入配置（存 data/gateway_config.json）
 *  - POST    /api/gateway/generate  用配置渲染 SKILL.md / AGENT.md（替换网关域名）
 *  - GET     /api/gateway/files      读取生成/微调后的文件
 *  - PUT     /api/gateway/files/:type 保存微调后的文件（skill | agent）
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authenticate, requireRole } = require('../middleware/auth');

const DATA_DIR = path.join(__dirname, '../data');
const CONFIG_FILE = path.join(DATA_DIR, 'gateway_config.json');
const FILES_FILE = path.join(DATA_DIR, 'gateway_files.json');
const SKILL_TPL = path.join(__dirname, '../.claude/skills/dispatch-human/SKILL.md');
const AGENT_TPL = path.join(__dirname, '../.claude/agents/humanllm.md');
const SKILL_OUT = path.join(DATA_DIR, 'gateway_skill.md');
const AGENT_OUT = path.join(DATA_DIR, 'gateway_agent.md');
// 服务器端安装根（env GATEWAY_INSTALL_ROOT 可指向真实项目根；默认 data/installed 沙箱）
const INSTALL_ROOT = process.env.GATEWAY_INSTALL_ROOT
  ? path.resolve(process.env.GATEWAY_INSTALL_ROOT)
  : path.join(DATA_DIR, 'installed');

/** 目标路径安全校验：必须落在 INSTALL_ROOT 内，禁止越界 */
function safeTarget(root, target) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(target == null ? '' : target));
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw Object.assign(new Error('目标路径越界，不允许写入安装根之外'), { status: 400 });
  }
  return abs;
}

const DEFAULT_CONFIG = { baseUrl: 'http://192.168.168.3:39000', model: 'human-llm', apiKey: '', note: '' };

// 通用 AGENTS.md 模板（Codex / OpenCode / Gemini / 通用 Agent 均读取的项目指令）
const AGENTS_TPL = `# P390 人工路由规则（Human-as-LLM）

本项目接入人工代理网关 P390（网关：<baseUrl>，模型：<model>）。

## 何时走人工路由
以下任务**不自己实现**，走人工工程师：
- 涉密 / 私有内部逻辑 / 数据不出网关
- 需人工判断 / 责任归属 / 物理世界 / 合规留痕
- 用户明确要求「交给人工 / 派给人类 / 需要人工实现」

## 调用方式（OpenAI 兼容，异步受理）
1. 提交：POST <baseUrl>/v1/chat/completions
   body: { "model": "<model>", "messages": [...], "category": "confidential|ops" }
   立即返回 task_id（人工为小时级，不要同步等待）。
2. 登记 task_id 到未完成清单。
3. 回查：GET <baseUrl>/v1/tasks/<task_id>
   - completed → 取 content（人工产出）逐字交付
   - returned → 转达驳回原因，可补充上下文重派
   - 其余 → 如实反馈状态，继续轮候
4. 资源申请：POST <baseUrl>/v1/approvals → approval_no → GET <baseUrl>/v1/approvals/<approval_no>

## 铁律
- 涉密 / 运维类任务绝不交给公有大模型（上下文不出网关）
- 人工产出逐字返回，不自行改写
`;

// OpenCode slash command 模板
const OPENCODE_CMD_TPL = `---
description: 派人工工程师处理（P390 人工路由）
---
按 AGENTS.md 的人工路由规则，把当前任务提交到 P390 网关（<baseUrl>），登记 task_id 并回查取回人工产出。
`;

// Cursor 规则（需 frontmatter）；Windsurf / Gemini / Aider 内容同通用规则
const CURSOR_TPL = `---
description: P390 人工路由（Human-as-LLM）：涉密/需人工任务走人工工程师
globs: **/*.{js,ts,py,md,json}
---
${AGENTS_TPL}`;
const GEMINI_TPL = AGENTS_TPL;
const WINDSURF_TPL = AGENTS_TPL;
const AIDER_TPL = AGENTS_TPL;

// 通用构建指南：任意 AI Agent 工具（含未来的）如何把规则构建成本地 skill/agent
const BUILD_TPL = `# 构建本地 SKILL / AGENT（任意 AI Agent 工具通用方法）

P390 人工路由能力 = 一段规则 + OpenAI 兼容接口说明。任何 AI Agent 工具（含未来的）都能构建成本地 skill / agent。

## 一、规则全文（复制到你的 skill / agent / 规则文件）

${AGENTS_TPL}

## 二、按工具放置

| 工具 | 放置位置 |
|---|---|
| Claude Code | .claude/skills/dispatch-human/SKILL.md（+ .claude/agents/humanllm.md） |
| Codex / OpenCode / Gemini / Continue 等 | AGENTS.md（或 GEMINI.md） |
| Cursor | .cursor/rules/p390.mdc |
| Windsurf | .windsurf/rules/p390.md |
| Aider | CONVENTIONS.md |
| workbuddy / openclaw / hermes / pi | AGENTS.md（若支持）；否则按「三、构建步骤」 |
| 其他 / 未来工具 | 该工具的 rules / skill / instructions 目录 |

## 三、构建步骤
1. 取上方规则全文（网关 <baseUrl> 已内嵌）。
2. 写入工具对应的规则文件。
3. 若工具支持 skill/agent 命名（如 Claude Code 的 SKILL.md），把规则做成 dispatch-human skill。
4. 验证：让 Agent 处理一个涉密/需人工任务，确认它走 P390 人工路由并回查交付。
`;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeText(file, content) { fs.writeFileSync(file, content, 'utf8'); }

// 多工具微调存储：{ tool: { path: content } }
function readFilesJson() { return readJson(FILES_FILE, {}); }
function writeFilesJson(obj) { writeText(FILES_FILE, JSON.stringify(obj, null, 2)); }

/** 用配置渲染模板：替换网关地址 + <baseUrl>/<model> 占位 */
function renderTemplate(tpl, cfg) {
  const base = String(cfg.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
  const model = cfg.model || 'human-llm';
  return tpl
    .replace(/<baseUrl>/g, base)
    .replace(/<model>/g, model)
    .replace(/https?:\/\/192\.168\.168\.3:39000/g, base)
    .replace(/https?:\/\/127\.0\.0\.1:39000/g, base)
    .replace(/https?:\/\/localhost:39000/g, base);
}

/** 按工具生成安装文件列表 */
function toolFiles(tool, cfg) {
  const a = (p, c) => ({ path: p, content: c });
  const agents = renderTemplate(AGENTS_TPL, cfg);
  switch (tool) {
    case 'claude': {
      const skill = fs.existsSync(SKILL_OUT)
        ? fs.readFileSync(SKILL_OUT, 'utf8')
        : renderTemplate(fs.readFileSync(SKILL_TPL, 'utf8'), cfg);
      const agent = fs.existsSync(AGENT_OUT)
        ? fs.readFileSync(AGENT_OUT, 'utf8')
        : renderTemplate(fs.readFileSync(AGENT_TPL, 'utf8'), cfg);
      return [
        a('.claude/skills/dispatch-human/SKILL.md', skill),
        a('.claude/agents/humanllm.md', agent),
      ];
    }
    case 'opencode':
      return [
        a('AGENTS.md', agents),
        a('.opencode/command/dispatch-human.md', renderTemplate(OPENCODE_CMD_TPL, cfg)),
      ];
    case 'gemini': return [a('GEMINI.md', renderTemplate(GEMINI_TPL, cfg))];
    case 'cursor': return [a('.cursor/rules/p390.mdc', renderTemplate(CURSOR_TPL, cfg))];
    case 'windsurf': return [a('.windsurf/rules/p390.md', renderTemplate(WINDSURF_TPL, cfg))];
    case 'aider': return [a('CONVENTIONS.md', renderTemplate(AIDER_TPL, cfg))];
    case 'build': return [a('构建指南.md', renderTemplate(BUILD_TPL, cfg))];
    // workbuddy / openclaw / hermes / pi：按 AGENTS.md 标准（多数 agent 兼容）+ 附构建指南兜底
    case 'workbuddy':
    case 'openclaw':
    case 'hermes':
    case 'pi':
      return [
        a('AGENTS.md', agents),
        a('构建指南.md', renderTemplate(BUILD_TPL, cfg)),
      ];
    default: return [a('AGENTS.md', agents)]; // codex / agents / 其他 → AGENTS.md
  }
}

/** 该工具的生成文件（微调后优先，否则按模板渲染） */
function getToolFiles(tool, cfg) {
  const saved = readFilesJson()[tool];
  if (saved && Object.keys(saved).length) {
    return Object.entries(saved).map(([p, c]) => ({ path: p, content: c }));
  }
  return toolFiles(tool, cfg);
}

/** 本机全装 node 脚本：一次写入所有工具的 skill/agent/规则（Claude 安装后可同步其他本机 agent） */
function installAllScript(cfg) {
  const tools = ['claude', 'codex', 'agents', 'opencode', 'gemini', 'cursor', 'windsurf', 'aider', 'workbuddy', 'openclaw', 'hermes', 'pi'];
  const files = {};
  for (const t of tools) files[t] = getToolFiles(t, cfg);
  const payload = JSON.stringify(files).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const base = String(cfg.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
  const model = cfg.model || 'human-llm';
  return `#!/usr/bin/env node
/* P390 本机全装：扫描本机已装 AI Agent 工具，写入对应 skill/agent/规则 */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
function has(cmd) { try { execSync((process.platform === 'win32' ? 'where ' : 'which ') + cmd, { stdio: 'ignore' }); return true; } catch (e) { return false; } }
const CLI = { codex: 'codex', opencode: 'opencode', gemini: 'gemini', cursor: 'cursor', aider: 'aider' };
const DETECT = {};
for (const [t, c] of Object.entries(CLI)) DETECT[t] = has(c);
const FILES = ${payload};
let n = 0; const skipped = [];
for (const [tool, list] of Object.entries(FILES)) {
  const always = tool === 'agents' || tool === 'claude';          // AGENTS.md 与 Claude Code 总是装
  const noCli = tool === 'workbuddy' || tool === 'openclaw' || tool === 'hermes' || tool === 'pi';
  if (!always) {
    if (noCli) { skipped.push(tool + '(无标准CLI)'); continue; }
    if (!DETECT[tool]) { skipped.push(tool); console.log('跳过 [' + tool + ']：未检测到本机 ' + CLI[tool] + ' 命令'); continue; }
  }
  for (const f of list) {
    const p = path.join(process.cwd(), f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content, 'utf8');
    console.log('[' + tool + '] ' + f.path);
    n++;
  }
}
console.log('P390 本机安装完成：' + n + ' 个文件。网关 ' + '${base}' + '，模型 ' + '${model}' + '。');
if (skipped.length) console.log('未检测到/未安装：' + skipped.join(', ') + '（可按构建指南手动安装）');
`;
}

// 服务器端安装：把某工具文件写入 INSTALL_ROOT/target（admin，安全校验防越界）
router.post('/install-server', authenticate, requireRole('admin'), (req, res) => {
  try {
    const { tool, target } = req.body || {};
    if (!tool) return res.status(400).json({ success: false, message: 'tool 必填' });
    const cfg = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const dest = safeTarget(INSTALL_ROOT, target);
    const files = getToolFiles(tool, cfg);
    const written = [];
    for (const f of files) {
      const p = path.join(dest, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content, 'utf8');
      written.push(p);
    }
    res.json({ success: true, data: { root: INSTALL_ROOT, target: target || '.', count: written.length, files: written } });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message || '服务器端安装失败' });
  }
});

// 服务器安装根（展示给前端）
router.get('/install-root', authenticate, (req, res) => {
  res.json({ success: true, data: { root: INSTALL_ROOT } });
});

// 免认证安装接口：目标项目粘贴安装提示词后，Agent 拉取本接口写入项目
// tool 支持：claude / codex / agents / opencode / gemini / cursor / windsurf / aider / workbuddy / openclaw / hermes / pi / build / all（本机全装脚本）
router.get('/install', (req, res) => {
  try {
    const cfg = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const tool = req.query.tool || 'claude';
    const base = String(cfg.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
    if (tool === 'all') {
      return res.json({ success: true, data: { tool, gateway: base, model: cfg.model, files: [{ path: 'p390-install.js', content: installAllScript(cfg) }] } });
    }
    res.json({ success: true, data: { tool, gateway: base, model: cfg.model, files: getToolFiles(tool, cfg) } });
  } catch (e) {
    console.error('[安装包生成失败]', e.message);
    res.status(500).json({ success: false, message: '生成安装包失败' });
  }
});

// 读取当前配置
router.get('/config', authenticate, (req, res) => {
  res.json({ success: true, data: readJson(CONFIG_FILE, DEFAULT_CONFIG) });
});

// 保存接入配置
router.put('/config', authenticate, (req, res) => {
  const { baseUrl, model, apiKey, note } = req.body || {};
  if (!baseUrl) return res.status(400).json({ success: false, message: '网关地址必填' });
  const cfg = {
    baseUrl: String(baseUrl).trim(),
    model: model || 'human-llm',
    apiKey: apiKey || '',
    note: note || '',
  };
  writeText(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  res.json({ success: true, data: cfg });
});

// 生成 SKILL + AGENT（可选 body 覆盖配置，生成后写入 data/）
router.post('/generate', authenticate, (req, res) => {
  try {
    const cfg = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, DEFAULT_CONFIG), ...(req.body || {}) };
    if (!cfg.baseUrl) return res.status(400).json({ success: false, message: '网关地址必填' });
    const skill = renderTemplate(fs.readFileSync(SKILL_TPL, 'utf8'), cfg);
    const agent = renderTemplate(fs.readFileSync(AGENT_TPL, 'utf8'), cfg);
    writeText(SKILL_OUT, skill);
    writeText(AGENT_OUT, agent);
    res.json({ success: true, data: { skill, agent } });
  } catch (e) {
    console.error('[生成失败]', e.message);
    res.status(500).json({ success: false, message: '生成失败: ' + e.message });
  }
});

// 读取某工具生成/微调后的文件（微调后优先，否则模板渲染）
router.get('/files', authenticate, (req, res) => {
  try {
    const cfg = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const tool = req.query.tool || 'claude';
    res.json({ success: true, data: { tool, files: getToolFiles(tool, cfg) } });
  } catch (e) {
    console.error('[读取失败]', e.message);
    res.status(500).json({ success: false, message: '读取失败' });
  }
});

// 保存某工具某文件的微调
router.put('/files', authenticate, (req, res) => {
  const { tool, path: fpath, content } = req.body || {};
  if (!tool || !fpath) return res.status(400).json({ success: false, message: 'tool 与 path 必填' });
  const all = readFilesJson();
  all[tool] = all[tool] || {};
  all[tool][fpath] = String(content != null ? content : '');
  writeFilesJson(all);
  res.json({ success: true });
});

module.exports = router;
// 纯函数导出（单元测试 / 复用）
module.exports.renderTemplate = renderTemplate;
module.exports.safeTarget = safeTarget;
