# P390 · API 接口规范

> 人工代理网关（Human-as-LLM）。OpenAI 兼容 `/v1/*`（上游直连）+ 工作台 `/api/*`（JWT 认证）。

## 通用约定

- **Base URL**：`http://192.168.168.3:39000`
- **Content-Type**：`application/json; charset=utf-8`
- **鉴权**：
  - `/v1/*`：可选 `UPSTREAM_API_KEY`（配置后需 `Authorization: Bearer <key>`）
  - `/api/*`：需 `Authorization: Bearer <JWT>`（登录获取）
- **错误格式**：
  - OpenAI 兼容错误：`{ "error": { "message", "type", "param", "code" } }`
  - 工作台错误：`{ "success": false, "message": "..." }`
- 成功格式（工作台）：`{ "success": true, "data": ... }`

---

## 一、OpenAI 兼容接口（上游直连）

### GET /v1/models
返回可用模型列表（人工 + AI 中继）。

```json
{ "object": "list", "data": [
  { "id": "human-llm", "object": "model", "owned_by": "p390" },
  { "id": "deepseek-v4-flash", "object": "model", "owned_by": "ai-relay" }
]}
```

### POST /v1/chat/completions
标准 OpenAI 请求体。**模型名路由**：`human-llm` → 人工任务；命中 `AI_RELAY_MODELS` → 中继真实 LLM。

**请求体**（标准字段 + 业务扩展）：
```json
{
  "model": "human-llm",
  "messages": [{ "role": "system|user|assistant", "content": "..." }],
  "stream": false,
  "max_tokens": 1024, "temperature": 0.7,
  "project_code": "internal-settlement",   // 业务扩展：项目编码（关联 projects）
  "priority": "high",                       // 业务扩展：high|medium|low
  "category": "confidential",               // 业务扩展：general|confidential|ops（涉密/运维类禁 AI 兜底）
  "meta_tags": { "source": "scheduler" },   // 业务扩展：元标签
  "callback_url": "https://agent.example.com/hook",  // 业务扩展：完成回调地址（可选，http/https）
  "stream_events": true,                    // 业务扩展：SSE 中途状态推送（需同时 stream:true，可选）
  "tools": [                                // 函数调用：声明人类可执行的函数（可选，OpenAI 格式）
    { "type": "function", "function": { "name": "restart_service", "description": "重启指定服务",
      "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } } }
  ]
}
```

**异步受理（人工任务）**：`human-llm` 任务创建后**立即返回**，/v1 不阻塞等待（人工接单为小时级）。响应为 OpenAI 结构 + `task_id` + `status: pending`：
```json
{ "id": "chatcmpl-xxx", "object": "chat.completion", "model": "human-llm",
  "choices": [{ "index": 0, "message": { "role": "assistant",
    "content": "任务已受理，task_id=12，待人工处理；可通过 GET /v1/tasks/12 查询结果" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "task_id": 12, "status": "pending" }
```

`stream:true` 默认同样立即返回受理信息（SSE `data:` 行 + `[DONE]`），不会等人工完成再流式输出。**若需中途状态推送，见下「中途状态推送」。**

**中途状态推送（opt-in，免轮询）**：`stream:true` **且** `stream_events:true` 时，连接保持打开，任务每次状态流转实时推送一帧，终态推 `data: [DONE]` 关闭：
```
data: {"object":"chat.completion.chunk","task_id":12,"status":"pending","event":"task.accepted", ...}

data: {"object":"task.event","event":"task.processing","task_id":12,"status":"processing", ...}

data: {"object":"task.event","event":"task.completed","task_id":12,"status":"completed","content":"<人工产出>", ...}

data: [DONE]
```
- 事件名 = `task.` + 状态：`task.accepted`（受理）｜`task.processing`（接单）｜`task.completed`｜`task.returned`｜`task.cancelled`｜`task.paused`（非终态，流继续）
- 每帧 = `{ object:'task.event', event, ...任务视图 }`（与回查字段一致，含 `tool_calls`/`finish_reason`）
- 保活：每 `SSE_HEARTBEAT_MS`（默认 15s）发一行 `: keep-alive` 注释，防代理超时断连
- 最长保持 `SSE_EVENTS_MAX_MIN`（默认 60 分钟），到点推 `task.stream_timeout` 后关闭，上游可继续凭 `task_id` 回查
- 不传 `stream_events` 时行为完全不变（对既有上游零破坏）

