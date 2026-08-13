# WorkBuddy × P390 派单测试总结

> 测试对象：P390 人工代理网关（human-as-llm，网关 https://humanasllm.anytd.com）
> 测试环境：WorkBuddy Agent（已安装 `AGENTS.md` 人工路由规则）
> 对照规范：`API.md`（接口）、`HUMAN_ROUTES.md`（分级与异步回查契约）、`DISPATCH_PROMPTS.md`（可派单提示词）
> 测试日期：2026-08-12 ~ 08-13

## 一、测试背景

在 WorkBuddy 中接入 P390 人工路由能力，按 `HUMAN_ROUTES.md` 的「提交 → 登记 task_id → 回查 → 交付/轮候」异步契约，对网关做了一次覆盖安装、派单、分级、回查、去重的端到端验证。

## 二、测试覆盖（按接口 / 能力）

| # | 测试项 | 接口 / 机制 | 结果 |
|---|---|---|---|
| 1 | 网关能力安装 | `GET /api/gateway/install?tool=workbuddy` | ✅ 拉取安装包并写入 `AGENTS.md` / `构建指南.md`；**发现**：原始 URL 双斜杠 `/api//gateway` 返回「接口不存在」，去掉后成功 |
| 2 | 异步派单 | `POST /v1/chat/completions`（model=human-llm） | ✅ 立即返回 `task_id` + `status:pending`，符合异步受理规范；累计派 **15 个任务（task 2–16）** |
| 3 | category 分级 | 请求体 `category` 字段 | ✅ 验证两种通道：<br>• `confidential`（8 项）：网站备案、渗透测试、入侵应急、主机加固、账号/SSH 密钥、上线自查、公网 IP、敏感数据导出<br>• `ops`（7 项）：服务器巡检、机房规范、上架规划、灰度发布、CI/CD、团队规划、项目创建<br>合规类自动归入 `confidential` + 规则「合规备案安全」，与 `HUMAN_ROUTES.md` 一致 |
| 4 | 结果回查 | `GET /v1/tasks/:id` | ✅ 批量回查 task 2–7，均 `pending`，`audit.valid=true`，无结果返回（人工小时级） |
| 5 | 重复派单去重 | 上游去重逻辑 | ✅ task 6 / task 7 被二次提交时识别为已派，未重复提交，避免清单冗余 |
| 6 | 未完成清单登记 | `P390_TASKS.md` 登记 `task_id` | ✅ 每个 task_id 落入未完成清单，符合「防遗忘」契约 |
| 7 | 工作流固化 | skill `p390-dispatch` | ✅ 沉淀「生成方法论模板 → 派单 → 去重登记 → 写日志」可复用流程，跨项目可用 |

## 三、结论

1. **核心能力全部按规范工作**：安装、异步派单、category 分级、回查、去重、清单登记 6 类能力均验证通过。
2. **涉密通道行为符合预期**：confidential 类任务上下文不出网关，网关侧自动定级，无 AI 兜底。
3. **当前状态**：15 个派单仍 `pending`（人工小时级受理），尚未有 `completed` 产出回传。

## 四、未覆盖（对照 `TESTING.md` 待补项）

- **approvals 流**：`POST /v1/approvals` → `GET /v1/approvals/:id`（资源/项目申请）本次未触发。
- **生产 smoke 回归**：`scripts/smoke-test.js` 24 项 API 回归未跑，本次仅为 WorkBuddy 侧派单链路验证。
- **completed 全链路**：因人工未返回，缺「回查 completed → 取 content 交付」这一闭环的实际样例。

## 五、关联

- 人工路由规则文件：`AGENTS.md`（项目根）
- 派单登记清单：`P390_TASKS.md`
- 网关：human-as-llm（P390）
