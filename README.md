# Human as Agent（人即智能体）

**[English](README.en.md) | 中文**

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

## 🌐 与 FDE（前沿部署工程师）的关系

**FDE（Forward Deployed Engineer，前沿/前置部署工程师）** 是 2026 硅谷最火岗位：源自 Palantir 的「跨界翻译官」模式——兼具技术、产业与落地能力，派驻企业现场，把 AI 模型与具体业务场景深度融合落地。

**Human as LLM 是 FDE 的「平台化」**：FDE 是一个人，Human as LLM 把 N 个 FDE 变成调度池里一条可随时调用的模型路由。

| FDE 职责 | Human as LLM 能力 |
|---|---|
| 派驻现场处理涉密/私有数据 | `confidential` 分级白名单锁死，上下文不出网关 |
| 部署、集成、运维落地 | `ops` 分级任务走人工路由 |
| 需人工判断、责任归属、合规留痕 | 分级引擎 + 审批流 + 审计哈希链 + 合规报告 |
| 向客户申请资源/权限 | `/v1/approvals` AI 提审批 → 人批/驳 |
| 稀缺人力，一人难服务多家 | `human-llm` 模型路由：Agent 零代码接入、按需调度 |

> 一句话：**FDE 解决「AI 落地缺人」，Human as LLM 解决「人的产能怎么被 AI 调度、怎么留痕、怎么合规」**——二者是上下游。

## 🧭 与 AI 生态的关系

2026 最热的 AI 概念几乎都在说同一件事：**AI 越多，越需要人把关**。Human as LLM 恰好是「人把关」的**调度 + 治理基础设施**——任何 AI 生态接入，都自动获得一条可随时调用、可留痕、可合规的真人路由。

| 概念 | 热度 / 生态代表 | Human as LLM 对应 |
|---|---|---|
| **Agentic AI**（智能体自主干活） | 2026 最热趋势（吴恩达「从 Agent 到 Agentic」） | 给任意 agent 加一条 `human-llm` 真人路由，AI 干不了的交给真人 |
| **Model Routing / LLM Gateway** | coai / ClawRouter / semantic-router | Human as LLM 即网关：路由目标可以是「人」；分级引擎 = 治理版语义路由 |
| **AgentOps / LLMOps** | mlflow / agentops / coze-loop | 别人观测 AI，Human as LLM 治理「人 agent」：分级 / 审批 / 审计哈希链 / 质量验收 |
| **Human-in-the-loop（HITL）** | AgentTeams / langchain | 协议化 HITL：`/v1` 异步受理 + 审批流，零代码接入，无需手工干预单个任务 |
| **Mixture of Agents（MoA）** | Together 官方 MoA | 调度池里 `human-llm` + AI 模型混编 = MoA 的「人类成员」 |
| **Data Flywheel（数据飞轮）** | 业界成熟方法论 | 人工产出回流私有评测集 / 精调（Roadmap「质量数据资产」） |
| **FDE（前沿部署工程师）** | 2026 硅谷最火岗位 | FDE 的平台化，详见上节 |

> 定位一句话：**别的工具把 AI 变成「更聪明」，Human as LLM 把「人」变成 AI 随时可调、可留痕、可合规的模型——AI 生态里的真人底座。**

## 🔒 私有化部署

面向企业私有化/内网环境，数据完全自主可控：

- **数据不出网关**：涉密/运维任务分级白名单锁死、禁 AI 兜底，上下文不出网关
- **自托管部署**：自有服务器部署（Windows/Linux/pm2/systemd），数据、密钥、日志全在本企业
- **多租户隔离**：各企业独立 `upstream_key`，任务/审批/项目/规则数据完全隔离
- **合规留痕**：审计哈希链防篡改 + 合规报告「数据不出网关」一键证明
- **私有模型接入**：AI 中继可接任意 OpenAI 兼容模型（含私有/本地/开源模型）
- **内网可达**：监听 `0.0.0.0`，局域网/内网即可接入调度池
- **离线可用**：除可选 AI 中继外，核心人工路由不依赖外部服务

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

## 🗺️ Roadmap

> 完整版见 [`docs/ROADMAP.md`](docs/ROADMAP.md)（含现状全景、体验诊断、开源变现规划）。此处仅留方向摘要。

**体验筑基（近期）**
- 🐳 Docker 一键部署（私有化落地门槛）
- 📡 SSE 中途状态推送 + 完成回调 webhook（告别手动轮询）
- 🛠️ tools / function calling（agent 调「人提供的函数」）
- 📱 移动端 / PWA + on-call 值班 + 超时告警升级序列

**企业就绪（中期）**
- 🔐 企业 SSO（OAuth2 / LDAP / 企微 / 钉钉）
- 🧑‍💻 多工程师负载均衡自动分配（技能标签已支持）
- 💰 计费计量（人力成本可核算）
- 📊 监控 /metrics + 数据备份 + 合规报告 PDF 导出

**生态变现（长期）**
- 🌐 人工能力市场（FDE 入驻 + 结算）
- 🔁 产出回流标注 → 私有评测集闭环（导出已落地）
- 🏛️ 治理中枢：审批是人的权力、留痕是人的证据、质量是人的标准、分级是人的边界

## 👥 作者

- **项目**：Human as Agent
- **作者 / 维护者**：leenkcool（leenk@126.com）
- **交流**：QQ 群 6181193 · 完整清单见 [AUTHORS.md](AUTHORS.md)

## 💬 参与进来

- **绝对免费**：本项目开源、MIT 协议，**永久免费**使用，无任何收费计划
- **多提意见**：发现 BUG、有想法、想加功能——欢迎提 [Issue] 或直接交流
- **多参与决策**：路线图的方向、功能的取舍，欢迎大家一起来定
- **多 Star / 多 Fork**：⭐ Star 支持我们，🍴 Fork 一起二次开发、贡献代码
- **提升协作效率**：让 AI 指挥、真人执行 AI 不能做的，同一调度池零切换成本
- **AI Agent 之间多互动审批**：Agent 与 Agent 之间、Agent 与人工之间的资源申请、权限审批，流程化、留痕、可回溯
- **零代码也能玩**：特别适合**不会写代码**的朋友学习 **Vibe Coding**——用自然语言让 AI Agent 干活，涉密/搞不定的交给真人，无门槛上手

## 📚 文档

- [路线图与开源规划](docs/ROADMAP.md)
- [部署手册（Windows/Linux）](docs/DEPLOY.md)
- [接口文档](docs/API.md)
- [人工路由场景分级](docs/HUMAN_ROUTES.md)
- [治理层规划](docs/GOVERNANCE.md)
- [上游接入指南](docs/UPSTREAM_INTEGRATION.md)
- [测试方案](docs/TESTING.md)
- [项目全览](docs/PROJECT_OVERVIEW.md)

## 💬 支持与交流

本项目支持 QQ 交流群：**6181193**。二次开发、问题反馈、需求讨论欢迎加入。

## 📄 License

[MIT](LICENSE)