**回查结果**：人工完成后，上游凭 `task_id` 取回产出（见下节）。AI 中继模型（命中 `AI_RELAY_MODELS`）不受影响，仍同步返回真实 LLM 内容。

**完成回调（推荐，免轮询）**：请求体带 `callback_url`（仅接受 `http`/`https`），任务进入终态后主动 POST 结果到该地址，上游无需轮询 `GET /v1/tasks/:id`。
回调体 = `{ event, ...任务视图 }`，`event` ∈ `task.completed`｜`task.returned`｜`task.cancelled`：
```json
{ "event": "task.completed", "task_id": 12, "status": "completed", "content": "<人工产出>",
  "model": "human-llm", "priority": "low", "category": "general",
  "rule_id": 1, "rule_name": "合规备案安全", "category_source": "rule", "assignee": "工程师-张",
  "quality": { "completion_note": null }, "sla_remaining_sec": null,
  "timeout_at": null, "created_at": "…", "completed_at": "…" }
```
- 降级安全：投递失败只记服务端日志，不阻塞任务流转；地址非法（非 http/https）在建单时丢弃
- 开关：`CALLBACK_ENABLED`（默认 `true`）、超时 `CALLBACK_TIMEOUT_MS`（默认 `5000`）
- 注：`reopen`（打回重做）也回到 `returned` 终态，会再次回调
- 回调体与回查字段完全一致（同一视图），函数调用产出同样含 `tool_calls`/`finish_reason`

### 函数调用（tools / function calling）
上游在请求体声明 `tools`（OpenAI 函数定义），人类工程师在工作台选择函数并填参数提交，产出按 **OpenAI 原生 `tool_calls`** 返回，agent 直接执行即可。

- 人类可调用的函数**仅限本任务声明过的**，未声明一律 400 拒绝（防误填/越权）；`arguments` 必须是合法 JSON
- 有函数调用时 `content` 为 `null`、`finish_reason` 为 `tool_calls`（OpenAI 语义）
- 回查与完成回调**都**返回 `tool_calls`，`/v1` 侧无需额外解析

### GET /v1/tasks/:id
上游凭 `task_id` 查询人工任务处理结果（异步受理后轮询取回；配了 `callback_url` 则不必轮询）。
```json
{ "task_id": 12, "status": "completed", "content": "<人工产出>",
  "tool_calls": null, "finish_reason": "stop",
  "model": "human-llm", "priority": "low", "category": "general",
  "rule_id": 1, "rule_name": "合规备案安全",
  "category_source": "rule", "assignee": "工程师-张",
  "quality": { "completion_note": null },
  "sla_remaining_sec": 3480, "timeout_at": "…",
  "audit": { "valid": true },
  "created_at": "…", "completed_at": "…" }
```
函数调用产出时（`content: null`）：
```json
{ "status": "completed", "content": null, "finish_reason": "tool_calls",
  "tool_calls": [ { "id": "call_56b0017c1b34dcc9", "type": "function",
    "function": { "name": "restart_service", "arguments": "{\"name\":\"nginx\"}" } } ] }
```
- `status: completed` → `content` 为人工产出（或 `tool_calls`）；`returned` → 驳回原因；`cancelled` → 已取消；`pending|processing|paused` → 处理中
- **进度**：`priority` 优先级、`assignee` 当前处理人、`timeout_at` SLA 截止、`sla_remaining_sec` 剩余秒数（无 SLA 或已终态为 `null`）
- **治理决策**（阶段三）：`rule_id`/`rule_name` 分级规则、`category_source`（rule=规则锁定 / manual=人工或默认）、`quality.completion_note` 质量验收说明、`audit.valid` 审计哈希链健康

### GET /v1/governance/rules
治理 API：上游可查当前租户可见的分级规则（全局 + 租户专属），理解什么会被人工拦截。
```json
{ "object": "list", "data": [ { "id": 1, "name": "合规备案安全", "category": "confidential",
  "match_field": "content", "keywords": "备案,等保,…", "priority": 10 } ] }
```

### POST /v1/approvals
AI 向人类提审批（资源/权限/项目申请），**异步受理**：创建后立即返回 `approval_no`，不阻塞等待（人类审批是小时级），凭它回查结果。

