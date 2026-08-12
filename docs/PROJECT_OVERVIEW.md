# P390 · 人工代理网关（Human-as-LLM）— 项目全览与初衷汇总

> 本文档用于完整呈现本项目：**用户初衷 → 设计理念 → 已交付功能全景 → 接口清单 → 实测验证记录 → 技术架构 → 现状与边界**。可供任何大模型独立阅读并点评。

---

## 一、用户初衷（完整汇总）

### 1.1 原始业务需求（项目立项时的拆解）

**背景**
- AI-Agent 与外部定制化开发已普及，多模型路由调度成为开发工具标配：复杂架构/长周期规划 → Claude-Opus5；简单编码/快速实现 → DeepSeek-V4-Flash。
- 存在第三类任务：**涉密数据、敏感业务、私有内部逻辑、不可外传需求** —— 禁止交给公有大模型，必须由人工工程师接手。

**痛点**
- 现有 Agent 调度框架只支持调用各模型标准 LM-API。
- 遇到需人工处理的任务时：整条工作链路**直接暂停、卡死**；没有统一入口承接人工任务，无法与整套 AI 调度体系无缝打通。

**核心目标**
- 搭建 **Human-as-LLM 人工代理网关**：对外完全遵循 **OpenAI-Style 大模型接口规范**，上游 Agent/调度器**无需区分**返回源是人还是 AI。
- 请求转入后，系统接管全部上下文、提示词、参数、业务需求，派发给后端人工工程师手动完成编码/任务处理；最终由接口返回与大模型格式一致的响应，**继续走完 Agent 工作链路**。

**完整运行流程（用户设想）**
1. 上层调度网关/Agent 判断任务涉密或含私有逻辑 → 路由指向「人工-LLM 代理接口」；
2. 上游发送标准 Chat-Completion 请求（prompt、完整对话上下文、历史消息、参数、文件、附属元数据）；
3. 代理接口接收全部请求，解析所有上下文；
4. 将任务下发、推送至工程师任务工作台；
5. 工程师人工阅读需求与上下文，手动完成代码编写或任务输出；
6. 工作台将人工产出回传给代理接口；
7. 接口按标准大模型 JSON 结构封装返回值，返回上游网关；
8. Agent 链路继续正常往下执行，**上层业务无感知后端实际是人类在输出**。

**接口硬性要求**
- 完全兼容通用 LM（OpenAI）RESTful 接口：路径、请求体、返回结构体、流式输出字段一致，可直接放进现有多模型路由配置，**上游零代码改动**；
- 支持普通一次性返回 + `stream` 流式返回；
- 完整透传上下文、历史对话、系统提示词、附带文件、元标签、任务优先级、项目编号；
- 任务状态管理：待接单 / 工程师处理中 / 已完成 / 驳回重写 / 超时告警；
- 多工程师分配、任务排队、超时阻塞控制。

**业务分层定位**
- 复杂规划 → Claude-Opus5；简易代码 → DeepSeek-V4-Flash；**敏感涉密任务 → Human-LLM 人工代理接口**。

**隐性需求**
- 上游调度层不改代码，仅新增一条模型路由即可接入；
- 可区分人工任务，保存完整请求日志、人工输出日志；
- 支持任务暂停、驳回、二次修改上下文后重新派发。

**一句话总结（用户原话）**
> 搭建一个兼容标准大模型 API 的人工代理网关，让工程师作为「人肉大模型」接入现有多模型 Agent 调度框架：敏感涉密任务自动路由给人工编写，整条 AI 工作链路不中断停滞，上层程序无法分辨返回源是 AI 还是人类。

### 1.2 后续演化补充（开发过程中用户追加的设想）

