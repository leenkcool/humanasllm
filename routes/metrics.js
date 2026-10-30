/**
 * Prometheus 指标端点
 *  - GET /metrics   Prometheus 抓取端点（text/plain 0.0.4 格式）
 *
 * 认证策略：
 *  - 默认匿名可读（内网部署，Prometheus 抓取方便）
 *  - 配置 METRICS_TOKEN 后必须带 Authorization: Bearer <token>，否则 401
 *  - 本路由由主会话在路由挂载前单独绕过全站限流（见 server.js 接线说明）
 */
'use strict';

const express = require('express');
const metrics = require('../services/metricsService');

const router = express.Router();

/** 可选令牌校验（未配置 METRICS_TOKEN 时直接放行） */
function optionalTokenAuth(req, res, next) {
  const token = process.env.METRICS_TOKEN;
  if (!token) return next();
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供指标访问令牌' });
  }
  const provided = header.slice('Bearer '.length).trim();
  if (provided !== token) {
    return res.status(401).json({ error: '指标访问令牌无效' });
  }
  return next();
}

router.get('/', optionalTokenAuth, metrics.renderMetrics);

module.exports = router;
