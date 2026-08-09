/**
 * 路由总入口
 *  - /api/*         工作台 REST
 *  - /v1/*          OpenAI 兼容接口
 */
const authRoutes = require('./auth');
const userRoutes = require('./users');
const taskRoutes = require('./tasks');
const workbenchRoutes = require('./workbench');
const logRoutes = require('./logs');
const v1Routes = require('./v1');
const approvalRoutes = require('./approvals');

module.exports = function (app) {
  // 工作台 REST
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/workbench', workbenchRoutes);
  app.use('/api/logs', logRoutes);

  // OpenAI 兼容接口（上游 Agent / 调度池直连）
  app.use('/v1', v1Routes);

  // AI 提审批（OpenAI 兼容发起 + 工作台审批）
  app.use('/v1', approvalRoutes);
  app.use('/api/approvals', approvalRoutes);

  // 健康检查
  const health = (req, res) => res.json({ status: 'ok', service: 'p390-human-llm', timestamp: new Date().toISOString() });
  app.get('/api/health', health);
  app.get('/v1/health', health);
};
