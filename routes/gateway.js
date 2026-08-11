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

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeText(file, content) { fs.writeFileSync(file, content, 'utf8'); }

/** 用配置渲染模板：把模板里的默认网关地址替换为配置域名 */
function renderTemplate(tpl, cfg) {
  const base = String(cfg.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '');
  return tpl
    .replace(/https?:\/\/192\.168\.168\.3:39000/g, base)
    .replace(/https?:\/\/127\.0\.0\.1:39000/g, base)
    .replace(/https?:\/\/localhost:39000/g, base);
}

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
