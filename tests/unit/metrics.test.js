/**
 * 监控指标服务单元测试
 * 覆盖：init 幂等、/metrics 文本输出、中间件在无路由信息时不崩、标签防高基数
 */
const { test } = require('node:test');
const assert = require('node:assert');

const metrics = require('../../services/metricsService');

test('init() 幂等：连续调用两次不抛错', () => {
  assert.doesNotThrow(() => metrics.init());
  assert.doesNotThrow(() => metrics.init());
  assert.ok(metrics.register, '应导出一个 registry');
  assert.strictEqual(typeof metrics.register.metrics, 'function');
});

test('collectGauges() 在数据库不可用时降级不抛错', async () => {
  await assert.doesNotReject(() => metrics.collectGauges());
});

test('renderMetrics 输出包含 p390_ 前缀指标', async () => {
  metrics.init();
  let body = '';
  const headers = {};
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { headers[k] = v; return this; },
    end(chunk) { body += chunk || ''; return this; },
    json(obj) { body += JSON.stringify(obj); return this; },
  };
  await metrics.renderMetrics({ url: '/metrics', headers: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.match(String(headers['Content-Type']), /text\/plain/);
  assert.match(body, /p390_/);
  assert.match(body, /# (HELP|TYPE)/);
});

test('renderMetrics 在 METRICS_ENABLED=false 时返回 404', async () => {
  const prev = process.env.METRICS_ENABLED;
  process.env.METRICS_ENABLED = 'false';
  let code = 0;
  const res = {
    status(c) { code = c; return this; },
    json() { return this; },
  };
  await metrics.renderMetrics({}, res);
  assert.strictEqual(code, 404);
  if (prev === undefined) delete process.env.METRICS_ENABLED;
  else process.env.METRICS_ENABLED = prev;
});

test('metricsMiddleware 在 req.route 缺失时不抛错，并记录 unmatched', async () => {
  metrics.resetForTests();
  const handlers = {};
  const req = { method: 'GET' }; // 故意没有 req.route
  const res = {
    statusCode: 200,
    on(event, fn) { handlers[event] = fn; },
  };
  assert.doesNotThrow(() => metrics.metricsMiddleware(req, res, () => {}));
  assert.strictEqual(typeof handlers.finish, 'function');
  assert.doesNotThrow(() => handlers.finish());

  const text = await metrics.register.metrics();
  assert.match(text, /p390_http_requests_total\{[^}]*route="unmatched"/);
});

test('metricsMiddleware 有路由时使用路由模板而非原始 URL', async () => {
  metrics.resetForTests();
  const handlers = {};
  const req = { method: 'GET', route: { path: '/api/tasks/:id' }, url: '/api/tasks/9527?x=1' };
  const res = { statusCode: 404, on(event, fn) { handlers[event] = fn; } };
  metrics.metricsMiddleware(req, res, () => {});
  handlers.finish();

  const text = await metrics.register.metrics();
  assert.match(text, /route="\/api\/tasks\/:id"/);
  assert.ok(!text.includes('/api/tasks/9527'), '原始 URL 不得进入标签');
});

test('子路由挂载时拼接 baseUrl，避免同名路由混淆', async () => {
  metrics.resetForTests();
  const handlers = {};
  // app.use('/api/tasks', router) 场景：route.path 只是 '/:id'，baseUrl 是挂载前缀
  const req = { method: 'POST', baseUrl: '/api/tasks', route: { path: '/:id/complete' } };
  const res = { statusCode: 200, on(event, fn) { handlers[event] = fn; } };
  metrics.metricsMiddleware(req, res, () => {});
  handlers.finish();

  const text = await metrics.register.metrics();
  assert.match(text, /route="\/api\/tasks\/:id\/complete"/);
});

test('incCounter 支持业务计数器别名', () => {
  metrics.init();
  assert.strictEqual(metrics.incCounter('ai_relay_total', { result: 'success' }), true);
  assert.strictEqual(metrics.incCounter('task_timeout_total', { phase: 'pending' }), true);
  assert.strictEqual(metrics.incCounter('p390_ai_relay_total', { result: 'failed' }), true);
  assert.strictEqual(metrics.incCounter('不存在的指标', {}), false);
  metrics.resetForTests();
});

test('默认标签带 service 标识', async () => {
  metrics.init();
  const text = await metrics.register.metrics();
  assert.match(text, /service="p390-human-as-agent"/);
});
