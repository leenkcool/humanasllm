# Human as Agent

**English | [中文](README.md)**

Turn engineers into a "human-as-a-service LLM" that plugs into your multi-model agent orchestration framework. Fully compatible with the **OpenAI standard API** (`/v1`) — add a single `human-llm` model route to your routing pool and you're in, with **zero code changes**. Confidential, private, and human-judgment-needed tasks get dispatched down this route to a human engineer, then returned in the standard LLM format — your AI pipeline never breaks.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## ✨ Features

- **OpenAI compatible**: `/v1/chat/completions` (one-shot + SSE streaming) + `/v1/approvals` (AI-initiated approval requests). **Async intake**: returns a `task_id` immediately; once a human finishes, poll `GET /v1/tasks/:id`
- **Governance layer** (the heart of Human-as-LLM): tiered policy engine (**confidential/ops whitelist locked down, no AI fallback**), async approvals, quality acceptance, tamper-proof audit hash chain, compliance reports (prove data never leaves the gateway), engineer ratings
- **Multi-tenant**: `upstream_key` routes tenants; task/approval/project/rule data fully isolated
- **Multi-tool install**: one-click SKILL / AGENT / rule generation for 13 AI agent tools (Claude Code / Codex / OpenCode / Gemini / Cursor / Windsurf / Aider / WorkBuddy / OpenClaw / Hermes / Pi, etc.), with online fine-tuning, local full-install, and server-side install
- **Smart drift**: simple `general` tasks can be auto-handled by AI (toggleable); confidential stays locked
- **Test suite**: 34 unit/integration tests + 30 API regression tests, full coverage of key security boundaries

## 🌐 Relationship to FDE (Forward Deployed Engineers)

**FDE (Forward Deployed Engineer)** is the hottest role in Silicon Valley in 2026, originating from Palantir's "cross-domain translator" model — engineers who combine technical, industry, and delivery skills, stationed on-site at enterprises to deeply integrate AI models with real business scenarios.

**Human as LLM is the "platformization" of FDE**: an FDE is one person; Human as LLM turns N FDEs into a model route in your routing pool that's callable on demand.

| FDE responsibilities | Human as LLM capabilities |
|---|---|
| On-site handling of confidential/private data | `confidential` tier locked to whitelist, context never leaves the gateway |
| Deployment, integration, operations | `ops` tier tasks go through the human route |
| Tasks needing human judgment, accountability, compliance trail | Tiering engine + approval flow + audit hash chain + compliance reports |
| Applying for customer resources/permissions | `/v1/approvals` AI asks → human approves/rejects |
| Scarce talent, one person can't serve many customers | `human-llm` route: zero-code agent integration, on-demand dispatch |

> In one line: **FDE solves "AI deployment lacks people"; Human as LLM solves "how human capacity gets scheduled, traced, and kept compliant by AI"** — they're upstream and downstream of each other.

## 🧭 Relationship to the AI Ecosystem

Almost every hot AI concept in 2026 says the same thing: **the more AI, the more human oversight is needed**. Human as LLM is exactly that "human oversight" **scheduling + governance infrastructure** — any AI ecosystem that connects automatically gets a callable, traceable, compliant human route.

| Concept | Hype / ecosystem reps | Human as LLM equivalent |
|---|---|---|
| **Agentic AI** | 2026's hottest trend (Andrew Ng, "from Agent to Agentic") | Add a `human-llm` human route to any agent; what AI can't do goes to a human |
| **Model Routing / LLM Gateway** | coai / ClawRouter / semantic-router | Human as LLM is a gateway: the route target can be a "human"; the tiering engine = governance-flavored semantic routing |
| **AgentOps / LLMOps** | mlflow / agentops / coze-loop | Others observe AI; Human as LLM governs "human agents": tiering / approvals / audit hash chain / quality acceptance |
| **Human-in-the-loop (HITL)** | AgentTeams / langchain | Protocolized HITL: `/v1` async intake + approval flow, zero-code, no per-task manual intervention |
| **Mixture of Agents (MoA)** | Together's official MoA | `human-llm` mixed with AI models in the routing pool = MoA's "human member" |
| **Data Flywheel** | Industry-proven methodology | Human output flows back into private eval sets / fine-tuning (Roadmap: "quality data assets") |
| **FDE (Forward Deployed Engineer)** | 2026's hottest role in Silicon Valley | The platformization of FDE — see section above |

> Positioning in one line: **Other tools make AI "smarter"; Human as LLM turns "humans" into models AI can call, trace, and keep compliant at any time — the human foundation of the AI ecosystem.**

## 🔒 Private Deployment

Built for enterprise private / intranet environments, with full data autonomy:

