# PRD — 功能需求沉淀

> 本项目所有验证过的功能需求在此记录。任何二次开发（AI Agent 或人）完成并验证后，**必须**在此追加条目（日期 + 功能描述），并 git commit + push。

## 2026-10-30 - 工单模板库
- 描述：**工单模板**——常用任务模板化。新增 `task_templates` 表 + `services/templateService.js` + `routes/templates.js` + 工作台「工单模板」页（列表/新建/编辑/停用/一键建单）。模板提供默认值（messages / priority / category / skills / project / meta_tags / system_prompt / tools），上游显式值优先；`/v1/chat/completions` 新增 `template_id` 字段（不传行为完全不变），非法/跨租户/停用模板一律 400 不建单。任务详情显示模板溯源 chip（`tasks.template_id`）。开箱播种 3 条全局示例模板（代码审查 / 数据库迁移 / 安全巡检）。
- 安全：模板的 `category` 只作为「上游显式声明」交给 `categoryEngine.classify`，**规则命中仍白名单锁死**——模板无法把涉密任务降级为可 AI 兜底的 general（有集成测试覆盖）。
- 基建：抽出 `middleware/taskAccess.js`（tasks/dispatch/alerts 共用租户+归属校验）；`queueService` 导出 `timeoutMinutes`/`hashPayload`/`verifyAuditChainFromLogs`（报告批量复核复用）；`createTaskFromRequest` 支持 `templateId` 与 `origin`；`stateMachine` 放开 `processing → cancelled`（与 UI「任意非终态可取消」一致）；种子工程师补 `skills` 标签（供智能派单）。
- 验证：单测 8 + 集成 3 通过；冒烟测试 32 → 37 项全过

## 2026-08-11 - 初始版本
- 描述：Human as Agent 基版——OpenAI 兼容人工代理网关 + 工程师工作台 + 治理层（分级/审批/质量/留痕）+ 多租户 + 多工具安装 + 测试体系（34 单测 / 30 smoke）

## 2026-09-16 - 日志越权修复 + 接入层体验筑基
- 描述：修复 `/api/logs/*` 跨租户越权（Issue #3，报告者 chenshj73）——三接口加租户隔离，`request_logs` 增 `tenant_id` 并回填存量（无任务的中继/漂移日志必须自存租户才能隔离）；新增路由级回归测试
- 描述：**上游完成回调 webhook**——请求带 `callback_url`（仅 http/https），任务终态主动 POST 结果（`task.completed|returned|cancelled`），上游免轮询；新增 `services/callback.js`，降级安全（投递失败只记日志）
- 描述：**`/v1/tasks/:id` 进度补全**——补 `priority`/`assignee`/`timeout_at`/`sla_remaining_sec`；回查与回调共用 `services/taskView.js` 视图，避免字段漂移
- 验证：单测/集成 36 项通过 + 30 项 API smoke 通过 + 完成回调端到端实测通过

## 2026-09-16 - 接入层阶段 A 收口（SSE 中途推送 + 函数调用）
- 描述：**SSE 中途状态推送**（opt-in `stream_events:true`）——连接保持打开，实时推 `task.accepted|processing|completed|returned|cancelled|paused`，终态推 `[DONE]`；含保活与最长保持；**不传该字段行为完全不变**（对既有上游零破坏）。新增 `services/sseStream.js` + `services/taskEvents.js`
- 描述：**tools / function calling**——请求声明 `tools`（OpenAI 函数定义），人工在工作台选函数并填参数，产出按 **OpenAI 原生 `tool_calls`** 返回（`content=null` / `finish_reason=tool_calls`）；仅允许调用本任务声明过的函数，未声明一律拒绝。新增 `services/toolCalls.js`
- 验证：单测/集成 40 项通过 + 两项端到端实测通过（SSE 事件序列 = accepted→processing→completed→[DONE]；未声明函数提交返回 400）
- 说明：路线图阶段 A「体验筑基」**接入层三项（回调 webhook / SSE 中途推送 / 函数调用）至此全部交付**


---

## 💬 支持与交流

本项目支持 QQ 交流群：**6181193**。二次开发、问题反馈、需求讨论欢迎加入。

