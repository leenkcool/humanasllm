# Human as Agent · 测试方案

> 目标：给项目建立系统化测试。当前仅有 `scripts/smoke-test.js`（24 项 API 回归）+ 开发期临时验证；本方案补齐**单元 / 集成 / API 回归 / 前端 / 端到端**分层，并给出框架、覆盖矩阵、执行与 CI、分阶段落地。

---

## 一、测试分层

| 层 | 覆盖 | 是否需服务/DB |
|---|---|---|
| **单元（Unit）** | services 纯逻辑：状态机、质量校验、编码器、i18n 字典、分类引擎纯函数、模板渲染 | 否（mock DB） |
| **集成（Integration）** | service + DB：任务状态机全链路、审批流、项目服务、分类引擎（真规则表） | 需测试库 |
| **API 回归（Smoke）** | HTTP 全接口：认证/任务/审批/项目/规则/租户/网关/治理/用户/日志 + 权限/边界 | 需服务 + DB |
| **前端（可选）** | UI 渲染、四屏适配、i18n 切换 | 浏览器 |
| **端到端（E2E，可选）** | 上游调用 → 任务 → 人工 → 回查 完整链路 | 全栈 |

---

## 二、框架

- **单元 + 集成**：Node 内置 `node:test`（Node 20+ 零依赖）+ `node:assert`。命令 `npm test` → `node --test tests/`。
- **API 回归**：现有 `scripts/smoke-test.js`（fetch 直调，无需框架）。命令 `npm run test:smoke`。
- **测试库**：PostgreSQL `p390_test`（跑集成前 `initDatabase` 建表 + 清库）；mock 用于 `aiRelay` / `mailer` / `websocket` / `notifier`。

---

## 三、覆盖矩阵

### 单元测试（首批已落地）
| 文件 | 覆盖 |
|---|---|
| `tests/unit/stateMachine.test.js` | 任务/审批状态机合法与非法流转、`can`/`allowed` |
| `tests/unit/quality.test.js` | `qualityCheck` 分类（general 20 字 / ops·confidential 10 字 / 占位拦截） |
| `tests/unit/encoder.test.js` | `parseChatRequest` 扩展字段透传、`makeChatCompletion`/`StreamChunks`/`Error` 结构 |
| `tests/unit/i18n.test.js` | 后端 message 字典直译 + 前缀模板翻译 + 未知透传 |
| `tests/unit/categoryEngine.test.js` | `matchKeywords`/`explicitCategory` 纯函数；`classify` 规则命中（白名单锁死）/显式/默认 |

### 待补（按优先级）
| 模块 | 关键测试点 |
|---|---|
| **哈希链** | `addLog`/`verifyAuditChain` 完整性 + 篡改检测（集成） |
| **智能漂移** | `aiShift.shouldShift` 开关 / 仅 general / 失败回落 |
| **网关** | `renderTemplate` 占位替换、`safeTarget` 越界、`toolFiles` 各工具产物 |
| **通知** | `notifier.send` 邮件/Webhook（mock） |

### API 回归（smoke 已有 24 项）
覆盖：health / models / 登录 / 任务全链路 / 审批异步+回查 / 项目 / CSV / 规则 / 治理概览 / 合规报告 / 数据资产 / 网关安装包 / 用户统计。待补：**权限边界**（engineer 访问 admin 接口 403）、**租户隔离**、**多工具安装**、**服务器端安装**。

### 集成（待补）
- 任务状态机全链路：create → claim → complete → reopen → requeue → cancel（含审计日志、哈希链）
- 审批流：create → approve/reject → 回查（含项目申请自动建）
- 多租户：upstream_key 路由、读隔离、租户级规则

---

## 四、执行与 CI

```bash
npm test            # 单元 + 集成（node --test tests/）
npm run test:smoke  # API 回归（需服务 + DB 已就绪）
```

**CI（Gitea Actions，可选）**：`.gitea/workflows/test.yml`：
1. 启动 PostgreSQL（测试库）→ 2. `npm ci` → 3. `npm run seed` → 4. `npm test` + `npm run test:smoke`（后台起服务跑 smoke）。

---

## 五、分阶段落地

| 阶段 | 内容 | 状态 |
|---|---|---|
| **1 · 框架 + 核心单元** | `node:test` 框架 + 5 个纯函数单测 | ✅ 已落地 |
| **2 · 单元补齐** | 哈希链、智能漂移、网关、通知（mock） | 待做 |
| **3 · 集成** | 任务/审批/多租户 service+DB 全链路 | 待做 |
| **4 · API 回归扩展** | smoke 补权限/租户/多工具/服务器端安装 | 待做 |
| **5 · CI + 覆盖率** | Gitea Actions + `--experimental-test-coverage` | 待做 |

---

## 六、验收标准

- `npm test` 全绿（单元 + 集成）
- `npm run test:smoke` 全绿（API 回归）
- 关键安全边界有测试：分级白名单锁死、租户隔离、越界拒绝、涉密禁 AI 兜底
