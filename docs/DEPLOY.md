# Human as Agent · 部署手册

> 项目原名「人工代理网关（Human-as-LLM）」，现为 **Human as Agent（人即智能体）**。
> 本文档覆盖 **Windows 与 Linux** 两端：环境准备 → 数据库 → 配置 → 安装 → 启动 → 验证 → 接入 → 运维。

---

## 一、架构与端口

| 项 | 值 |
|---|---|
| 服务端口 | `39000`（监听 `0.0.0.0`） |
| 数据库 | PostgreSQL（库 `p390`） |
| 工作台 | `http://<服务器IP>:39000/login.html` |
| OpenAI 兼容接口 | `http://<服务器IP>:39000/v1/chat/completions` |
| 健康检查 | `GET /api/health` |

```
上游 Agent（Claude Code / Codex / OpenCode …）
        │ OpenAI /v1（human-llm）
        ▼
Human as Agent 网关（39000）
   ├─ 人工任务 → 工程师工作台（接单/完成/审批/质量）
   ├─ AI 中继（可选，AI_RELAY_* → DeepSeek 等）
   └─ 多租户（upstream_key → 租户隔离）
        │ PostgreSQL（p390）
```

---

## 二、环境要求

- **Node.js 20+**（`node -v` 验证）
- **PostgreSQL 12+**（`psql --version` 验证）
- 网络：服务器可被上游 Agent 访问（局域网/公网 IP）

---

## 三、数据库准备（PostgreSQL）

### Linux
```bash
sudo -u postgres psql -c "CREATE USER p390 WITH PASSWORD '你的密码';"
sudo -u postgres psql -c "CREATE DATABASE p390 OWNER p390;"
```

### Windows
用 pgAdmin 或 psql 创建同名库/用户，或直接：
```sql
CREATE USER p390 WITH PASSWORD '你的密码';
CREATE DATABASE p390 OWNER p390;
```

> 表结构由应用首次启动时自动创建（`db/index.js` 幂等建表 + 迁移）。

---

## 四、应用配置（.env）

复制 `.env.example`（若有）或手工创建 `.env`，关键变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务端口 | `39000` |
| `DB_TYPE` | 数据库类型 | `pg` |
| `PG_HOST` / `PG_PORT` | PG 地址/端口 | `localhost` / `5432`（本机可 5433） |
| `PG_DATABASE` | 库名 | `p390` |
| `PG_USER` / `PG_PASSWORD` | 库用户/密码 | — |
| `JWT_SECRET` | JWT 密钥（**必须改**） | — |
| `HUMAN_LLM_MODEL` | 人工模型名（协议名，勿改） | `human-llm` |
| `TASK_PENDING_TIMEOUT_MIN` | 待接单超时（基准） | `60` |
| `TASK_PROCESSING_TIMEOUT_MIN` | 处理中超时（基准） | `120` |
| `UPSTREAM_API_KEY` | 上游鉴权 key（可选） | 空 |
| `AI_RELAY_ENABLED` | AI 中继开关 | `true` |
| `AI_RELAY_BASE_URL` / `AI_RELAY_API_KEY` | AI provider 地址/key | `https://api.deepseek.com` |
| `AI_RELAY_MODELS` | 走 AI 中继的模型 | `deepseek-v4-flash` |
| `AI_SHIFT_ENABLED` | 智能漂移（general 直接 AI 承接） | `false` |
| `USER_REGISTER_MODE` | `open` 注册即用 / `audit` 审核 | `open` |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | 邮件（可选） | — |
| `NOTIFY_EMAIL_TO` / `NOTIFY_WEBHOOK_URL` | 通知渠道（可选） | — |
| `GATEWAY_INSTALL_ROOT` | 服务器端安装根（可选） | `data/installed` |

---

## 五、安装与初始化

```bash
npm install          # 安装依赖
npm run seed         # 播种默认账户（admin/engineer1/engineer2）
npm start            # 启动（node server.js）
```

默认账户：`admin / admin123`（管理员）、`engineer1 / engineer2 / admin123`（工程师）。**生产环境务必改密。**

---

## 六、启动与进程管理

### 前台（调试）
```bash
node server.js
```

### Windows（bg.ps1 托管）
```powershell
powershell -ExecutionPolicy Bypass -File G:\dev\scripts\bg.ps1 start -Name p390 -Command "node server.js" -Dir <项目目录>
# 查看：bg.ps1 list；停止：bg.ps1 kill -Name p390
```

### Linux（推荐 pm2）
```bash
npm i -g pm2
pm2 start server.js --name p390
pm2 save && pm2 startup    # 开机自启
pm2 logs p390              # 看日志
```