**请求体**：
```json
{ "resource": "PostgreSQL 测试服务器", "amount": "2C4G / 50G",
  "purpose": "部署生产实例", "detail": "…", "requester": "ai-agent",
  "project_code": "p390" }
```

**返回**（异步受理确认）：
```json
{ "id": "appr-xxx", "object": "approval", "resource": "…", "amount": "…",
  "status": "pending", "provided": null, "reject_reason": null, "decided_at": null,
  "message": "审批已受理，可通过 GET /v1/approvals/appr-xxx 查询结果" }
```
- `id` = `approval_no`，凭它回查结果（见下）

### GET /v1/approvals/:id
上游凭 `approval_no`（或工作台凭 db id）查询审批结果。
```json
{ "success": true, "data": { "id": …, "approval_no": "appr-xxx", "status": "approved",
  "provided": "已批准：192.168.168.60…", "reject_reason": null, "decided_at": "…" } }
```
- `status: approved` → `provided` 为人类提供的资源/说明
- `status: rejected` → `reject_reason` 为驳回原因
- `status: pending` → 仍待审批，继续轮候
- 认证：上游带 `UPSTREAM_API_KEY` 或工作台带 JWT（双认证）

---

## 二、工作台 API（JWT 认证）

### 认证
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `{token, user}` |
| POST | `/api/auth/register` | `{username, email, password, name?}`；`USER_REGISTER_MODE=open` 返回 token 直接登录；`audit` 返回待审核 |
| POST | `/api/auth/forgot-password` | `{email}` → 重置密码并发邮件（SMTP 未配置返回 `demoPassword`） |
| PUT | `/api/auth/password` | `{oldPassword, newPassword}` 改密 |
| GET | `/api/auth/me` | 当前用户信息 |

### 工作台统计 / 任务
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workbench/summary` | 各状态计数 + 在线工程师 |
| GET | `/api/workbench/queue` | 待接单队列（按优先级排序，含 `project_name`） |
| GET | `/api/workbench/mine` | 我接单的任务 |
| GET | `/api/tasks?status=&priority=&assignee=&page=&size=` | 任务列表（含 `assignee_name`/`project_name`） |
| GET | `/api/tasks/:id` | 任务详情（含 `request_payload`、`logs` 审计） |
| POST | `/api/tasks/:id/claim` | 接单（pending/returned → processing） |
| POST | `/api/tasks/:id/complete` | `{content}` 提交产出（质量校验：空/过短/占位拦截） |
| POST | `/api/tasks/:id/reject` | `{reason}` 驳回（→ returned，可重派） |
| POST | `/api/tasks/:id/pause` | `{reason?}` 暂停 |
| POST | `/api/tasks/:id/resume` | 恢复 |
| POST | `/api/tasks/:id/requeue` | `{request_payload?}` 改上下文重派（→ pending） |
| POST | `/api/tasks/:id/reopen` | `{reason}` 打回重做（completed → returned，管理员或原处理人） |
| POST | `/api/tasks/:id/cancel` | 取消 |
| POST | `/api/tasks/:id/project` | `{project_code}` 设置任务归属项目（空则清除） |
| GET | `/api/tasks/export` | 导出任务 CSV（utf-8 BOM） |

### 审批
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/approvals?status=` | 审批列表 |
| GET | `/api/approvals/:id` | 审批详情 |
| POST | `/api/approvals/:id/approve` | `{provided?}` 批准并提供资源；`type=project` 批准后自动建项目 |
| POST | `/api/approvals/:id/reject` | `{reason}` 驳回 |
| GET | `/api/approvals/export` | 导出审批 CSV |

### 项目
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects?status=` | 项目列表 |
| POST | `/api/projects` | 管理员直接创建 `{code, name, description?}` |
| POST | `/api/projects/apply` | `{code, name, description?}` 申请建项目（走审批，批准自动创建） |
| PUT | `/api/projects/:id` | 管理员更新 |
| POST | `/api/projects/:id/archive` | 归档 / 启用 |

### 日志 / 用户
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/logs/requests?task_id=&direction=&page=&size=` | 请求出入日志 |
| GET | `/api/logs/tasks?task_id=` | 任务审计日志 |
| GET | `/api/users?role=` | 用户列表（含 email） |
| POST | `/api/users` | 管理员创建 `{username, password, role, name}` |
| PUT | `/api/users/:id` | 管理员更新（角色/姓名/启停/重置密码） |
| DELETE | `/api/users/:id` | 删除 |

