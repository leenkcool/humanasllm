# P390 · 人工代理网关（Human-as-LLM）

让工程师作为「人肉大模型」接入现有多模型 Agent 调度框架。对外完全兼容 **OpenAI 标准接口**，调度池新增一条 `human-llm` 模型路由即可接入，**零代码改动**。涉密/私有逻辑任务经此路由派发给人工工程师，完成后按大模型格式返回，AI 工作链路不中断。

同时提供 **AI 提审批**（agent 需服务器/权限等资源时向人类申请）、**AI 降级**（模型名路由 / 人工超时自动 AI 兜底）、**项目管理**与**注册**等能力。

---

## 快速开始

```bash
npm install
npm run seed      # 建表 + 种子账户（admin/engineer1/engineer2，密码 admin123）
npm start         # 监听 0.0.0.0:39000
```

- 工作台：`http://192.168.168.3:39000/login.html`
- OpenAI 接口：`http://192.168.168.3:39000/v1/chat/completions`

> 数据库：PostgreSQL 5433 / 库 `p390`（密码见 `.env` 的 `PG_PASSWORD`）。

---

## 一、接入多模型调度池（上游零改动）

在调度池/Agent 框架里新增一条模型路由指向本网关即可：

| 模型 | 用途 | 指向 |
|---|---|---|
| `human-llm` | 涉密/私有/需人工任务 → 派发人工工程师 | `http://192.168.168.3:39000/v1` |
| `deepseek-v4-flash` | 常规任务 → **中继**到真实 DeepSeek | 同上 |

```jsonc
// 调度池配置示例（示意）
{
  "models": [
    { "id": "human-llm",           "base_url": "http://192.168.168.3:39000/v1" },
    { "id": "deepseek-v4-flash",   "base_url": "http://192.168.168.3:39000/v1" }
  ]
}
```

请求体与标准 OpenAI `chat/completions` 完全一致（含 `stream` 流式）。请求可附带业务扩展字段：`project_code`、`priority`、`meta_tags`（自动透传并用于任务归属/标记）。

### 1.1 人工任务（涉密走人工）

```bash
curl -X POST http://192.168.168.3:39000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "human-llm",
    "messages": [
      { "role": "system", "content": "涉密需求：内部结算逻辑" },
      { "role": "user", "content": "用 Node.js 实现对账脚本，需幂等与鉴权" }
    ],
    "project_code": "internal-settlement",
    "priority": "high",
    "stream": false
  }'
```

网关创建人工任务 → 工作台接单 → 完成后返回标准 `chat.completion`（`choices[0].message.content` 为人工产出）。

### 1.2 AI 中继（常规走 AI）

把上面 `model` 换成 `deepseek-v4-flash` 即中继到真实 DeepSeek，响应原样透传（含 stream）。

### 1.3 AI 提审批（agent 向人类要资源）

```bash
curl -X POST http://192.168.168.3:39000/v1/approvals \
  -H "Content-Type: application/json" \
  -d '{
    "resource": "PostgreSQL 测试服务器",
    "amount": "2C4G / 50G",
    "purpose": "部署网关生产实例",
    "requester": "ai-agent",
    "project_code": "p390"
  }'
```

挂起等待人类在审批页批准/驳回，返回：

```json
{ "id": "appr-xxx", "object": "approval", "resource": "PostgreSQL 测试服务器",
  "status": "approved", "provided": "已批准：192.168.168.50…", "decided_at": "…" }
```

### 1.4 上游鉴权（可选）

`.env` 配置 `UPSTREAM_API_KEY` 后，`/v1/*` 需携带 `Authorization: Bearer <key>`。

---

## 二、人工工程师工作台

`http://192.168.168.3:39000/login.html`

| 页面 | 能力 |
|---|---|
| 工作台 | 任务统计、待接单队列、超时剩余时间倒计时 |
| 任务队列 | 全部任务、筛选、接单/完成/驳回/暂停/重派/**打回重做**/取消、详情看完整上下文 |
| 我的任务 | 我接单处理的 |
| 审批 | AI 资源/项目申请 → 批准（提供资源）/驳回 |
| 项目 | 项目列表；管理员新建/编辑/归档；任何人**申请建项目**（走审批，批准自动创建）；任务可归属项目 |
| 请求日志 | 请求入参/人工输出、任务审计轨迹 |
| 用户管理 | 管理员维护工程师/管理员账户、启停、重置密码 |

