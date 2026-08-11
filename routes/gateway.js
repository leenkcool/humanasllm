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
const { authenticate } = require('../middleware/auth');

const DATA_DIR = path.join(__dirname, '../data');
const CONFIG_FILE = path.join(DATA_DIR, 'gateway_config.json');
const SKILL_TPL = path.join(__dirname, '../.claude/skills/dispatch-human/SKILL.md');
const AGENT_TPL = path.join(__dirname, '../.claude/agents/humanllm.md');
const SKILL_OUT = path.join(DATA_DIR, 'gateway_skill.md');
const AGENT_OUT = path.join(DATA_DIR, 'gateway_agent.md');

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

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeText(file, content) { fs.writeFileSync(file, content, 'utf8'); }

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

// 免认证安装接口：目标项目粘贴安装提示词后，Agent 拉取本接口写入项目
// ?tool=claude → .claude SKILL+AGENT；tool=codex|gemini|agents → AGENTS.md；tool=opencode → AGENTS.md + .opencode command
router.get('/install', (req, res) => {
  try {
    const cfg = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const tool = req.query.tool || 'claude';
    const base = String(cfg.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
    if (tool === 'opencode') {
      return res.json({ success: true, data: { tool, gateway: base, model: cfg.model, files: [
        { path: 'AGENTS.md', content: renderTemplate(AGENTS_TPL, cfg) },
        { path: '.opencode/command/dispatch-human.md', content: renderTemplate(OPENCODE_CMD_TPL, cfg) },
      ] } });
    }
    if (tool === 'claude') {
      const skill = fs.existsSync(SKILL_OUT)
        ? fs.readFileSync(SKILL_OUT, 'utf8')
        : renderTemplate(fs.readFileSync(SKILL_TPL, 'utf8'), cfg);
      const agent = fs.existsSync(AGENT_OUT)
        ? fs.readFileSync(AGENT_OUT, 'utf8')
        : renderTemplate(fs.readFileSync(AGENT_TPL, 'utf8'), cfg);
      return res.json({ success: true, data: { tool, gateway: base, model: cfg.model, files: [
        { path: '.claude/skills/dispatch-human/SKILL.md', content: skill },
        { path: '.claude/agents/humanllm.md', content: agent },
      ] } });
    }
    // codex / gemini / 通用 → AGENTS.md
    res.json({ success: true, data: { tool, gateway: base, model: cfg.model, files: [
      { path: 'AGENTS.md', content: renderTemplate(AGENTS_TPL, cfg) },
    ] } });
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

// 读取生成/微调后的文件（未生成时按当前配置渲染模板）
router.get('/files', authenticate, (req, res) => {
  try {
    const cfg = readJson(CONFIG_FILE, DEFAULT_CONFIG);
    const skill = fs.existsSync(SKILL_OUT)
      ? fs.readFileSync(SKILL_OUT, 'utf8')
      : renderTemplate(fs.readFileSync(SKILL_TPL, 'utf8'), cfg);
    const agent = fs.existsSync(AGENT_OUT)
      ? fs.readFileSync(AGENT_OUT, 'utf8')
      : renderTemplate(fs.readFileSync(AGENT_TPL, 'utf8'), cfg);
    res.json({ success: true, data: { skill, agent } });
  } catch (e) {
    console.error('[读取失败]', e.message);
    res.status(500).json({ success: false, message: '读取失败' });
  }
});

// 保存微调后的文件
router.put('/files/:type', authenticate, (req, res) => {
  const content = (req.body && req.body.content) != null ? String(req.body.content) : '';
  if (req.params.type === 'skill') writeText(SKILL_OUT, content);
  else if (req.params.type === 'agent') writeText(AGENT_OUT, content);
  else return res.status(400).json({ success: false, message: 'type 非法' });
  res.json({ success: true });
});

module.exports = router;