### Linux（systemd，可选）
```ini
[Unit]
Description=Human as Agent
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/p390
ExecStart=/usr/bin/node server.js
Restart=always
EnvironmentFile=/opt/p390/.env

[Install]
WantedBy=multi-user.target
```
```bash
sudo cp p390.service /etc/systemd/system/ && sudo systemctl enable --now p390
```

---

## 七、部署后验证清单

```bash
# 1. 健康检查
curl http://localhost:39000/api/health          # → service: p390-human-as-agent

# 2. 模型列表（应含 human-llm）
curl http://localhost:39000/v1/models

# 3. 登录
curl -X POST http://localhost:39000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# → 返回 token

# 4. 工作台（浏览器）
# http://<IP>:39000/login.html → 登录 → 工作台/队列/审批/项目/接入配置

# 5. OpenAI 兼容提交（人工任务，异步受理）
curl -X POST http://localhost:39000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"human-llm","messages":[{"role":"user","content":"测试任务"}],"category":"ops"}'
# → 立即返回 task_id + status:pending

# 6. 回查
curl http://localhost:39000/v1/tasks/<task_id>
# → completed 取产出 / 未完成反馈状态
```

---

## 八、上游 Agent 接入（多工具安装）

「接入配置」页（`#/gateway`）生成安装包：

| 工具 | 生成文件 |
|---|---|
| Claude Code | `.claude/skills/dispatch-human/SKILL.md` + `.claude/agents/humanllm.md` |
| Codex / 通用 | `AGENTS.md` |
| OpenCode | `AGENTS.md` + `.opencode/command/dispatch-human.md` |
| Gemini / Cursor / Windsurf / Aider 等 | `GEMINI.md` / `.cursor/rules/` / `CONVENTIONS.md` 等 |
| 本机全装 | `p390-install.js`（扫描本机 agent CLI 一并写入） |

- **客户端安装**：复制安装提示词 → 目标项目粘贴 → 自动写入
- **服务器端安装**（admin）：接入配置页「服务器端安装」→ 指定目标子目录 → P390 直接写入 `GATEWAY_INSTALL_ROOT/<目录>`
- **在线微调**：每个工具的文件可在页面上编辑保存，重新生成安装包即含微调内容

---

## 九、通知与 AI 中继配置

- **通知**（工程师离线不再=任务超时）：`NOTIFY_EMAIL_TO`（邮件，需 SMTP）或 `NOTIFY_WEBHOOK_URL`（企微/钉钉文本 webhook）。新任务/超时/审批待办自动通知。
- **AI 中继**：配置 `AI_RELAY_API_KEY` 后，命中 `AI_RELAY_MODELS` 的请求直接中继真实 LLM；人工任务待接单超时（仅 general）可 AI 代答。
- **智能漂移**：`AI_SHIFT_ENABLED=true` 时，general 且未被分级规则锁定的简单任务直接 AI 承接（省人工），涉密/运维类锁死不走 AI。

---

## 十、升级

```bash
# 1. 备份数据库（见下节）
# 2. 拉新代码
git pull
# 3. 装依赖 + 建表迁移（幂等，自动补列）
npm install
npm run seed        # 幂等，不影响已有数据
# 4. 重启
pm2 restart p390    # 或 bg.ps1 kill + start
```

> 表结构变更走 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 幂等迁移，升级无需手工改库。

---

## 十一、备份与恢复

### 一键备份

```bash
node scripts/backup.js              # → data/backups/p390-YYYYMMDD-HHmmss.sql.gz
node scripts/backup.js --keep 14    # 保留最近 14 份（默认，可用 BACKUP_KEEP 覆盖）
node scripts/backup.js --dry-run    # 只打印将要执行的命令，不落盘
node scripts/backup.js --out D:\p390-backup   # 指定目录
```

产物三件套：

| 产物 | 说明 |
|---|---|
| `p390-<ts>.sql.gz` | `pg_dump --no-owner --no-privileges --clean --if-exists` 流式 gzip |
| `p390-<ts>.files/` | `gateway_config.json` / `gateway_files.json` / `gateway_skill.md` / `gateway_agent.md` |
| `manifest.jsonl` | 每行 `{ts,file,bytes,sha256,db,host}`，供工作台历史查询 |

备份后自动校验：文件 > 1KB、gzip 魔数与解压、内容含 `PostgreSQL database dump`，任一不过则删除残包并退出码 1。

`--clean --if-exists` 让备份可**直接覆盖恢复到已有库**，否则恢复到已存在的库会因 `relation already exists` 整体失败。配合 `psql --single-transaction`，恢复失败即整体回滚。

