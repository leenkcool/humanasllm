---
name: dispatch-human
description: 将涉密/私有逻辑/需人工判断/项目规则要求人工的任务，派发给人工工程师处理（经 humanllm agent → p390 人工代理网关）。当用户说"交给人工 / 派给人类 / 需要真人实现"，或任务涉及敏感内部逻辑、不可交给公有大模型时使用。
---

# 派单给人工工程师（dispatch-human）

本 Skill 是「humanllm agent」的触发入口：它自己不实现任务，而是**整理触发条件 → 委派给 humanllm agent → 回传人工产出**。

## Trigger（何时触发）

- 用户明确要求人工处理：「交给人工」「派给人类」「让工程师做」「需要真人实现」
- 任务涉密 / 私有内部逻辑 / 不可外传 / 敏感业务
- 项目规则（CLAUDE.md）明确要求人工编写
- 任务可能额外需要外部资源（服务器 / API Key / 权限 / 环境）——humanllm 会自动先提审批

## Steps（主代理执行）

1. **读取** 调用者任务原文与全部上下文（messages、约束、涉密标记）。
2. **标注交人工原因**：`安全原因` 或 `项目规则要求`，随任务一并传给 agent。
3. **委派**：调用 Agent 工具，参数如下：
   ```
   subagent_type: "humanllm"
   prompt: <任务原文 + 交人工原因标注>
   run_in_background: false      // 同步等待人工结果；大任务可后台
   ```
   humanllm 会按 `G:\dev\p390\.claude\agents\humanllm.md` 自动把任务整理成「完整上下文包」（【任务】【交人工原因】【项目与代码库】【接单流程】【环境约定】【要求】），写入 `data/human_task.json` 并提交 p390 网关。
4. **等待** 人工工程师在工作台接单完成（最长约 9 分钟）。
5. **回传**：把人工产出**逐字**返回给调用者（保留代码块与换行），并附任务编号与工作台地址。

## 委派参数速查

| 参数 | 值 | 说明 |
|---|---|---|
| `subagent_type` | `humanllm` | 指定人工代理 agent |
| `run_in_background` | `false` | 同步等结果；耗时任务可 `true` |
| `model` | 省略 | humanllm 定义已定（转发器，仅 haiku 占位） |
| `isolation` | 省略 | 无需 worktree（转发类任务） |

## Verification（怎么算做对）

- ✅ 确实调用了 `humanllm` agent（而非自行实现任务）。
- ✅ 任务包六要素齐全（humanllm 保证）：【任务】【交人工原因】【项目与代码库】【接单流程】【环境约定】【要求】。
- ✅ 回传内容是**人工产出原文**，未自行改写、未丢代码块/换行。
- ✅ 附上了任务编号（如 #21）与工作台地址 `http://192.168.168.3:39000/login.html`。

---

### 硬绑定变体（可选）

若希望**整个 skill 直接以 humanllm agent 身份运行**（跳过"主代理→委派"），把 frontmatter 改为：

```markdown
---
name: dispatch-human
description: 涉密任务派发给人工工程师
agent_type: humanllm
---
```

则 Skill 触发后，Claude Code 直接以 `humanllm` agent 类型执行，不再需要第 3 步的 Agent 工具委派。

> 二者差异：正文委派 = 主代理判断后委派（灵活，可先补充上下文）；`agent_type` 硬绑定 = Skill 即 agent（确定性更强，但少了主代理的上下文整理环节）。
