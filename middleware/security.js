/**
 * 基础安全中间件
 * - 基础安全响应头（不含 CSP / HSTS，按项目约定禁用）
 * - CORS
 * - 请求限流（全局限流 + 登录接口限流）
 */

const rateLimit = require('express-rate-limit');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

function corsOptions() {
  const origins = process.env.CORS_ORIGINS;
  if (origins && origins.trim()) {
    const whitelist = origins.split(',').map(o => o.trim()).filter(Boolean);
    return {
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (whitelist.includes(origin)) return callback(null, true);
        return callback(new Error('CORS 策略拒绝该来源'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    };
  }
  return { origin: '*', credentials: true };
}

function limiterConfig(windowSec, max) {
  return {
    windowMs: (parseInt(windowSec) || 60) * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: '请求过于频繁，请稍后再试' },
    keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
  };
}

function createGlobalLimiter() {
  return rateLimit(limiterConfig(process.env.RATE_LIMIT_WINDOW, parseInt(process.env.RATE_LIMIT_MAX) || 2000));
}

function createLoginLimiter() {
  return rateLimit(limiterConfig(process.env.RATE_LIMIT_WINDOW, parseInt(process.env.RATE_LIMIT_LOGIN_MAX) || 5));
}

module.exports = { securityHeaders, corsOptions, createGlobalLimiter, createLoginLimiter };
