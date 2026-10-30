# PRD — 功能需求沉淀

> 本项目所有验证过的功能需求在此记录。任何二次开发（AI Agent 或人）完成并验证后，**必须**在此追加条目（日期 + 功能描述），并 git commit + push。

## 2026-10-30 - 项目成员 + 知识库（答复复用，三级作用域）
- 描述：**项目成员机制**（此前完全缺失）——新增 `project_members` 表（owner/member/viewer），建项目者自动成为 owner；`/api/projects/:id/members` 支持列表/添加/移除（admin 或项目 owner 可管理，成员可退出）。**兼容策略**：历史项目无成员记录时视为「租户内可见」，不锁死既有项目。
- 描述：**知识库**——新增 `knowledge_entries` 表 + `services/knowledgeService.js` + `routes/knowledge.js` + 工作台「知识库」页。三级作用域：`project`（仅项目成员 + admin）/ `tenant`（同租户全员）/ `global`（所有租户）。统一可见性判定 `visibleClause()`，列表/详情/检索共用一份口径。
- **硬约束**：`confidential` 类条目只能存为 `project` 作用域或作者私有，**永不进入 tenant/global 共享池**——「数据不出网关」在知识库上的延续（服务层校验 + 集成测试锁定）。
- 相似检索：`pg_trgm` + GIN 索引（迁移时自动建扩展，不可用则降级为 ILIKE）；中文三元组相似度偏低，额外叠加关键词兜底召回。实测相似度 0.44 命中。
- 三个入口：任务详情侧栏「相似历史答复」（答复时参考）、已完成任务「沉淀为知识条目」（自动预填问题/答复/标签/作用域）、独立知识库页（按作用域/分级/关键词筛选）。
- 上游可选：`/v1/chat/completions` 传 `use_knowledge: true` 时命中 global/同租户 tenant 且相似度 ≥0.7 直接返回（`source: 'knowledge'`），**默认关闭**；project 条目不参与（上游无项目成员身份）。
- 验证：集成 6（项目隔离/跨租户/涉密拒绝/相似检索/权限）通过；全量 160 项、冒烟 64 项、UI 12 页全通过

## 2026-10-30 - 多轮追问（会话上下文延续）
- 描述：新增 `services/conversationService.js`——同一会话的多轮任务通过 `conversation_id` 串成时间线。上游首次请求自动生成会话 id 并随 `task_id` 返回（`conversation_id` / `turn_index`）；追问时带上该 id，新任务挂到同一会话，`turn_index` 递增、`parent_task_id` 指向上轮。**不传 `conversation_id` 时行为完全不变**（零破坏）。
- 关键约束：**追问继承首轮分级**——首轮被判 `confidential`/`ops`，后续轮次一律沿用，不允许因追问内容变无害而降级；项目强制继承，优先级/技能在上游未指定时继承，上游显式值仍优先。
- 上游回查：`GET /v1/tasks/:id` 对带会话的任务额外返回 `conversation.turns`（每轮问题/答复摘要），上游可据此理解上下文。
- 工程师侧：任务详情新增「会话时间线」区块，跨轮次展示问题与答复，当前轮次高亮。
- 安全：非法 / 跨租户 `conversation_id` 一律 400；会话上限 `MAX_TURNS=50`。
- 验证：单测 8 + 集成 4（含跨租户与会话不降级）通过；冒烟 60 → 64 项；全量 154 项通过

## 2026-10-30 - 工程师终端（移动优先）+ AI 起草留痕
- 描述：新增 `public/mobile.html` + `public/js/mobile.js` + `public/css/mobile.css`——面向工程师的轻量刷任务终端（与管理工作台分开优化）。卡片流一屏一单、技能匹配度排序、SLA 倒计时红色预警、接单/答复无需跳页、详情抽屉内联写作。登录页支持 `?next=` 回跳（仅站内相对路径，防开放重定向）。
- 描述：**定向推送**——`ws.pushTaskLoad()` 建单时广播 `task:load`（全站负载）+ 只给「技能与任务需求有交集」的工程师单独发 `task:matched`（避免全员被无关任务刷屏）。任务无技能要求时只广播不定向。
- 描述：**AI 起草（可留痕）**——`services/draftService.js` + `POST /api/tasks/:id/draft`。把「专业人员借用大模型起草、再人工审核定稿」落成可证明的机制：`general` 类可起草，`confidential`/`ops` **硬性拒绝**（上下文不得出网关）；提交时带 `drafted_by_ai` 则写入 `draft` 审计日志，哈希链可追溯。
- 修复：`assertTaskAccess` 增加 `requireStatus` 且状态先于归属判定——未接单任务原本给「无权限」，现在给「请先接单」（工程师侧可执行提示）。
- 修复：`aiRelay` 的 API Key 改为运行时动态读取（原先模块加载即固化，无法测试也无法热更新）。
- 修复：登录页 `nextUrl()` 的转义 bug（heredoc 生成的内联脚本出现未闭合字符串，导致整页 JS 报错）。
- 测试：单测 7（起草）+ 集成 4（定向推送/起草守卫/留痕）通过；`npm run ui:check` 增加工程师终端检查段落（匿名跳转、登录回跳、卡片渲染、抽屉、横向溢出）
- 同时修复：9 个旧集成测试清理时缺 `billing_ledger` 外键前置删除（开发服务器的计费扫描会并发写入，导致删 `tasks` 失败）

