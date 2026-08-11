const jwt = require('jsonwebtoken');

/**
 * JWT 认证中间件
 * 从 Authorization header 读取 Bearer token 并验证
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.tenant_id = decoded.tenant_id || null; // 多租户：请求所属租户
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '令牌已过期' });
    }
    return res.status(401).json({ error: '无效的认证令牌' });
  }
}

/**
 * 签发 JWT token
 * @param {Object} payload - token 载荷
 * @returns {string} JWT token
 */
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

/**
 * 角色检查中间件
 * @param {string} role - 要求的角色
 * @returns {Function} Express 中间件
 */
function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

module.exports = { authenticate, signToken, requireRole };