| # | 追加需求 | 用户原意 |
|---|---|---|
| 1 | **AI 降级路由** | 借鉴 GitHub 上 `puppetllm` 的跨 provider 中继思路：模型名命中（如 `deepseek-v4-flash`）直接中继到真实 LLM；人工待接单超时无人接单自动 AI 代答兜底 |
| 2 | **humanllm 子代理** | 创建一个 Claude Code 子代理 `humanllm`：交给它的任务**自动派到平台**，由人类继续开发 |
| 3 | **写给人类的提示要比人给 AI 的更明示** | 人类没有 AI 的上下文：派单必须带 GIT 库位置、接单流程、环境约定、参考文件、**交人工原因标注**（安全原因/项目规则要求）；任务要**小而聚焦**；前端换行显示要兼容 |
| 4 | **乱答复处理** | 人工工程师乱答/占位时怎么办 → 提交质量校验 + 打回重做机制 |
| 5 | **AI 提审批** | agent 需要服务器/环境/权限等资源时**向人类提审批**，人类采购/准备后提供，agent 继续 |
| 6 | **注册 + 项目管理 + 任务归属** | 支持注册（名/邮箱/密码，无需邮箱验证；改密码用注册邮箱发邮件）；项目管理页（管理员管理，接单后把单子归到项目，申请建项目管理员审批）；agent 发需求带项目信息/项目ID |
| 7 | **注册双模式** | 互联网版=免费注册即用（演示娱乐）；企业版=管理员必须审核 |
| 8 | **SKILL + Agent 触发方式** | 为 agent 构建 SKILL；除 `@` 外还有哪些方式触发 agent；做一个丰富例子 |

### 1.3 用户的验收视角（隐含标准）
- 一切能力都必须**真实可运行、可验证**（每一功能都要求端到端实测）；
- 交付物要**像给人看的**：文档、路径、命令、原因标注齐全；
- 涉密/敏感场景优先走人工，常规走 AI，二者可在一个调度池中**零切换成本**共存。

---

## 二、设计理念

1. **人类即模型**：工程师是"人肉大模型"，通过 OpenAI 兼容接口伪装成 `human-llm`，融入现有 Agent 调度体系。
2. **上游零改动**：调度池只加一条模型路由（`human-llm` / `deepseek-v4-flash` 指向本网关），即获得"人工 + AI 中继"两种能力。
3. **人工代理生态闭环**：派单（humanllm 子代理）→ 资源申请（审批）→ 任务处理（工作台）→ 质量控制（校验/打回）→ 结果回传（OpenAI 结构）→ AI 降级兜底，形成完整人机协同链路。
4. **人类可执行**：一切派给人类的内容（任务包、审批单）都按"人类最小上下文"组织，明示原因与环境。

---

## 三、已交付功能全景（分层）

### A. 核心网关（OpenAI 兼容）
| 功能 | 说明 |
|---|---|
| `GET /v1/models` | 返回 `human-llm` + AI 中继模型列表（如 `deepseek-v4-flash`） |
| `POST /v1/chat/completions` | **异步受理**：`human-llm` 创建任务后立即返回 `task_id`（人工小时级，不阻塞）；上游凭 `GET /v1/tasks/:id` 回查结果；命中 `AI_RELAY_MODELS` 仍同步中继 |
| 上下文透传 | messages / 系统提示词 / 参数 / `project_code` / `priority` / `meta_tags` 全量落库并回显 |
| 上游鉴权 | 可选 `UPSTREAM_API_KEY`（配置后 /v1 需 Bearer 头） |
| 日志 | `request_logs`（in/out 请求）+ `task_logs`（状态审计留痕） |

### B. 任务工作台（Web UI）
| 页面 | 能力 |
|---|---|
| 工作台 | 任务统计（含**未完成聚合计数**）、**未完成任务列表**（防遗忘，人接单小时级）、待接单队列、**超时剩余时间倒计时** |
| 任务队列 | 全量/筛选；接单/完成/驳回/暂停/重派/**打回重做**/取消；详情看完整上下文 |
| 我的任务 | 我接单处理的 |
| 审批 | AI 资源/项目申请 → 批准（提供资源）/驳回；**24h 超时提醒** |
| 项目 | 列表；管理员新建/编辑/归档；任何人**申请建项目**（走审批，批准自动创建）；任务可归属项目 |
| 请求日志 | 请求入参/人工输出、任务审计轨迹 |
| 用户管理 | 管理员维护工程师/管理员、启停、重置密码 |
| **任务场景分级** | 上游 `category`（general/confidential/ops）标记；涉密/运维类**禁 AI 兜底**、超时回落 returned；列表/详情标签展示；CSV 导出含 category（详见 [HUMAN_ROUTES.md](./HUMAN_ROUTES.md)） |