## 2026-10-30 - 智能派单（技能匹配 + 负载均衡）
- 描述：新增 `services/dispatchService.js` + `routes/dispatch.js`：候选人打分 `100 × (0.5 技能匹配 + 0.3 空闲负载 + 0.2 一次通过率)`；任务无技能要求时技能维度取中性 0.5，无历史时质量分按 0.7 兜底（不埋没新人）；`DISPATCH_LOAD_CAP` 可调（默认 5）。接口：`GET /api/dispatch/tasks/:id/suggest`（只读建议）、`POST .../assign`（admin，支持 `dry_run`）、`GET /api/dispatch/workload`。
- 设计：派单复用 `queueService.claimTask`，走同一状态机与审计哈希链，并额外写一条 `dispatch` 日志留痕打分依据；**不改变默认人工 claim 语义**（无任何自动触发，`DISPATCH_ENABLED=false` 可整体关闭）。
- 前端：任务详情新增「智能派单」区块（异步填充，范式同 `verifyChain`），展示推荐人选/评分条/三项理由，管理员可一键派单。
- 验证：单测 8 + 集成 2 通过；冒烟新增 7 项

## 2026-10-30 - 超时告警升级序列 + 告警中心
- 描述：新增 `services/alertService.js`（612 行）+ `routes/alerts.js` + 工作台「告警中心」页。五级告警：L1 SLA 过半（→处理人）→ L2 临近超时（→admin）→ L3 已违约（→admin + 全站广播）→ L4 驳回滞留 → L5 严重滞留。去重靠 `tasks.escalation_level` 原子 `UPDATE ... WHERE escalation_level < ? RETURNING`，同级别只发一次；**绝不更新 `updated_at`**（否则 `return_stale` 会自我重置）。
- 描述：**修复审批超时重复发信**——原 `startApprovalScanner` 每 60 秒对同一审批无限重发，现改为 `last_reminded_at` 24h 去重 + 写一条 `approval_overdue` 告警。
- 前端：新增告警中心页（活跃/已确认/已解决/全部四标签 + 级别统计卡 + 确认/解决操作 + 任务跳转）；侧栏徽标实时跟随；补上 `ws.js` 长期缺失的 `approval:*` 事件监听（原先三个审批 toast 永不触发）。
- 数据库：`tasks` 增 `remind_count`/`last_reminded_at`/`escalation_level`，`approvals` 增 `remind_count`/`last_reminded_at`，新增 `alerts` 表。
- 验证：单测 7 + 集成 3 通过；冒烟新增 2 项

## 2026-10-30 - 计费计量（人力成本可核算）
- 描述：新增 `services/billingService.js` + `routes/billing.js` + 工作台「计费」页。按任务计时计费：费率维度 = 分级 × 优先级，租户费率覆盖全局费率再回退代码常量；金额 = `max(时长 × 单价, 最低消费)`，单位统一为分。
- 规则：仅 `completed` 且人工参与的任务计费；AI 兜底/漂移记 0 分钟但仍写流水（`source=ai_relay|ai_shift`）；时长 = `completed_at - COALESCE(claimed_at, created_at)` 向上取整到 0.5 分钟；`billing_ledger` 以 `task_id` 唯一，重复结算幂等。
- 前端：KPI 卡（本期总额/计费任务数/日均/时价均值）+ 月度账单（按分级/项目/工程师/来源）+ 费率配置（admin）+ 明细分页 + CSV 导出（BOM）。
- 数据库：新增 `billing_rates`（含全局费率部分唯一索引）、`billing_ledger`。
- 验证：单测 10 + 集成 6 通过；冒烟新增 4 项 + 权限 1 项

