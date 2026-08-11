# P390 · Human as Agent（人即智能体）

## 项目定位
让工程师作为「人肉大模型」接入现有多模型 Agent 调度框架。对外完全兼容 OpenAI 标准接口（`/v1/chat/completions`），上游调度池新增一条 `human-llm` 模型路由即可接入，**零代码改动**。涉密/私有逻辑任务经此路由派发给人工工程师，完成后按大模型格式返回，AI 工作链路不中断。

## 技术栈
- 后端：Node.js + Express + Socket.IO
- 数据库：PostgreSQL 5433（库名 `p390`，用户 postgres）
- 认证：JWT（jsonwebtoken + bcryptjs）
- 前端：Vanilla HTML/JS/CSS（IIFE 模块 + SVG 图标 + 4 套主题）

## 目录结构
```
server.js              # 入口：Socket.IO 认证 + 安全头 + 路由 + 超时扫描
db/
  index.js             # PG 连接 + 建表（users/tasks/task_logs/request_logs）
  adapters/pg.js       # pg 适配器（?→$n、INSERT RETURNING id）
  dialect.js           # 方言工具
middleware/
  auth.js              # authenticate / signToken / requireRole
  security.js          # 基础安全头（无 CSP/HSTS）+ CORS + 限流
routes/
  v1.js                # OpenAI 兼容：/v1/models + /v1/chat/completions
  auth.js              # 登录/me/改密
  users.js             # 工程师账户管理
  tasks.js             # 任务列表/详情/状态流转
  workbench.js         # 统计/我的任务/待接单队列
  logs.js              # 请求出入日志 + 任务审计
services/
  openaiEncoder.js     # 请求解析 + OpenAI 响应/SSE chunk 封装
  queueService.js      # 状态机 + 等待者唤醒 + 超时扫描
  websocket.js         # Socket.IO 推送（task:new/update/timeout）
public/                # 登录页 + 工作台（utils/api/ws/ui/app.js）
scripts/seed.js        # 种子账户
```

## 接口
### OpenAI 兼容（上游直连）
- `GET  /v1/models` → `human-llm` + AI 中继模型列表
- `POST /v1/chat/completions` → 支持 `stream:false` 一次性返回 与 `stream:true` SSE 流式
- **AI 降级路由**：model 匹配 `AI_RELAY_MODELS`（如 `deepseek-v4-flash`）→ 中继转发到真实 LLM（DeepSeek）；否则走人工
- **AI 提审批** `POST /v1/approvals` → 申请服务器/环境/权限等资源，挂起等待人类批准/驳回，返回审批结果（`status: approved|rejected` + 人类提供说明）
- 可选 `UPSTREAM_API_KEY` 校验（配置后需 `Authorization: Bearer <key>`）

### 工作台（JWT 认证）
- `POST /api/auth/login`（admin/engineer1/engineer2，密码 admin123）
- `POST /api/auth/register`（用户名/邮箱/密码；`USER_REGISTER_MODE` 控制 open 注册即用 / audit 管理员审核启用）
- `POST /api/auth/forgot-password`（用注册邮箱重置密码，向该邮箱发新密码；SMTP 可配置）
- `/api/workbench/summary | queue | mine`
- `/api/tasks` + `/api/tasks/:id/{claim|complete|reject|pause|resume|requeue|reopen|cancel|project}`
- `/api/approvals` + `/api/approvals/:id/{approve|reject}`（审批列表/批准并提供资源/驳回）
- `/api/projects` + `/api/projects/apply`（项目列表/管理员创建/申请建项目走审批）
- `/api/logs/requests | tasks`、`/api/users`

## 任务状态机
`pending → processing → completed | returned | paused`；驳回/超时 → `returned` 可改上下文重派（`pending`）。
超时：待接单默认 60 分钟、处理中默认 120 分钟（`.env` 可调），由 `queueService.startTimeoutScanner()` 每 30 秒扫描。
超时降级：**待接单超时无人接单 → 自动用 AI 代答**（`aiRelay` 中继 DeepSeek，带 `aiRelay:true` 标记）完成兜底；AI 不可用则回落 `returned` + 告警。处理中超时仍 `returned`。

## 审批状态机
`pending → approved | rejected`（AI 提审批 → 人类批准并提供资源 / 驳回并附原因 → 返回结果给 AI）。待审批超 24h 自动提醒。产出质量：complete 时校验空/过短/占位乱答；`reopen` 打回重做（completed → returned）。

## 环境变量（.env）
`PORT=39000`、`DB_TYPE=pg`、`PG_DATABASE=p390`、`JWT_SECRET`、`HUMAN_LLM_MODEL=human-llm`、
`TASK_PENDING_TIMEOUT_MIN`、`TASK_PROCESSING_TIMEOUT_MIN`、`UPSTREAM_API_KEY`(可选)、
`AI_RELAY_ENABLED`、`AI_RELAY_BASE_URL`、`AI_RELAY_API_KEY`、`AI_RELAY_MODELS`、
`USER_REGISTER_MODE`(open/audit)、`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`(邮件，可选)、
`NOTIFY_EMAIL_TO`、`NOTIFY_WEBHOOK_URL`(通知渠道：邮件收件人/企微钉钉webhook，可选)

## 命令
- `npm install` → `npm run seed` → `npm start`（监听 `0.0.0.0:39000`）
- 工作台：`http://192.168.168.3:39000`（login.html）
- OpenAI 接口：`http://192.168.168.3:39000/v1/chat/completions`

## 默认账户
- 管理员：admin / admin123
- 工程师：engineer1 / engineer2 / admin123

## 前端规则
- API 地址用 `window.location.origin`；SVG 图标；4 套主题（浅/暖/莫兰迪/深）默认浅色
- 模块 IIFE + `window.HLM.*`；加载顺序 utils → api → ws → ui → app
- 响应式：PC 横/竖、平板、手机（≤768 侧栏抽屉）
