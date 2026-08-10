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
  "meta_tags": { "source": "scheduler" }    // 业务扩展：元标签
}
```

**一次性返回**（`stream:false`，人工完成/中继后）：
```json
{ "id": "chatcmpl-xxx", "object": "chat.completion", "created": 1786…,
  "model": "human-llm",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "<人工产出或 AI 内容>" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 } }
```

**流式返回**（`stream:true`）：SSE `data:` 行：
```
data: {"id":"chatcmpl-…","choices":[{"delta":{"role":"assistant"}}]}
data: {"id":"chatcmpl-…","choices":[{"delta":{"content":"…"}}]}
data: {"id":"chatcmpl-…","choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

**超时/驳回**：仍返回 OpenAI 结构，`content` 携带说明（如「任务被驳回: …」或「请求等待超时，任务仍在处理中」）。

### POST /v1/approvals
AI 向人类提审批（资源/权限/项目申请），挂起等待人类批准/驳回。

**请求体**：
```json
{ "resource": "PostgreSQL 测试服务器", "amount": "2C4G / 50G",
  "purpose": "部署生产实例", "detail": "…", "requester": "ai-agent",
  "project_code": "p390" }
```

**返回**（批准/驳回后）：
```json
{ "id": "appr-xxx", "object": "approval", "resource": "…", "amount": "…",
  "status": "approved", "provided": "已批准：192.168.168.60…",
  "reject_reason": null, "decided_at": "…" }
```
- `status`: `pending`(超时) / `approved` / `rejected`
- `provided`：人类批准时提供的资源/说明；`reject_reason`：驳回原因

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