**任务状态机**
`pending → processing → completed | returned | paused`；驳回/超时 → `returned` 可改上下文重派；`completed` 产出不合格可**打回重做**（`completed → returned`）；待接单超时无人接单 → 自动 AI 兜底代答。
**质量校验**：提交结果时拦截空/过短（<20 字）/占位词。

### C. 人工代理生态
| 组件 | 能力 |
|---|---|
| `humanllm` 子代理（`.claude/agents/humanllm.md`） | 收到任务 → 整理成**完整上下文包**（【任务】【交人工原因】【项目与代码库】【接单流程】【环境约定】【要求】）→ 提交网关 → 人工完成后**逐字回传**；任务需外部资源时**先经 /v1/approvals 提审批**，批准后把人类提供的资源附进任务包 |
| `dispatch-human` Skill（`.claude/skills/dispatch-human/SKILL.md`） | humanllm 触发入口（Trigger/Steps/Verification 三段式；附 `agent_type` 硬绑定变体） |
| 质量闭环 | 提交质量校验 + 打回重做 + 驳回重派 + 审计留痕 |
| AI 降级 | 模型名路由中继 + 人工超时自动 AI 代答（`aiRelay`，DeepSeek） |

### D. 账户 / 项目 / 扩展
| 功能 | 说明 |
|---|---|
| 注册 | 用户名/邮箱/密码；`USER_REGISTER_MODE=open`（注册即用）或 `audit`（管理员审核启用） |
| 忘记密码 | 输入注册邮箱 → 重置密码并发邮件（`mailer`，SMTP 可配置，未配置降级返回演示密码） |
| 项目管理 | `/api/projects` 管理员 CRUD/归档；`/api/projects/apply` 申请走审批，批准自动建项目 |
| 任务归属项目 | `POST /api/tasks/:id/project`；列表/详情 join projects 展示项目名 |
| CSV 导出 | `GET /api/tasks/export`、`GET /api/approvals/export`（utf-8 BOM，Excel 兼容）+ 前端导出按钮 |

### E. 运维
- `bg.ps1` 服务托管；`scripts/demo-client.js` 调度池对接演示脚本；README 使用文档。

---

## 四、接口清单

### OpenAI 兼容（上游直连）
```
GET  /v1/models
POST /v1/chat/completions        # 异步受理：立即返回 task_id + status:pending；可选 category 标记场景（general/confidential/ops）
GET  /v1/tasks/:id               # 回查：凭 task_id 取回人工产出/驳回原因/处理中
POST /v1/approvals               # AI 提审批（资源/项目申请），挂起等待人类审批
```

### 工作台（JWT 认证）
```
POST /api/auth/login | register | forgot-password
PUT  /api/auth/password
GET  /api/workbench/summary | queue | mine
GET  /api/tasks  + POST /api/tasks/:id/{claim|complete|reject|pause|resume|requeue|reopen|cancel|project}
GET  /api/tasks/export
GET  /api/approvals + POST /api/approvals/:id/{approve|reject}  + GET /api/approvals/export
GET  /api/projects + POST /api/projects/{apply} + PUT /api/projects/:id + POST /api/projects/:id/archive
GET  /api/logs/requests | tasks
GET  /api/users (+POST/PUT/DELETE)
```

---

## 五、实测验证记录（全部真实运行）

