# 落地页规范（Landing）

## 定位
宣传 Human as Agent（P390）的静态落地页。三个宣传重点：
1. **给 AI 智能体提效**——13 种工具（workbuddy/claude code/codex/opencode/openclaw/hermes 等）一键生成 SKILL/AGENT，粘贴即装
2. **给平台/运维提效**——工单快速收集、分级治理、审批、质量合规
3. **模型定位**——Human as LLM（人即智能体），OpenAI 兼容 `/v1`

## 架构
```
public/landing/           # 落地页（自包含静态，访问 /landing/）
  index.html              # 单页（语义 HTML 分区）
  assets/css/landing.css  # CSS 变量映射 docs/DESIGN.md tokens
  assets/js/landing.js    # 原生 JS（IIFE）
docs/DESIGN.md            # Stripe 设计系统（getdesign add stripe 生成）
docs/LANDING.md           # 本文档
```

- 纯静态，无框架/后端；不干扰工作台 `public/index.html`
- 设计 token 源：`docs/DESIGN.md` → CSS 变量（`--lp-*`），单点改 token 全局生效

## 页面结构（单页锚点）
`Nav`（sticky）→ `Hero` → `模型墙` → `给智能体提效` → `给平台/运维` → `工作原理` → `治理/合规` → `CTA` → `Footer`

## 代码约定
- **HTML**：语义标签（header/nav/main/section/footer），无 emoji 图标（用内联 SVG）
- **CSS**：设计 token 全部走 `var(--lp-*)`；响应式断点（≤768 手机 / 769-1024 平板 / ≥1025 桌面）；BEM 或语义类
- **JS**：IIFE，仅做交互（sticky 高亮、锚点平滑、移动端菜单），不引库
- **注释**：简短、写给维护者（为什么，非什么）；非必要不写

## 维护
- 改配色/字体：改 `docs/DESIGN.md` 对应 token → 同步 `landing.css` 的 `--lp-*`
- 加区块：`index.html` 加 `section`（带 `id`）→ Nav 加锚点
- 改工具清单：`index.html` 模型墙改数组（JS 渲染或静态列表）
