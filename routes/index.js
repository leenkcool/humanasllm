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
const projectRoutes = require('./projects');
const auditRoutes = require('./audit');
const ruleRoutes = require('./rules');
const tenantRoutes = require('./tenants');
const gatewayRoutes = require('./gateway');
const prdRoutes = require('./prd');
const templateRoutes = require('./templates');
const dispatchRoutes = require('./dispatch');
const alertRoutes = require('./alerts');
const billingRoutes = require('./billing');
const knowledgeRoutes = require('./knowledge');
const backupRoutes = require('./backup');

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

  // 项目管理
  app.use('/api/projects', projectRoutes);

  // 审计 / 合规报告
  app.use('/api/audit', auditRoutes);

  // 分级规则管理（治理配置后台，admin）
  app.use('/api/rules', ruleRoutes);

  // 工单模板库（常用任务模板化，一键建单）
  app.use('/api/templates', templateRoutes);

  // 智能派单（技能匹配 + 负载均衡 + 历史质量）
  app.use('/api/dispatch', dispatchRoutes);

  // 告警中心（SLA 升级序列 + 审批超时）
  app.use('/api/alerts', alertRoutes);

  // 计费计量（人力成本可核算 + 租户账单）
  app.use('/api/billing', billingRoutes);

  // 数据备份（工作台触发 + 历史）
  app.use('/api/backup', backupRoutes);

  // 知识库（答复复用：project / tenant / global 三级作用域）
  app.use('/api/knowledge', knowledgeRoutes);

  // 租户管理（多租户 v1）
  app.use('/api/tenants', tenantRoutes);

  // 网关接入配置（生成 SKILL/AGENT + 在线微调）
  app.use('/api/gateway', gatewayRoutes);

  // PRD 需求沉淀（二次开发验证过的需求写入 PRD.md，git 本地提交）
  app.use('/api/prd', prdRoutes);

  // 健康检查
  const health = (req, res) => res.json({ status: 'ok', service: 'p390-human-as-agent', timestamp: new Date().toISOString() });
  app.get('/api/health', health);
  app.get('/v1/health', health);
};
