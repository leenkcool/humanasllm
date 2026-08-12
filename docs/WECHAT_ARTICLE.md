# 把工程师变成「AI 模型」：Human as Agent 开源了

AI Agent 时代，绝大多数任务 AI 都能搞定。但总有一类任务，AI 既搞不定、也不该碰——

- **涉密数据**：不能交给公有大模型
- **需人工判断/担责**：结果要有人负责
- **物理世界**：机房、网络、电力，机器够不到
- **合规留痕**：操作要审计、要审批

以前，这类任务会让你的整条 Agent 工作链路**卡死**——调度池遇到「这单必须人工」就停摆了。

现在，**Human as Agent（人即智能体）** 来了：把工程师封装成 OpenAI 兼容的模型 `human-llm`，调度池加一条模型路由，涉密/需人工任务自动派给真人工程师，完成后按大模型格式返回——**AI 链路不中断，上层无感知后端是人还是 AI**。

---

## 一、这是什么

一句话：**人工代理网关**。对外完全兼容 OpenAI 标准接口（`/v1/chat/completions`），工程师作为「人肉大模型」接入你现有的多模型调度池。

```
调度池 / Agent
   │ OpenAI /v1（model=human-llm）
   ▼
Human as Agent 网关（39000）
   ├─ 涉密/需人工任务 → 人工工程师工作台（接单/完成/审批/质量）
   ├─ AI 中继（常规任务 → DeepSeek 等）
   └─ 多租户（upstream_key 隔离）
        │ PostgreSQL
```

**零代码改动**——调度池只加一条 `human-llm` 模型路由即可接入。

## 二、核心能力

### 给 AI 智能体提效
- **一键安装 SKILL / AGENT**：为 13 种工具生成专属接入文件，粘贴即装
- **人工路由不中断**：异步受理立即返回 `task_id`，工程师完成后回查取回
- **涉密保护锁死**：分级白名单锁死，涉密/运维任务禁 AI 兜底，**上下文不出网关**
- **AI 兜底省人工**：常规简单任务可自动 AI 承接（可开关），涉密类绝不漂移

### 给平台 / 运维部门提效
- **工单快速收集**：派单 → 接单 → 提交 → 回查，全程状态可见、未完成聚合防遗忘
- **分级治理**：涉密/运维/常规自动分级，规则可配置，白名单不可降级
- **审批流**：AI 提资源申请 → 人批/驳并附资源 → 回传
- **质量与合规**：验收单、一次通过率、审计哈希链、合规报告（数据不出网关证明）

## 三、演示网站 & 开源

- **演示网站**：https://humanasllm.anytd.com
- **开源仓库（MIT）**：https://github.com/leenkcool/humanasllm

## 四、怎么接入

调度池配置示例（OpenAI 兼容，零改动）：

```jsonc
{ "models": [
  { "id": "human-llm",         "base_url": "https://humanasllm.anytd.com/v1" },
  { "id": "deepseek-v4-flash", "base_url": "https://humanasllm.anytd.com/v1" }
] }
```

请求体与标准 OpenAI `chat/completions` 完全一致，可附业务字段 `category`（general/confidential/ops）、`project_code`、`priority`、`skills`。

## 五、多工具安装方法（复制提示词 → 目标项目粘贴）

### WorkBuddy
```
请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：workbuddy）：

1. 调用 GET https://humanasllm.anytd.com/api/gateway/install?tool=workbuddy 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 https://humanasllm.anytd.com、模型为 human-llm
```

### Claude Code
```
请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：claude）：

1. 调用 GET https://humanasllm.anytd.com/api/gateway/install?tool=claude 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 https://humanasllm.anytd.com、模型为 human-llm
```

### Codex
```
请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：codex）：

1. 调用 GET https://humanasllm.anytd.com/api/gateway/install?tool=codex 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 https://humanasllm.anytd.com、模型为 human-llm
```

### OpenCode
```
请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：opencode）：

1. 调用 GET https://humanasllm.anytd.com/api/gateway/install?tool=opencode 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 https://humanasllm.anytd.com、模型为 human-llm
```

### OpenClaw
```
请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：openclaw）：

1. 调用 GET https://humanasllm.anytd.com/api/gateway/install?tool=openclaw 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 https://humanasllm.anytd.com、模型为 human-llm
```

### Hermes
```
请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：hermes）：

1. 调用 GET https://humanasllm.anytd.com/api/gateway/install?tool=hermes 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 https://humanasllm.anytd.com、模型为 human-llm
```

### Cursor
```
请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：cursor）：

1. 调用 GET https://humanasllm.anytd.com/api/gateway/install?tool=cursor 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 https://humanasllm.anytd.com、模型为 human-llm
```

### 非主流 / 其他 AI Agent（通用构建方法）
不支持的 Agent 工具？请求安装包时用 `tool=build`，会得到一份**「通用构建指南」**——把人工路由规则构建成任意工具的 skill/agent，照着做就行：

```
请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：build）：

1. 调用 GET https://humanasllm.anytd.com/api/gateway/install?tool=build 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 https://humanasllm.anytd.com、模型为 human-llm
```

## 六、调用方法（人工路由怎么用）

AI Agent 需要人工时，直接按 OpenAI 格式提交：

```bash
curl -X POST https://humanasllm.anytd.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "human-llm",
    "messages": [{ "role": "user", "content": "帮我做网站备案规划" }],
    "category": "confidential"
  }'
```

网关**立即返回** `task_id`（异步受理，不等人工）：
```json
{ "task_id": 42, "status": "pending",
  "content": "任务已受理，task_id=42，待人工处理；可通过 GET /v1/tasks/42 查询结果" }
```

人工工程师完成后，回查取回产出：
```bash
curl https://humanasllm.anytd.com/v1/tasks/42
# → completed：content 为人工产出，逐字返回
```

## 七、使用场景示例

**提示词一：请 IT 大神帮我做网站备案规划**
→ AI Agent 收到后，通过 `human-llm` 派给人工工程师（涉密/专业判断），人工完成后回传一份可执行的备案规划。

**提示词二：请帮我申请公网 IP 并完成站点部署**
→ 人工运维工程师接单，完成服务器/域名/备案/部署，逐字回传结果。

**提示词三：请帮我写一份涉密接口的加密方案并评审**
→ 涉密逻辑不进公有大模型，由人工工程师完成并交付。

> 一句话原则：**AI 能搞定的交给 AI，AI 搞不定/不该搞的交给真人——同一个调度池，零切换成本。**

## 八、开源与交流

- **开源仓库（MIT）**：https://github.com/leenkcool/humanasllm
- **演示网站**：https://humanasllm.anytd.com
- **交流群（QQ）**：**6181193** —— 二次开发、问题反馈、需求讨论，欢迎加入

让工程师成为 AI 时代的一等公民：**AI 指挥、真人执行 AI 不能做的**。Human as Agent，人即智能体。
