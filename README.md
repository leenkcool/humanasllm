# Human as Agent（人即智能体）

让工程师作为「人肉大模型」接入多模型 Agent 调度框架。对外完全兼容 **OpenAI 标准接口**（`/v1`），调度池新增一条 `human-llm` 模型路由即可接入，**零代码改动**。涉密/私有/需人工判断的任务经此路由派发给人工工程师，完成后按大模型格式返回，AI 工作链路不中断。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## ✨ 特性

- **OpenAI 兼容**：`/v1/chat/completions`（一次性 + SSE 流式）+ `/v1/approvals`（AI 提审批）。**异步受理**：立即返回 `task_id`，人工完成后 `GET /v1/tasks/:id` 回查
- **治理层**（Human-as-LLM 的核心）：分级策略引擎（**涉密/运维白名单锁死，禁 AI 兜底**）、审批异步化、质量验收分类、审计哈希链（防篡改）、合规报告（数据不出网关证明）、工程师评级
- **多租户**：`upstream_key` 路由租户，任务/审批/项目/规则数据隔离
- **多工具安装**：为 13 种 AI Agent 工具（Claude Code / Codex / OpenCode / Gemini / Cursor / Windsurf / Aider / WorkBuddy / OpenClaw / Hermes / Pi 等）一键生成 SKILL / AGENT / 规则，支持在线微调、本机全装、服务器端安装
- **智能漂移**：general 简单任务可自动 AI 承接（可开关），涉密类锁死
- **测试体系**：34 项单元/集成测试 + 30 项 API 回归，关键安全边界全覆盖

## 🚀 快速开始

```bash
npm install
npm run seed      # 建表 + 种子账户（admin / engineer1 / engineer2，密码 admin123）
npm start         # 监听 0.0.0.0:39000
```

- 工作台：`http://<你的服务器IP>:39000/login.html`
- OpenAI 接口：`http://<你的服务器IP>:39000/v1/chat/completions`
- 健康检查：`GET /api/health`

> 数据库：PostgreSQL（库 `p390`）。配置见 `.env`（复制 `.env.example` 调整，**改掉 `JWT_SECRET`**）。

## 🔌 接入多模型调度池

在调度池/Agent 框架里新增一条模型路由指向本网关：

| 模型 | 用途 |
|---|---|
| `human-llm` | 涉密/需人工任务 → 派发人工工程师 |
| `deepseek-v4-flash`（可配） | 常规任务 → 中继到真实 LLM |

```jsonc
{ "models": [
  { "id": "human-llm",         "base_url": "http://<你的服务器IP>:39000/v1" },
  { "id": "deepseek-v4-flash", "base_url": "http://<你的服务器IP>:39000/v1" }
] }
```

请求体与标准 OpenAI `chat/completions` 一致，可附业务扩展字段：`category`（general/confidential/ops）、`project_code`、`priority`、`skills`、`meta_tags`。

## 🖥️ 工作台

| 页面 | 能力 |
|---|---|
| 工作台 | 任务统计、治理概览、工程师评级、未完成列表 |
| 任务队列 | 接单/完成/驳回/重派/打回重做、技能匹配标记、分级理由 |
| 审批 | AI 资源/项目申请 → 批准（提供资源）/驳回 |
| 项目 | 项目管理 + 申请建项目走审批 |
| 接入配置 | 网关配置 + 多工具 SKILL/AGENT 生成与微调 |
| 需求/PRD | 二次开发需求沉淀到 PRD.md（git 账号身份提交） |
| 用户/日志 | 用户管理（含技能/租户/一次通过率）、审计 |

## 🧩 二次开发

- **约定**：见 [`AGENT.md`](AGENT.md)——AI Agent 二次开发原则 + **PRD 记录铁律**（验证过的需求必须沉淀到 `PRD.md`）
- **沉淀**：见 [`PRD.md`](PRD.md)——全部验证过的功能需求
- 提交前必须通过：`npm test` + `npm run test:smoke`

## 📚 文档

- [部署手册（Windows/Linux）](docs/DEPLOY.md)
- [接口文档](docs/API.md)
- [人工路由场景分级](docs/HUMAN_ROUTES.md)
- [治理层规划](docs/GOVERNANCE.md)
- [上游接入指南](docs/UPSTREAM_INTEGRATION.md)
- [测试方案](docs/TESTING.md)
- [项目全览](docs/PROJECT_OVERVIEW.md)

## 💬 支持与交流

本项目支持微信 / QQ 交流群：**6181193**。二次开发、问题反馈、需求讨论欢迎加入。

## 📄 License

[MIT](LICENSE)