- **Data never leaves the gateway**: confidential/ops tasks locked by tier whitelist, no AI fallback, context never leaves the gateway
- **Self-hosted**: deploy on your own servers (Windows/Linux/pm2/systemd); data, keys, and logs stay entirely in your enterprise
- **Multi-tenant isolation**: each enterprise gets its own `upstream_key`; task/approval/project/rule data fully isolated
- **Compliance trail**: tamper-proof audit hash chain + one-click "data never leaves the gateway" compliance proof
- **Private model integration**: the AI relay accepts any OpenAI-compatible model (including private/local/open-source)
- **Intranet reachable**: listens on `0.0.0.0`, joinable from LAN/intranet into the routing pool
- **Offline-capable**: aside from the optional AI relay, the core human route depends on no external service

## 🚀 Quick Start

```bash
npm install
npm run seed      # creates tables + seed accounts (admin / engineer1 / engineer2, password admin123)
npm start         # listens on 0.0.0.0:39000
```

- Workbench: `http://<your-server-ip>:39000/login.html`
- OpenAI API: `http://<your-server-ip>:39000/v1/chat/completions`
- Health check: `GET /api/health`

> Database: PostgreSQL (database `p390`). Configure via `.env` (copy `.env.example` and adjust — **change `JWT_SECRET`**).

## 🔌 Plug into a Multi-Model Routing Pool

Add one model route pointing at this gateway in your routing pool / agent framework:

| Model | Purpose |
|---|---|
| `human-llm` | Confidential / human-needed tasks → dispatched to a human engineer |
| `deepseek-v4-flash` (configurable) | Routine tasks → relayed to a real LLM |

```jsonc
{ "models": [
  { "id": "human-llm",         "base_url": "http://<your-server-ip>:39000/v1" },
  { "id": "deepseek-v4-flash", "base_url": "http://<your-server-ip>:39000/v1" }
] }
```

The request body matches standard OpenAI `chat/completions`, with optional business extension fields: `category` (general/confidential/ops), `project_code`, `priority`, `skills`, `meta_tags`.

## 🖥️ Workbench

| Page | Capability |
|---|---|
| Dashboard | Task stats, governance overview, engineer ratings, pending list |
| Task queue | Claim / complete / reject / reassign / reopen, skill-match badges, tiering reasons |
| Approvals | AI resource/project requests → approve (with resources) / reject |
| Projects | Project management + apply for new projects via approval |
| Integrations | Gateway config + multi-tool SKILL/AGENT generation & fine-tuning |
| Requirements/PRD | Sink second-dev requirements into PRD.md (committed as your git identity) |
| Users/Logs | User management (skills/tenant/one-pass rate), audit |

## 🧩 Development

- **Conventions**: see [`AGENT.md`](AGENT.md) — AI agent development principles + **PRD recording rule** (validated requirements must be captured in `PRD.md`)
- **Sink**: see [`PRD.md`](PRD.md) — all validated feature requirements
- Must pass before committing: `npm test` + `npm run test:smoke`

## 🗺️ Roadmap

**Near term**
- 📱 Mobile / PWA + on-call duty: engineers claim tasks from phone, duty rotation
- 🧑‍💻 Multi-engineer scheduling: skill tags + load-balanced smart assignment
- 💰 Metering & billing: task cost accounting (human cost becomes measurable)
- 🛠️ Admin console: fine-grained RBAC, configurable audit

**Mid term**
- 🤖 Smart policy drift: AI capability assessment auto-tunes the `general` pool boundary (confidential stays locked)
- 📊 Quality data assets: human output feeds back into private eval sets / fine-tuning (within compliance)
- 🔔 Escalation sequence: on-call tiered escalation, timeout alerts

**Long term**
- 🌐 Human capability marketplace: external agent ecosystems plug in, governance-as-a-service
- 🏛️ Governance hub: approvals are human power, trails are human evidence, quality is the human standard, tiering is the human boundary

## 💬 Get Involved

- **Completely free**: open-source, MIT licensed, **free forever**, no paid plans
- **Share feedback**: found a bug, have an idea, want a feature — open an [Issue] or reach out directly
- **Help decide**: roadmap direction and feature trade-offs are open to everyone
- **Star / Fork**: ⭐ Star to support us, 🍴 Fork to build on it and contribute code
- **Higher collaboration efficiency**: AI commands, humans execute what AI can't — same routing pool, zero switching cost
- **More cross-agent approvals**: resource/permission approvals between agents, and between agents and humans — process-driven, traceable, auditable
- **Play without code**: especially friendly to **non-programmers** learning **Vibe Coding** — use natural language to get AI agents working, hand confidential/unsolvable tasks to a human, no barrier to entry

## 📚 Documentation

- [Deployment guide (Windows/Linux)](docs/DEPLOY.md)
- [API reference](docs/API.md)
- [Human-route scenario tiering](docs/HUMAN_ROUTES.md)
- [Governance layer plan](docs/GOVERNANCE.md)
- [Upstream integration guide](docs/UPSTREAM_INTEGRATION.md)
- [Testing strategy](docs/TESTING.md)
- [Project overview](docs/PROJECT_OVERVIEW.md)

## 💬 Support & Community

Join our QQ group: **6181193**. Welcome for development, bug reports, and feature discussions.

## 📄 License

[MIT](LICENSE)
