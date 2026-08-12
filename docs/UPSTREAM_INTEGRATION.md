# P390 上游生态集成指南（Upstream Integration）

> 给任何 Agent / vibe coding 工具 / 调度平台的接入文档：如何把任务派给 P390 的人工工程师，并按治理协议取回结果。**OpenAI 兼容，零代码改动接入；治理决策全程可查。**

---

## 一、接入三步

### 1. 提交任务（异步受理）
`POST /v1/chat/completions`，模型名 `human-llm`：

```json
{
  "model": "human-llm",
  "messages": [{ "role": "user", "content": "对数据库执行 XX 迁移，需人工执行" }],
  "priority": "high",
  "category": "ops"
}
```

**立即返回**（不等人工完成，人工是小时级节奏）：
```json
{ "choices": [{ "message": { "content": "任务已受理，task_id=42，待人工处理；可通过 GET /v1/tasks/42 查询结果" } }],
  "task_id": 42, "status": "pending" }
```

### 2. 登记未完成（防遗忘的关键）
把 `task_id` 记入自己的未完成清单。下次做相关工作前，先回查。

### 3. 回查并交付 / 轮候
`GET /v1/tasks/:id`：

| status | 处理 |
|---|---|
| `completed` | 取 `content`（人工产出）交付，结清 |
| `returned` | 转达驳回原因，补充上下文后可重新派单 |
| `pending/processing/paused` | 如实反馈状态，**继续轮候** |

---

## 二、治理协议（上游可感知的「人的权威节点」）

### 分级决策（为什么走人工）
`GET /v1/tasks/:id` 返回：
- `category` / `rule_id` / `rule_name`：分级类别 + 命中规则（如「合规备案安全」→ confidential）
- `category_source`：`rule`（规则白名单锁定，声明 general 也拦不住）或 `manual`
- `quality.completion_note`：质量验收说明（运维/涉密类必填）
- `audit.valid`：审计哈希链是否完整（防篡改可证明）

### 分级规则可查
`GET /v1/governance/rules`：返回当前租户可见的分级规则（全局 + 租户专属），上游可理解「什么会被人工拦截」。

### 数据资产（合规反哺）
`GET /api/audit/dataset`（工作台 JWT）：导出 completed 人工产出为 JSONL 评测集。
- 默认 `general` 类（涉密/运维数据不出网关）
- `confidential`/`ops` 需 admin 显式指定

---

## 三、多租户（可选）

- 租户通过 `tenants.upstream_key` 映射：上游请求带 `Authorization: Bearer <key>` → 任务/审批归该租户，数据隔离
- 无 key 回退默认租户

---

## 四、Claude Code 侧自动实现

- `humanllm` 子代理 + `dispatch-human` skill 已按本契约工作：提交 → 登记 `data/human_followup.json` → 每次被调用先回查 → 完成即交付、未完成反馈状态继续轮候
- 资源申请走 `POST /v1/approvals`（异步受理 → `GET /v1/approvals/:id` 回查），批准后把 `provided` 附进任务包再派单

---

## 五、合规红线

1. **涉密/运维任务禁 AI 兜底**（分级引擎锁死）：超时回落 `returned`，上下文不出网关
2. **数据资产导出默认 general**：涉密数据不在通用评测集中
3. **审计留痕**：所有任务哈希链可验证，`GET /api/audit/report` 生成合规证明


---

## 💬 支持与交流

本项目支持 QQ 交流群：**6181193**。二次开发、问题反馈、需求讨论欢迎加入。

