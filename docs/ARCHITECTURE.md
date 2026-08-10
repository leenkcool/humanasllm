# P390 · 技术架构

> 人工代理网关（Human-as-LLM）。Node.js + Express + Socket.IO + PostgreSQL。

## 一、技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js + Express 4 + Socket.IO |
| 数据库 | PostgreSQL 5433（库 `p390`，6 张表） |
| 认证 | JWT（jsonwebtoken + bcryptjs），admin / engineer 双角色 |
| 前端 | Vanilla HTML/JS/CSS（IIFE 模块，SVG 图标，4 主题，响应式） |
| AI 中继 | 原生 `fetch`（OpenAI 兼容，一次 + stream 透传） |
| 邮件 | nodemailer（SMTP 可配置，未配置降级） |
| 安全 | 基础头 + CORS + 限流（按项目约定禁 CSP/HSTS） |

## 二、目录结构

```
server.js            # 入口：Socket.IO 认证 + 安全头 + 路由 + 启动双扫描器
├── middleware/       # auth(JWT) / security(头+CORS+限流)
├── db/               # index(连接+建表+迁移) / adapters/pg / dialect
├── routes/           # v1(OpenAI) approvals projects tasks workbench auth users logs index
├── services/         # 业务核心（见下）
│   ├── stateMachine.js    # 状态机单例（任务/审批转换表 + 校验）
│   ├── waiters.js         # 等待者单例工厂（挂起等待/唤醒/超时）
│   ├── queueService.js    # 任务状态机流转 + AI 降级 + 质量校验 + 30s 超时扫描
│   ├── approvalService.js # 审批状态机 + 60s 超时提醒(24h)
│   ├── aiRelay.js         # DeepSeek 中继（shouldRelay/chat/relayStream）
│   ├── openaiEncoder.js   # OpenAI 响应 / SSE chunk 封装
│   ├── projectService.js  # 项目 CRUD + 审批批准回调
│   ├── mailer.js          # SMTP 邮件（降级）
│   └── websocket.js       # Socket.IO 推送
├── public/           # login.html + index.html + css + js(utils/api/ws/ui/app)
├── scripts/          # seed.js（建表+种子） demo-client.js（调度池演示）
├── data/             # 运行时文件（human_task.json 等，gitignore）
└── docs/             # PROJECT_OVERVIEW / API / ARCHITECTURE
```

## 三、核心机制

### 1. 请求生命周期（模型名路由 → 等待者 → 结果回传）

```mermaid
flowchart LR
  A[调度池 / Agent] -->|OpenAI 请求| B[POST /v1/chat/completions]
  B --> C{aiRelay.shouldRelay?}
  C -->|是 命中 AI_RELAY_MODELS| D[aiRelay 中继 DeepSeek]
  D -->|一次 / SSE 透传| A
  C -->|否 human-llm| E[创建人工任务 pending]
  E --> F[waiters.wait 挂起]
  F --> G[工作台工程师接单→完成]
  G --> H[resolveWaiter 唤醒]
  H --> I[封装 OpenAI 结构]
  I --> A
```

### 2. 任务状态机（单例 stateMachine）

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> processing : 接单
  pending --> returned : 超时/驳回
  pending --> completed : AI 降级代答
  processing --> completed : 提交结果
  processing --> returned : 驳回/超时
  processing --> paused : 暂停
  returned --> pending : 改上下文重派
  returned --> processing : 重新接单
  paused --> processing : 恢复
  completed --> returned : 打回重做(不合格)
  completed --> [*]
  cancelled --> [*]
```

### 3. 等待者（单例 waiters）

- `/v1/chat/completions` 与 `/v1/approvals` 进来后，`waiters.wait(id, timeout, onTimeout)` 注册挂起。
- 工程师/人类在 Web 端操作 → `waiters.resolve(id, result)` 唤醒，HTTP 请求继续返回。
- 超时 → `onTimeout()` 返回兜底（`timedOut: true`）。
- 任务与审批各自 `createWaiterStore()` 实例化（id 均为自增数字，避免 key 冲突）。

### 4. 双扫描器

| 扫描器 | 间隔 | 逻辑 |
|---|---|---|
| `queueService.startTimeoutScanner()` | 30s | 待接单超时 → AI 降级代答（失败回落 returned）；处理中超时 → returned |
| `approvalService.startApprovalScanner()` | 60s | 待审批超 24h → 广播 `approval:overdue` 提醒 |

### 5. 模型名路由

`routes/v1.js`：解析请求 → `aiRelay.shouldRelay(model)`：
- 命中 `AI_RELAY_MODELS`（如 `deepseek-v4-flash`）→ 中继转发真实 LLM（一次 `chat()` / SSE `relayStream()` 透传）；
- 否则走人工：`createTaskFromRequest` → 任务入队 → 挂起等待 → 人工产出封装返回。

### 6. 质量闭环

- **提交校验**：`completeTask` 先过 `qualityCheck`（空 / 过短<20 字 / 占位词 → 拦截 400）。
- **打回重做**：`completed → returned`（`reopenTask`），清空结果重新派发。
- **审计留痕**：`task_logs` 记录每一步（create/claim/complete/reject/reopen/timeout…）。

### 7. 实时推送

Socket.IO 房间模型（`user:*` / `admin` / `system`），事件：
- `task:new` / `task:update` / `task:timeout`
- `approval:new` / `approval:update` / `approval:overdue`

前端收到 → toast + 自动刷新（`public/js/ws.js` → `app.js`）。

## 四、数据模型（PostgreSQL / 库 p390）

| 表 | 关键字段 | 用途 |
|---|---|---|
| `users` | username, email, password, role(admin/engineer), name, is_active | 账户 |
| `tasks` | upstream_request_id, model, stream, priority, project_code, request_payload(JSONB), status, assignee_id, result_text, reject_reason, timeout_at, completed_at | 人工任务 |
| `task_logs` | task_id, action, old_value(JSONB), new_value(JSONB), actor_name, remark | 状态审计 |
| `request_logs` | task_id, direction(in/out), payload(JSONB), model | 请求/输出日志 |
| `approvals` | approval_no, type(resource/project), resource, amount, purpose, detail, status(pending/approved/rejected), provider_name, provided, reject_reason, decided_at | 审批单 |
| `projects` | code(unique), name, description, status(active/archived), created_by | 项目 |

**关系**：`tasks.project_code` → `projects.code`（列表 join 出 `project_name`）；`approvals.type=project` 批准后自动写入 `projects`。

## 五、关键设计点

1. **上游零改动**：调度池只加一条模型路由（`human-llm` / `deepseek-v4-flash`）即接入，无需区分人工/AI。
2. **双通道更新兼容**：`transition()` 的 update 值支持 `{__expr:'NOW()…'}`（拼 SQL 表达式）与参数绑定两种，避免注入且能写 `NOW()`/`interval`。
3. **数据库适配器**：`db.exec()→[{columns,values}]`、`db.run()→{changes,lastId}`，PG 自动 `?→$n` 与 `RETURNING id`；`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` 做兼容迁移。
4. **humanllm 子代理**（`.claude/agents/humanllm.md`）：任务包模板（【任务】【交人工原因】【项目与代码库】【接单流程】【环境约定】【要求】）+ 资源审批预检（第 0 步）。
