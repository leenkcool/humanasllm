# AGENT.md — AI Agent 二次开发约定

本项目（Human as Agent，人工代理网关）开源。任何开发者都可用 AI Agent 二次开发。遵循以下约定：

## 一、核心原则
1. **保持 OpenAI 兼容核心（`/v1`）稳定**，不破坏协议（`human-llm` 模型名勿改）。
2. **安全边界不可放松**：分级白名单锁死（涉密/运维禁 AI 兜底）、多租户隔离、路径越界拒绝、审计哈希链。
3. 新功能遵循 `docs/GOVERNANCE.md` 的治理层模式（分级/审批/质量/留痕）。
4. **提交前必须通过**：`npm test`（单元+集成）+ `npm run test:smoke`（API 回归）。

## 二、PRD 记录铁律（必须）
任何**经验证的功能需求**（AI Agent 或人实现，验证通过）**必须**追加到仓库根 `PRD.md`：

- 格式：
  ```
  ## YYYY-MM-DD - <功能名>
  - 描述：<做了什么、解决了什么>
  ```
- 追加后**以提交者身份** `git commit` + `git push`。
- 目的：`PRD.md` 沉淀全部需求，供后续开发者参考，**避免重复开发**。

## 三、开发流程
1. 先读：`docs/`（API / GOVERNANCE / HUMAN_ROUTES / TESTING / DEPLOY）+ `CLAUDE.md`。
2. 实现功能。
3. `npm test` + `npm run test:smoke` 验证。
4. 验证通过 → 追加需求到 `PRD.md` → commit → push。

## 四、环境
- Node.js 20+ / PostgreSQL（库 `p390`）。
- 测试：`npm test`（单元+集成）/ `npm run test:smoke`（API 回归）/ `npm run test:coverage`（覆盖率）。
- 部署：见 `docs/DEPLOY.md`（Windows/Linux）。


---

## 💬 支持与交流

本项目支持微信 / QQ 交流群：**6181193**。二次开发、问题反馈、需求讨论欢迎加入。