### 定时备份

Windows 任务计划程序（每天 02:00）：

```powershell
schtasks /create /tn "p390-backup" /sc daily /st 02:00 /tr "\"C:\Program Files\nodejs\node.exe\" G:\dev\p390\scripts\backup.js --quiet"
```

Linux crontab：

```cron
0 2 * * * cd /opt/p390 && /usr/bin/node scripts/backup.js --quiet >> logs/backup.log 2>&1
```

### 恢复

```bash
# 1) 先停服务，避免恢复期间有写入
pm2 stop p390
# 2) 恢复（非 --yes 时必须手输 RESTORE；会先自动备份当前库并打印路径）
node scripts/restore.js data/backups/p390-20261030-020000.sql.gz
# 3) 启动并自测
pm2 start p390
curl -s http://192.168.168.3:39000/api/health
```

安全护栏：

1. 非 `--yes` 时必须交互输入 `RESTORE`（非 TTY 环境直接拒绝，防 CI 挂起）
2. 恢复前**强制自动备份当前库**，路径打印在日志里；可用 `--no-safety-backup` 跳过（不推荐）
3. `psql --single-transaction --set ON_ERROR_STOP=1`，任一语句失败整体回滚
4. 恢复后自动打印表数量与 `users` / `tasks` 行数

### 恢复演练（可进 CI）

```bash
node scripts/drill-restore.js               # 备份 → 恢复临时库 → 比对 → 删临时库
node scripts/drill-restore.js --keep-backup # 保留演练备份供排查
```

输出 `{ backup_file, backup_bytes, tables, rows_before, rows_after, match, duration_ms }`；任一表行数不一致退出码 1；临时库 `p390_drill_<ts>` 在 `finally` 中必删。演练备份写在 `data/backups/drill/`，不污染正式 manifest。

### 工作台触发

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/backup/list` | admin | 备份历史（manifest 倒序，缺失时回退扫描磁盘） |
| POST | `/api/backup/run` | admin | 异步备份，立即返回 `{started:true}`，进度走 Socket.IO `backup:progress` |
| GET | `/api/backup/status` | admin | 是否在跑 + 最近一次结果 + 磁盘份数 |

`/run` 有进程内互斥，同一时刻只允许一个备份；并发请求返回 409。

### ⚠️ PG 客户端版本

`pg_dump` / `psql` / `createdb` / `dropdb` **通常不在 PATH**。脚本自动按 `PG_BIN` → PATH → 常见安装目录探测，取主版本最高的 `bin`。

**客户端版本必须 ≥ 服务端**：PG18 的 dump 含 `SET transaction_timeout = 0;`（PG17 引入），用 psql 16 恢复会报 `unrecognized configuration parameter`。脚本内置版本闸门，不匹配时直接拒绝并提示。

---

## 十二、监控（Prometheus）

```bash
curl -s http://192.168.168.3:39000/metrics | head -40
```

`prometheus.yml`：

```yaml
scrape_configs:
  - job_name: p390
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ['192.168.168.3:39000']
```

指标清单：

| 指标 | 类型 | 说明 |
|---|---|---|
| `p390_http_requests_total{method,route,status}` | Counter | route 为路由模板，未匹配归 `unmatched` |
| `p390_http_request_duration_seconds{method,route}` | Histogram | 桶 .005…10 |
| `p390_tasks{status}` / `p390_tasks_by_category{category}` | Gauge | 每 15s 刷新 |
| `p390_tasks_overdue` | Gauge | 超 `timeout_at` 且未终态 |
| `p390_approvals{status}` / `p390_alerts_active{level}` | Gauge | |
| `p390_engineers_active` | Gauge | `is_active=true` 的工程师 |
| `p390_billing_amount_cents_total` | Gauge | 计费流水总额 |
| `p390_db_up` | Gauge | 1/0 |
| `p390_ai_relay_total{result}` / `p390_task_timeout_total{phase}` | Counter | 供业务自增 |

开关：`METRICS_ENABLED=false` 关闭端点与采集；配置 `METRICS_TOKEN` 后需 `Authorization: Bearer <token>`。`/metrics` 挂在全站限流之前，抓取请求不占用 `RATE_LIMIT` 额度。

建议告警：`p390_db_up == 0`（2 分钟）、`p390_tasks_overdue > 0`（10 分钟）、`rate(p390_ai_relay_total{result="failed"}[5m]) > 0.2`。

关键数据表：`tasks` / `task_logs` / `request_logs` / `approvals` / `projects` / `users` / `task_rules` / `tenants` / `task_templates` / `alerts` / `billing_rates` / `billing_ledger`。
应用配置：`.env` + `data/gateway_config.json`（网关接入配置）。

---

## 十三、PWA 与 HTTPS

浏览器只在**安全上下文**下允许注册 Service Worker 与请求通知权限：

| 访问地址 | 能否装 PWA |
|---|---|
| `http://localhost:39000` / `http://127.0.0.1:39000` | ✅（本机验证用这个） |
| `http://192.168.168.3:39000` | ❌ 非安全上下文 |
| `https://your.domain` | ✅（需配证书） |