### 工单模板
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/templates?include_disabled=1` | 列表（当前租户可见：全局 `tenant_id IS NULL` + 租户专属）；`include_disabled` 仅 admin |
| GET | `/api/templates/:id` | 详情（跨租户 404） |
| POST | `/api/templates` | admin 新建 `{name*, description, category, priority, skills, project_code, system_prompt, payload_template, default_meta_tags, enabled}` |
| PUT | `/api/templates/:id` | admin 更新任意子集 |
| DELETE | `/api/templates/:id` | admin 软删（置 `enabled=false`，保留历史引用） |
| POST | `/api/templates/:id/apply` | `{overrides?: {messages, priority, skills, project_code, meta_tags, category, tools}}` → `{task_id, template_id}` |

> 模板只提供**默认值**，上游显式值优先；`category` 仅作「上游显式声明」交给分级引擎，**规则命中仍白名单锁死**，模板无法把涉密任务降级为 general。

### 智能派单
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dispatch/tasks/:id/suggest?limit=5` | 派单建议（只读）：候选人排序 + 打分理由 + `assignable` |
| POST | `/api/dispatch/tasks/:id/assign` | admin `{user_id?, dry_run?}` → 派单（`dry_run` 只返回建议） |
| GET | `/api/dispatch/workload` | admin：工程师负载概览 |

打分：`100 × (0.5×技能匹配 + 0.3×空闲负载 + 0.2×一次通过率)`；任务无技能要求时技能维度取中性 0.5；无历史时质量分按 0.7 兜底。派单复用 `claimTask`，走同一状态机与审计哈希链。

### 告警中心
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/alerts?status=active&level=&kind=&task_id=&page=&size=` | 告警列表（join `task_status` / `assignee_name`） |
| GET | `/api/alerts/stats` | `{active, acked, resolved, by_level{1..5}, by_kind, oldest_active_at}` |
| POST | `/api/alerts/:id/ack` | 确认（admin 或该任务处理人） |
| POST | `/api/alerts/:id/resolve` | admin 标记解决 |

五级告警：L1 SLA 过半 → L2 临近超时 → L3 已违约 → L4 驳回滞留 → L5 严重滞留。去重靠 `tasks.escalation_level` 原子递增，同级别只发一次。

### 计费计量
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/billing/overview` | 本期概览（总额/任务数/日均/时价均值/按分级/Top 项目） |
| GET | `/api/billing/statement?period=YYYY-MM` | 月度账单：按分级/项目/工程师/来源汇总 |
| GET | `/api/billing/ledger?period=&page=&size=` | 计费明细（分页） |
| GET | `/api/billing/export?period=` | CSV 导出（utf-8 BOM） |
| GET | `/api/billing/rates` | 费率列表（全局 + 本租户） |
| POST | `/api/billing/rates` | admin upsert 费率 |
| DELETE | `/api/billing/rates/:id` | admin 删除租户费率（全局只读） |
| POST | `/api/billing/settle` | admin 手工批量补结算 `{limit?}` |

计费规则：仅 `completed` 且人工参与的任务计费；AI 兜底/漂移记 0 分钟但仍写流水（`source=ai_relay|ai_shift`）；时长 = `completed_at - COALESCE(claimed_at, created_at)` 向上取整到 0.5 分钟；金额 = `max(时长×单价, 最低消费)`。金额单位统一为**分**。

### 合规报告 / 数据资产
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/audit/report` | 合规报告 JSON（**按租户过滤**）：分级分布 / AI 兜底核查 / 哈希链健康 / 审批统计 / 一次通过率 |
| GET | `/api/audit/report?format=html&lang=zh\|en` | 自包含 HTML 报告页（内嵌 CSS + `@media print`），浏览器打印即导出 PDF |
| GET | `/api/audit/dataset?category=` | 质量数据资产导出（NDJSON）；非 general 需 admin |

### 运维
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/metrics` | 可选 `METRICS_TOKEN` | Prometheus 指标（`prom-client`；未安装时自动降级为零依赖实现） |
| GET | `/api/backup/list` | admin | 备份历史（`data/backups/manifest.jsonl`） |
| POST | `/api/backup/run` | admin | 异步触发备份，进度走 Socket.IO `backup:progress` |
| GET | `/api/backup/status` | admin | 是否在跑 + 最近结果 |