任务状态机：`pending → processing → completed | returned | paused`；驳回/超时 → `returned` 可改上下文重派；`completed` 产出不合格可**打回重做**。待接单超时无人接单 → 自动 AI 兜底代答。

---

## 三、humanllm 子代理 + dispatch-human Skill

**humanllm 子代理**（`.claude/agents/humanllm.md`）：收到任务后整理成「人类可执行的最小上下文包」→ 提交 p390 网关 → 人工完成后逐字回传。任务需外部资源时，先经 `/v1/approvals` 提审批，批准后把人类提供的资源附进任务包再派单。

**dispatch-human Skill**（`.claude/skills/dispatch-human/SKILL.md`）：触发入口。用法：

- `/dispatch-human <任务>`
- 或自然描述：「把这段涉密逻辑交给人工处理」
- 或输入框 `@humanllm`（整会话硬切换）

两者最终汇入同一条链路：`整理上下文包 → p390 网关 → 人工工程师 → 产出回传`。

---

## 四、账户与邮件

### 注册
- `USER_REGISTER_MODE=open`（默认）：注册即用，返回 token 直接登录
- `USER_REGISTER_MODE=audit`：注册后待管理员在用户管理启用

### 忘记密码
`POST /api/auth/forgot-password`（body `{email}`）→ 重置密码并发到注册邮箱。邮件用 `nodemailer`，SMTP 未配置时降级为日志 + 响应返回演示密码。

### SMTP 配置（.env）
```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=user@example.com
SMTP_PASS=******
SMTP_FROM=p390@example.com
```

---

## 五、AI 降级配置

| 变量 | 说明 |
|---|---|
| `AI_RELAY_ENABLED=true` | 启用中继 |
| `AI_RELAY_BASE_URL=https://api.deepseek.com` | 目标 provider（OpenAI 兼容均可） |
| `AI_RELAY_API_KEY=sk-xxx` | 目标 provider key |
| `AI_RELAY_MODELS=deepseek-v4-flash` | 命中这些 model 名 → 中继转发 |

两种触发：① 模型名匹配直接中继；② 待接单超时无人接单 → 自动用 AI 代答兜底（失败回落 returned）。

---

## 六、环境变量汇总（.env）

```
PORT=39000
DB_TYPE=pg            PG_HOST/PORT/DATABASE/USER/PASSWORD
JWT_SECRET
HUMAN_LLM_MODEL=human-llm
UPSTREAM_API_KEY            # 可选，上游鉴权
TASK_PENDING_TIMEOUT_MIN=60 # 待接单超时（分钟）
TASK_PROCESSING_TIMEOUT_MIN=120
TASK_WAIT_MS=300000         # /v1 挂起等待上限（毫秒）
AI_RELAY_*                   # 见上
USER_REGISTER_MODE=open      # open / audit
SMTP_*                       # 邮件（可选）
```

---

## 七、目录结构

```
server.js              # 入口：Socket.IO + 安全头 + 路由 + 超时扫描
db/index.js            # PG 连接 + 建表（users/tasks/task_logs/request_logs/approvals/projects）
middleware/            # auth（JWT）、security（基础头+CORS+限流）
routes/
  v1.js                # OpenAI 兼容 /v1/models + /v1/chat/completions
  approvals.js         # /v1/approvals + 工作台审批
  projects.js          # 项目管理 + 申请建项目
  tasks.js workbench.js logs.js users.js auth.js
services/
  queueService.js      # 任务状态机 + 等待者 + 超时扫描 + 质量校验 + AI 降级
  approvalService.js   # 审批状态机 + 等待者 + 24h 超时提醒
  aiRelay.js           # DeepSeek 中继（一次 + stream 透传）
  openaiEncoder.js     # OpenAI 响应/SSE 封装
  projectService.js    # 项目 CRUD + 审批批准回调
  mailer.js            # SMTP 邮件（可配置降级）
  websocket.js         # Socket.IO 推送
public/                # 工作台（utils/api/ws/ui/app.js）+ 登录页（含注册/忘记密码）
scripts/seed.js        # 种子账户 + 建表迁移
```

---

## 默认账户

- 管理员：`admin` / `admin123`
- 工程师：`engineer1` / `engineer2` / `admin123`

## 常用命令

```bash
npm start          # 启动
npm run seed       # 建表 + 种子
npm run dev        # 开发热重载
# 后台常驻（防会话结束挂）：
powershell -ExecutionPolicy Bypass -File G:\dev\scripts\bg.ps1 start -Name p390-gateway -Command "node server.js" -Dir "G:\dev\p390"
```