## 2026-10-30 - 监控 /metrics + 数据备份与恢复演练
- 描述：**Prometheus 监控**——`services/metricsService.js`（`prom-client`，未安装时自动降级为零依赖手写实现）。HTTP 请求计数/耗时直方图（route 用 `req.baseUrl + req.route.path` 模板，避免高基数与同名路由混淆）+ 业务 gauge（任务/分级/超时/审批/告警/计费/DB 可用性），每 15s 刷新。`/metrics` 挂在**全站限流之前**，抓取不占额度；可选 `METRICS_TOKEN`。
- 描述：**数据备份**——`scripts/backup.js` 流式 gzip（`--clean --if-exists` 可覆盖恢复）、备份后校验（gzip 魔数 + `PostgreSQL database dump`）、保留策略、`manifest.jsonl` 记账、PG 客户端自动探测 + **版本闸门**（客户端版本须 ≥ 服务端）。`scripts/restore.js` 强制先自动备份当前库 + 交互输入 `RESTORE` + `--single-transaction ON_ERROR_STOP`。`scripts/drill-restore.js` 恢复演练（临时库比对后必删）。工作台 `/api/backup/*` 可触发与查看历史。
- 实测：备份 49KB；演练 12 张表 / 506 行前后完全一致，耗时 2.3s
- 验证：单测 8（metrics）+ 单测备份通过；冒烟新增 4 项

## 2026-10-30 - 移动端 PWA + 实时通知
- 描述：`public/manifest.json` + `public/sw.js` + `public/offline.html` + `public/js/pwa.js` + `scripts/gen-icons.js`（零依赖手写 PNG 编码器生成 192/512/maskable 三枚图标）。SW 采用 App Shell 预缓存 + 导航 network-first + 静态资源 stale-while-revalidate；`notificationclick` 聚焦并跳转工作台。**明确不缓存 `/api/*`、`/v1/*`、`/socket.io/*`**（携带 JWT 与租户数据，缓存会在登出后越权）。
- 前端：移动端底部导航（4 项 + 徽标）、`env(safe-area-inset-*)` 安全区、触控目标 ≥44px、iOS 输入框 16px 防缩放；后台标签页收到任务/告警时发系统通知。
- 说明：本机 `localhost` 属安全上下文可安装；局域网 `http://192.168.168.3:39000` 不行，需 HTTPS 域名（`docs/DEPLOY.md` 十三节给了 Caddy/nginx 配置与验证步骤）。不引入 Web Push / VAPID，完全关闭浏览器后收不到通知（刻意取舍）。
- 验证：单测 9（manifest 结构 / PNG IHDR 尺寸 / SW 分支与护栏 / HTML 标签 / CSS 断点）；冒烟新增 3 项

## 2026-10-30 - 合规报告 PDF 导出（HTML 自包含 + 浏览器打印）
- 描述：**合规报告导出**——新增 `services/reportService.js`：`collectReportData`（唯一数据出口）+ `renderHtml`（自包含单文件 HTML，内嵌 CSS 与 `@media print` / `@page A4`，零外部资源零脚本）。`GET /api/audit/report?format=html&lang=zh|en` 返回报告页，浏览器「打印 → 另存为 PDF」即得交付件；缺省仍返回 JSON（向后兼容）。工作台「合规报告」弹窗新增「导出 PDF 报告」按钮（同步开窗 + Bearer 拉取，token 不进 URL）。
- 描述：报告新增 `scope`（租户）、`categories`/`status` 分布、`human_ratio`（人工产出占比）、`approvals.pending`/`avg_decide_min`、`quality.pass_rate`、`compliance_pass`、`audit_chains.checked/broken`。
- **安全修复**：`audit/report` 原为全表聚合（跨租户越权，与 `audit/dataset` 口径不一致）→ 全部指标按 `tenant_id` 过滤；顺带修掉同类越权：`workbench/governance` 的审批统计、`approvals/export` 未传租户。哈希链校验由 N+1 改为一次 join + 内存复算（上限 500 条抽样）。
- 验证：单测 5（含 XSS 转义 / 打印样式 / 中英分离）+ 集成 3（含跨租户隔离回归 / 篡改检测）通过；冒烟 37 → 41 项全过

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

