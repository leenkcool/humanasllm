# Human as Agent · 测试方案

> 现状（2026-10-30）：**178 项自动化测试 + 68 项 API 冒烟 + 12 页浏览器回归**，全部通过。
> 本文说明分层策略、如何新增测试、以及踩过的坑。

## 一、四层测试

| 层 | 文件 | 数量 | 依赖 | 命令 |
|---|---|---|---|---|
| **单元** | `tests/unit/*.test.js` | 18 文件 | 无（纯函数） | `node --test tests/unit/*.test.js` |
| **集成** | `tests/integration/*.test.js` | 19 文件 | **真实 PG（库 `p390`）** | `node --test tests/integration/*.test.js` |
| **API 冒烟** | `scripts/smoke-test.js` | 68 项 | 服务须已启动（39000） | `npm run test:smoke` |
| **浏览器回归** | `scripts/ui-check.js` | 12 页 | puppeteer + 服务已启动 | `npm run ui:check` |

全量：`npm test`（178 项，约 60-90 秒）。

## 二、单元测试（18 个）

纯函数直测，`require` 业务模块，**不初始化数据库**：

| 文件 | 覆盖 |
|---|---|
| `stateMachine` | 任务/审批流转表、`can`/`allowed` |
| `categoryEngine` | 关键词匹配、显式分类 |
| `encoder` | OpenAI 请求解析、响应结构、SSE chunk |
| `quality` | 质量校验（空/过短/占位，分分级阈值） |
| `i18n` | 字典翻译、前缀模板 |
| `gateway` | `renderTemplate`、路径越界防护 |
| `templateService` | 模板合并优先级、技能归一化、可见性 |
| `dispatchService` | 打分公式（技能/负载/通过率）、排序确定性 |
| `escalation` | SLA 比例边界、级别计算、终态不告警 |
| `reviewService` | 分级策略、四维评分、上游状态映射 |
| `conversationService` | 会话继承、受保护类不降级、上限 |
| `draftService` | **分级红线**（confidential/ops 禁止 AI 起草）、上下文截断 |
| `reportRenderer` | HTML 自包含、XSS 转义、中英分离 |
| `pwa` | manifest 结构、PNG 尺寸、SW 分支与护栏、HTML 标签 |
| `metrics` / `backup` | 指标渲染、备份文件名/保留策略 |
| `i18nConsistency` | **中英 key 集合一致、占位符一致**（长期锁死双语遗漏） |

## 三、集成测试（19 个）

连**真实 PostgreSQL 库 `p390`**（非独立测试库），每个用例自建租户、`finally` 自清理。

| 文件 | 覆盖 |
|---|---|
| `taskFlow` / `approvalFlow` | 状态机全链路、审批流 |
| `classify` / `aiShift` | 分级规则（真规则表）、智能漂移 |
| `hashchain` | 审计哈希链完整性 + 篡改检测 |
| `callback` / `sseEvents` / `toolCalls` | 完成回调、SSE 中途推送、函数调用 |
| `tenantIsolation` / `logTenantScope` | 多租户隔离（含 Issue #3 回归） |
| `auditReport` | 合规报告租户隔离 + HTML 导出 |
| `templates` / `conversation` | 模板建单、多轮追问 |
| `dispatchAlerts` | 派单排序/审计、告警去重/继承 |
| `billing` | 计费金额/幂等/租户隔离 |
| `knowledge` | 项目成员隔离、涉密拒绝、相似检索 |
| `review` / `feedback` / `mobileTerminal` | 审核流程、效果回流、定向推送与起草守卫 |

## 四、API 冒烟（68 项）

需服务已启动。覆盖 health/models、登录、任务全链路、审批、项目、CSV、治理、模板、派单、告警、计费、会话、审核、监控、PWA 静态资源、权限边界、租户隔离。结束时自动清理 `project_code='smoke'` 的数据。

## 五、浏览器回归（12 页）

`npm run ui:check` 用 puppeteer 真实打开工作台，逐页检查：

- 控制台错误 / 页面空白 / `undefined`/`NaN` 字样
- 横向溢出（桌面 1440 与移动 390）
- 中英切换后界面残留中文（排除用户数据）
- 四套主题切换
- 任务详情派单面板、会话时间线、审核面板
- 工程师终端（匿名跳转、登录回跳、卡片、抽屉）
- PWA：manifest 类型、SW 激活状态

截图与 `report.json` 输出到 `data/ui-shots/`（已 gitignore）。发现问题时退出码 1。

## 六、新增测试的硬规则

### 1. 用唯一后缀，别用固定编码

```js
let seq = 0;
const unique = () => `mytest-${process.pid}-${Date.now().toString(36)}-${++seq}`;
// INSERT INTO tenants (code, name) VALUES (?, ?), [unique() + '-a', '租户A']
```

固定编码（如 `'tc-a'`）在库里已有残留时会撞 `tenants_code_key` 唯一约束。

### 2. 清理顺序：子表 → 主表

**新增带外键的表后，必须同步给所有旧测试补清理**，否则删 `tasks` 会外键失败，`finally` 里的 `server.close()` 不执行 → **测试进程挂起**（实测卡死过两次）。

```
task_reviews / task_feedback / alerts / billing_ledger
  → task_logs / request_logs
    → tasks
      → project_members / knowledge_entries / approvals
        → users
          → tenants
```

### 3. 扫全库的函数要防并发干扰

`settlePendingTasks({ limit })` 会扫全库，并发跑测试时其它用例的任务可能占满名额。测试里调大 `limit`。

### 4. 别同时跑两个测试实例

两个 `npm test` 并发会争抢同一个库，双双挂起。跑之前确认没有残留进程：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--test*' }
```

### 5. 环境变量在模块加载时固化

`aiRelay` 等模块若在顶层读 `process.env`，测试里改环境变量不生效。**必须在函数内动态读取**（`draftService` 的测试锁定过这个行为）。

## 七、CI

`.gitea/workflows/test.yml`：起 PG16 service → `npm ci` → `npm run seed` → `npm test` → 起服务 → `npm run test:smoke`。

浏览器回归不进 CI（需 Chromium），作为改动前端后的本地必跑项。

## 八、测试覆盖的关键安全边界

以下边界由测试长期锁定，改代码时若破坏会立即失败：

| 边界 | 测试 |
|---|---|
| 涉密/运维类禁止 AI 兜底与 AI 起草 | `draftService` + `classify` + `aiShift` |
| 追问不降级受保护类会话 | `conversation` |
| 知识库涉密条目不得共享 | `knowledge` |
| 跨租户访问一律 404（不泄露存在性） | `tenantIsolation` / `logTenantScope` / `dispatchAlerts` |
| 审计哈希链防篡改 | `hashchain` |
| 中英文案不漏 | `i18nConsistency` |