### 多轮追问（会话）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` + `conversation_id` | 追问：挂到同一会话，`turn_index` 递增、`parent_task_id` 指向上轮；不传则新建会话 |
| GET | `/v1/tasks/:id` | 带会话的任务额外返回 `conversation.turns`（每轮问题+答复摘要） |

响应新增字段：`conversation_id`、`turn_index`（一次性返回与回查均有）。
约束：**追问继承首轮分级**（`confidential`/`ops` 不因追问内容变无害而降级）；非法/跨租户会话 400；上限 50 轮。

### 项目成员
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/members` | 成员列表（需为成员或 admin） |
| POST | `/api/projects/:id/members` | `{user_id, role}` 添加/更新（admin 或项目 owner） |
| DELETE | `/api/projects/:id/members/:userId` | 移除（admin/owner，成员可退出） |

建项目者自动成为 `owner`；历史项目无成员记录时按租户内可见（兼容）。

### 知识库
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/knowledge?scope=&category=&keyword=&page=&size=` | 列表（按可见性过滤） |
| GET | `/api/knowledge/:id` | 详情 |
| POST | `/api/knowledge` | `{title*, problem*, solution*, scope, category, project_code, tags, source_task_id}` |
| PUT | `/api/knowledge/:id` | 更新（作者或 admin） |
| DELETE | `/api/knowledge/:id` | 删除（作者或 admin） |
| GET | `/api/knowledge/similar?task_id=` 或 `?text=` | 相似历史答复（答复任务时参考） |
| GET | `/api/knowledge/from-task/:taskId` | 已完成任务的一键沉淀草稿（预填） |

**三级作用域**：`project`（仅项目成员 + admin）/ `tenant`（同租户）/ `global`（所有租户）。
**硬约束**：`confidential` 类只能 `project` 作用域或作者私有，永不进共享池。
`/v1/chat/completions` 可选 `use_knowledge: true`（默认关闭）：命中 global/tenant 且相似度 ≥0.7 直接返回，`source: "knowledge"`。

### 答复审核
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/reviews/pending` | JWT | 待审核队列 |
| GET | `/api/reviews/spot-check` | admin | 待抽检队列（confidential 已放行） |
| GET | `/api/reviews/stats` | JWT | 审核统计 + 平均分 |
| GET | `/api/reviews/:taskId` | JWT | 某任务审核记录 |
| POST | `/api/reviews/:taskId/approve` | JWT | `{scores:{completeness,accuracy,actionable,boundary}, note}` 审核通过并放行 |
| POST | `/api/reviews/:taskId/revision` | JWT | `{reason}` 退回修改 |
| POST | `/api/reviews/:taskId/resubmit` | 处理人 | 重新提交（回到待审） |
| POST | `/api/reviews/:taskId/spot-check` | admin | `{pass, note}` 抽检 |

**分级策略**：`general` 免审（直接放行）；`ops`/`confidential` 单人审核；`confidential` 另加 admin 抽检（不阻塞放行）。不能审核自己的答复。
**上游可见性**：未放行时 `/v1/tasks/:id` 的 `content` 返回「答复待审核」，`review_status` 为 `reviewing`/`needs_revision`/`delivered`。

### 答复效果回流
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/tasks/:id/feedback` | `{resolved*, rating?, comment?}` 上游回传是否解决（幂等覆盖） |
| GET | `/api/workbench/feedback` | 答复有效率统计（总数/已解决/百分比/平均分，按分级与工程师拆分） |

`resolved=false` 且在 7 天内完成且无后续轮次 → **自动重开为同会话追问**（返回 `reopened_task_id`）。

---

## 三、错误码

| 场景 | HTTP | 响应 |
|---|---|---|
| 上游 key 无效 | 401 | `{error:{message:"Invalid API key provided."}}` |
| 请求体非法 | 400 | `{error:{message:"Invalid 'messages'…"}}` |
| 质量校验拦截 | 400 | `{success:false, message:"产出过短…"}` |
| 非法状态流转 | 400 | `{success:false, message:"非法状态流转: …"}` |
| 项目编码已存在 | 400 | `{success:false, message:"项目编码已存在"}` |
| 无权限 | 403 | `{success:false, message:"无权限…"}` |
| AI 中继失败 | 502 | `{error:{message:"AI 中继失败: …"}}` |
| 未认证 | 401 | `{success:false, message:"登录已过期"}` |