| 场景 | 结果 |
|---|---|
| 一次性返回（人工产出封装 OpenAI 结构） | ✅ choices[0].message.content = 人工产出 |
| stream SSE（role 首块 → 分块 → stop → [DONE]） | ✅ |
| 任务状态机全链路（create→processing→completed/returned→重派→completed） | ✅ 审计留痕完整 |
| 非法状态流转拦截 | ✅（如 returned→returned 报错） |
| 人工超时自动 AI 降级（mock AI 验证成功路径） | ✅ completed + aiRelay 标记 |
| 模型名路由 AI 中继（真实 DeepSeek 转发） | ✅ 路由通（余额不足返回 502，外部因素） |
| AI 提审批：批准 + 驳回两路径 | ✅ 返回 approved/provided 与 rejected/reject_reason |
| 审批 24h 超时提醒 | ✅ socket 收到 approval:overdue |
| humanllm 子代理端到端（含完整上下文包） | ✅ 任务含 GIT/接单/环境/原因 |
| humanllm 资源审批预检（提审批→批准→附资源派单） | ✅ 任务包含已批准资源（192.168.168.60） |
| dispatch-human skill 链路 | ✅ 派单→完成→回传，子代理实测核验（BOM/401/转义） |
| 注册（open 即用）/ 忘记密码（SMTP 降级演示密码） | ✅ |
| 项目管理（管理员建 + 申请审批自动建） | ✅ |
| 任务归属项目 + 列表展示项目名 | ✅ |
| 质量校验拦截占位提交（400）/ 打回重做 | ✅ |
| CSV 导出（BOM/转义/401 鉴权） | ✅ |
| 调度池演示（常规→AI 中继 / 涉密→人工任务） | ✅ |
| 全部工作台接口回归（health/models/workbench/tasks/logs/users/approvals/projects） | ✅ |

---

## 六、技术架构

- **后端**：Node.js + Express + Socket.IO
- **数据库**：PostgreSQL 5433（库 `p390`）：`users` / `tasks`(含 category 分级) / `task_logs` / `request_logs` / `approvals` / `projects`
- **认证**：JWT（jsonwebtoken + bcryptjs）；角色：admin / engineer
- **前端**：Vanilla HTML/JS/CSS（IIFE 模块 `utils/api/ws/ui/app`），SVG 图标，4 套主题，响应式（≤768 / 769-1024 / ≥1025 portrait）
- **服务**：`queueService`（状态机+等待者+超时扫描+AI 降级）、`approvalService`（审批状态机+超时提醒）、`aiRelay`（DeepSeek 中继）、`openaiEncoder`（OpenAI 封装）、`projectService`、`mailer`
- **配置**：`.env`（PORT/JWT/PG/UPSTREAM_API_KEY/TASK_TIMEOUT/AI_RELAY/USER_REGISTER_MODE/SMTP）

```
调度池/Agent ──OpenAI /v1──▶ p390 网关(39000)
        ▲                     │ 模型名路由：human-llm → 人工任务；deepseek → AI 中继
        │  OpenAI 结构返回     │ /v1/approvals → 审批单 → 人类批准/驳回
        └─────────────────────┘ 人工工程师工作台（接单/完成/驳回/打回/审批/项目）
```

---

## 七、现状与已知边界（供评审参考，诚实说明）

1. **AI 中继真实返回依赖 DeepSeek 账户余额**：当前 `Insufficient Balance`，AI 降级成功路径已用本地 mock 验证；充值后即真实生效。
2. **邮件发送**：SMTP 未配置时降级为日志 + 返回演示密码（内部工具无邮箱服务器时的务实方案）；配 SMTP 后真发。
3. **浏览器像素级回归**：本环境无浏览器工具，四屏适配以 CSS 断点 + API 回归验证代替；建议在有浏览器工具的环境补一次视觉回归。
4. **服务托管**：`bg.ps1` 记录与管理进程，但进程仍随会话生命周期；长期常驻建议 `nssm`/Windows 服务/任务计划。
5. **安全**：按项目约定不启用 CSP/HSTS（仅 HTTP + 基础头）；若对外部署需补 HTTPS 与限流调优。
6. **humanllm 子代理**需在 Claude Code 新会话中生效（agent 列表为会话启动快照）。
7. **人工产出质量**靠"校验 + 打回"兜底，根治仍依赖工程师认真交付。

---

## 八、人工路由场景分级

完整判断标准、场景清单、`category` 分级策略与上游接入方式见 **[HUMAN_ROUTES.md](./HUMAN_ROUTES.md)**。一句话：涉密 / 需人工判断 / 物理世界 / 合规留痕类任务走人工，常规任务走 AI，二者在同一调度池零切换共存。

---

*文档生成于 p390 项目开发完成后，供独立评审。所有功能均有真实运行记录（见第五节）。*
