require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { initDatabase } = require('./db');
const routes = require('./routes/index');
const { securityHeaders, corsOptions, createGlobalLimiter } = require('./middleware/security');
const wsService = require('./services/websocket');
const queue = require('./services/queueService');
const approval = require('./services/approvalService');
const alertService = require('./services/alertService');
const billing = require('./services/billingService');
const metrics = require('./services/metricsService');
const metricsRoutes = require('./routes/metrics');
const { translateJson } = require('./services/i18n');

const app = express();
const PORT = parseInt(process.env.PORT) || 39000;

// ===== HTTP Server + Socket.IO =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/socket.io',
});

// Socket.IO JWT 认证
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('未提供认证令牌'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (e) {
    next(new Error('认证失败'));
  }
});

io.on('connection', (socket) => {
  console.log(`[WebSocket] 用户连接: ${socket.user.username || socket.user.id}`);
  if (socket.user.id) socket.join(`user:${socket.user.id}`);
  if (socket.user.role === 'admin' || socket.user.role === 'sys_admin') socket.join('admin');
  socket.join('system');
  socket.on('disconnect', () => {
    console.log(`[WebSocket] 用户断开: ${socket.user.username || socket.user.id}`);
  });
});

wsService.setIO(io);

// ===== 基础安全中间件（不含 CSP / HSTS） =====
app.use(securityHeaders);
app.use(cors(corsOptions()));

// /metrics 在全站限流之前挂载 → 抓取请求不占用 RATE_LIMIT 额度
if (metrics.isEnabled()) app.use('/metrics', metricsRoutes);

app.use(createGlobalLimiter());
app.use(metrics.metricsMiddleware);   // 只记录不拦截，须早于业务路由

// 基础中间件
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// i18n：按 Accept-Language 翻译用户可见 message（en 时）
app.use(translateJson);

// ===== PWA 静态资源缓存头 =====
// manifest 必须用 application/manifest+json，express 默认给 application/json，部分浏览器会忽略清单
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// 静态文件服务（sw.js 强制 no-cache：Worker 文件被长期缓存会导致新版本永远不生效）
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/sw\.js$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// 注册路由
routes(app);

// 404
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.message);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

// 启动
async function start() {
  try {
    await initDatabase();
    console.log('[数据库] 初始化完成');

    // 后台扫描器会周期性地扫全库；若在同一库上并发跑集成测试会互相干扰
    // （典型症状：计费/告警/超时用例偶发断言失败）。SCANNERS_ENABLED=false 全部关闭。
    if (process.env.SCANNERS_ENABLED !== 'false') {
      queue.startTimeoutScanner();
      console.log('[队列] 超时扫描已启动');

      approval.startApprovalScanner();
      console.log('[审批] 超时提醒已启动');

      alertService.startEscalationScanner();
      console.log('[告警] 升级序列扫描已启动');

      billing.startBillingScanner();
      console.log('[计费] 补结算扫描已启动（60s）');
    } else {
      console.log('[扫描器] SCANNERS_ENABLED=false，已跳过全部后台扫描');
    }

    await billing.seedRates();            // 幂等：全局默认费率
    console.log('[计费] 默认费率就绪');

    metrics.startGaugeRefresher();
    if (metrics.isEnabled()) console.log('[监控] 业务指标刷新已启动（15s）');

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Human-as-LLM 人工代理网关已启动: http://0.0.0.0:${PORT}`);
      console.log(`OpenAI 兼容接口: http://192.168.168.3:${PORT}/v1/chat/completions`);
    });
  } catch (err) {
    console.error('[启动失败]', err);
    process.exit(1);
  }
}

start();

module.exports = { app, io, server };