局域网/远程要装 PWA，需 Caddy 或 nginx 反代 + HTTPS 证书：

```caddyfile
p390.example.com {
  reverse_proxy 127.0.0.1:39000
  # SSE 不缓冲（/v1 stream_events、任务事件流）
  reverse_proxy {
    to 127.0.0.1:39000
    flush_interval -1
  }
}
```

nginx 等价配置需 `proxy_buffering off;` 与 `proxy_read_timeout 3600s;`，否则 SSE 中途推送会被缓冲。

反代后设置 `.env`：

```dotenv
PUBLIC_BASE_URL=https://your.domain
```

（用于密码重置链接与通知深链；PWA 本身用相对 URL，不依赖它。）

**验证步骤**：

1. `http://localhost:39000/login.html` → DevTools → Application → Manifest 无错误、可 Install
2. Application → Service Workers：`/sw.js` activated
3. Network 面板确认 `/api/*`、`/socket.io/*` **不经** ServiceWorker 缓存
4. 勾选 Offline → 刷新 → 落到 `/offline.html`
5. 侧栏「开启通知」授权后，另开窗口建任务 → 后台标签收到系统通知，点击聚焦工作台

**注意**：
- 改前端代码后必须递增 `public/sw.js` 的 `VERSION`，否则旧缓存不会清理
- Service Worker 明确不缓存 `/api/*`、`/v1/*`、`/socket.io/*`（携带 JWT 与租户数据，缓存会导致登出后越权读取）
- 本项目不引入 Web Push / VAPID：通知依赖页面内 Socket.IO 在线，完全关闭浏览器后收不到（刻意的取舍，避免额外服务依赖）

---

## 十四、安全基线

1. **改默认密码**：admin/engineer 账户部署后立即改密。
2. **改 `JWT_SECRET`**：生产必须唯一随机。
3. **`UPSTREAM_API_KEY`**：对外暴露 `/v1` 时配置，校验上游。
4. **多租户隔离**：各企业 `upstream_key` 路由到独立租户，数据隔离（工作台/任务/审批/项目/规则）。
5. **涉密保护**：`confidential`/`ops` 任务**禁 AI 兜底**（分级引擎锁死），上下文不出网关。
6. **合规报告**：`#/dashboard`「合规报告」可审计「数据不出网关」证明。
7. **服务器端安装**：仅 admin，目标路径限制在 `GATEWAY_INSTALL_ROOT` 内（越界拒绝）。
8. 按项目约定不启用 CSP/HSTS（内部 HTTP）；对外部署建议前置 HTTPS。

---

## 十五、故障排查（FAQ）

| 现象 | 排查 |
|---|---|
| 启动报 PG 连接失败 | 检查 `.env` 的 `PG_*`、PG 服务是否运行（`pg_isready`） |
| `/api/health` 404 | 端口不对或未启动（`netstat -ano \| grep 39000` / `ss -ltnp`） |
| 任务一直 pending 无人接 | 工程师未登录工作台接单；通知未配 → 配 `NOTIFY_*` |
| 涉密任务超时回落 returned | 属**设计行为**（禁 AI 兜底），改上下文重派即可 |
| `/v1` 提交返回 401 | `UPSTREAM_API_KEY` 已配置但未带 key |
| 审批超时无提醒 | `NOTIFY_WEBHOOK_URL`/`NOTIFY_EMAIL_TO` 未配 |
| 中文乱码 | 确认 `.env`/文件 UTF-8；响应头含 `charset=utf-8` |
| Linux 无法访问 | 防火墙放行 `39000`；进程监听 `0.0.0.0` |

---

## 十六、跨平台注意

- 命令统一用 `curl`（Windows 10+ 原生自带，无需 `curl.exe`）。
- SKILL/AGENT 模板已跨平台（相对路径，网关地址安装时替换）。
- 进程管理：Windows = `bg.ps1`；Linux = `pm2` / `systemd`。
- 数据库两端同一 PostgreSQL，仅连接参数不同。


---

## 💬 支持与交流

本项目支持 QQ 交流群：**6181193**。二次开发、问题反馈、需求讨论欢迎加入。

