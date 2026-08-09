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
app.use(createGlobalLimiter());

// 基础中间件
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

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

    queue.startTimeoutScanner();
    console.log('[队列] 超时扫描已启动');

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
