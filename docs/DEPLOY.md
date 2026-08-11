# Human as Agent 部署（Windows / Linux）

## 环境要求
- Node.js 20+
- PostgreSQL（库名 `p390`）

## Windows（开发/演示）
```powershell
# 安装依赖 + 建表 + 启动（监听 0.0.0.0:39000）
npm install
npm run seed
npm start
```
服务托管用 `bg.ps1`：
```powershell
powershell -ExecutionPolicy Bypass -File G:\dev\scripts\bg.ps1 start -Name p390 -Command "node server.js" -Dir G:\dev\p390
```

## Linux（生产）
```bash
# 1. 依赖
apt install -y nodejs npm postgresql

# 2. 建库
sudo -u postgres psql -c "CREATE DATABASE p390;"

# 3. 配置 .env（复制 .env 调整）
#    DB_TYPE=pg、PG_HOST/PORT/USER/PASSWORD、PG_DATABASE=p390、JWT_SECRET、PORT=39000

# 4. 安装 + 建表 + 启动
npm install
npm run seed
node server.js &          # 临时前台；生产用 pm2/systemd

# 5. 进程管理（推荐 pm2）
npm i -g pm2
pm2 start server.js --name p390
pm2 save && pm2 startup   # 开机自启

# 6. 验证
curl http://localhost:39000/api/health   # → {"service":"p390-human-as-agent",...}
```

### systemd 单元（可选）
```ini
[Unit]
Description=Human as Agent
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/p390
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## 关键环境变量（.env）
`PORT`、`DB_TYPE=pg`、`PG_HOST`、`PG_PORT`、`PG_DATABASE=p390`、`PG_USER`、`PG_PASSWORD`、`JWT_SECRET`、
`HUMAN_LLM_MODEL=human-llm`、`TASK_PENDING/PROCESSING_TIMEOUT_MIN`、`AI_RELAY_*`（AI 中继）、
`USER_REGISTER_MODE`、`NOTIFY_EMAIL_TO`、`NOTIFY_WEBHOOK_URL`、`GATEWAY_INSTALL_ROOT`（服务器端安装根，可选）

## 跨平台说明
- **核心服务**（Node + Express + Socket.IO + PostgreSQL）完全跨平台。
- **命令**统一用 `curl`（Windows 10+ 原生自带，无需 `curl.exe`）。
- **SKILL/AGENT 模板已跨平台**：文件路径用相对（`data/`、`.claude/`），网关地址在「接入配置」页生成安装包时按配置域名替换。
- **进程管理**：Windows = `bg.ps1`；Linux = `pm2` / `systemd`。
- **数据库**：两端同一 PostgreSQL；仅连接参数不同（Linux 常用 unix socket 或 localhost）。
