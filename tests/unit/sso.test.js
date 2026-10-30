/**
 * 单元测试：SSO 纯逻辑（不连库、不联网）
 * - 开放重定向防护（next 只接受站内相对路径）
 * - state 一次性 + 过期
 * - 提供方配置不完整时不可用
 * - 用户信息映射（用户名兜底与清洗）
 */
const { test } = require('node:test');
const assert = require('node:assert');

const sso = require('../../services/ssoService');

function withEnv(vars, fn) {
  const backup = {};
  for (const [k, v] of Object.entries(vars)) {
    backup[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const FULL = {
  SSO_PROVIDERS: 'corp',
  SSO_CORP_LABEL: '公司统一登录',
  SSO_CORP_CLIENT_ID: 'cid',
  SSO_CORP_CLIENT_SECRET: 'secret',
  SSO_CORP_AUTH_URL: 'https://id.example.com/authorize',
  SSO_CORP_TOKEN_URL: 'https://id.example.com/token',
  SSO_CORP_USERINFO_URL: 'https://id.example.com/userinfo',
};

test('未配置时没有任何提供方', () => {
  withEnv({ SSO_PROVIDERS: undefined }, () => {
    assert.deepStrictEqual(sso.listProviders(), []);
    assert.strictEqual(sso.getProvider('corp'), null);
  });
});

test('配置完整才可用；缺字段的提供方被忽略', () => {
  withEnv(FULL, () => {
    const list = sso.listProviders();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'corp');
    assert.strictEqual(list[0].label, '公司统一登录');
  });
  withEnv({ ...FULL, SSO_CORP_TOKEN_URL: '' }, () => {
    assert.deepStrictEqual(sso.listProviders(), [], '缺 token 端点不得暴露给前端');
  });
});

test('未在 SSO_PROVIDERS 中声明的名字不可用（防止任意 env 前缀被当成配置）', () => {
  withEnv({ ...FULL, SSO_PROVIDERS: 'corp', SSO_OTHER_CLIENT_ID: 'x' }, () => {
    assert.strictEqual(sso.getProvider('other'), null);
    assert.strictEqual(sso.getProvider('../evil'), null);
  });
});

test('sanitizeNext：只接受站内相对路径', () => {
  assert.strictEqual(sso.sanitizeNext('/workbench.html'), '/workbench.html');
  assert.strictEqual(sso.sanitizeNext('/queue?x=1'), '/queue?x=1');
  assert.strictEqual(sso.sanitizeNext('//evil.com'), '/workbench.html');
  assert.strictEqual(sso.sanitizeNext('https://evil.com'), '/workbench.html');
  assert.strictEqual(sso.sanitizeNext('/a\\b'), '/workbench.html');
  assert.strictEqual(sso.sanitizeNext(''), '/workbench.html');
  assert.strictEqual(sso.sanitizeNext(null), '/workbench.html');
});

test('state：一次性消费、过期失效、提供方不匹配拒绝', () => {
  withEnv(FULL, () => {
    const p = sso.getProvider('corp');
    const now = 1_000_000;
    const st = sso.createState({ name: p.name, next: '//evil.com', now: now });
    const first = sso.consumeState(st, 'corp', now + 1000);
    assert.ok(first);
    assert.strictEqual(first.next, '/workbench.html', 'next 在建 state 时就被清洗');
    assert.strictEqual(sso.consumeState(st, 'corp', now + 2000), null, 'state 只能用一次');

    const st2 = sso.createState({ name: 'corp', next: '/queue', now });
    assert.strictEqual(sso.consumeState(st2, 'other', now), null, '提供方不匹配');
    assert.strictEqual(sso.consumeState(st2, 'corp', now), null, '校验失败也已消费掉');

    const st3 = sso.createState({ name: 'corp', next: '/queue', now });
    assert.strictEqual(sso.consumeState(st3, 'corp', now + sso.STATE_TTL_MS + 1), null, '过期');
  });
});

test('buildAuthorizeUrl：带上 code 流程必备参数', () => {
  withEnv(FULL, () => {
    const p = sso.getProvider('corp');
    const url = new URL(sso.buildAuthorizeUrl(p, { redirectUri: 'http://gw/api/auth/sso/corp/callback', state: 'abc' }));
    assert.strictEqual(url.origin + url.pathname, 'https://id.example.com/authorize');
    assert.strictEqual(url.searchParams.get('response_type'), 'code');
    assert.strictEqual(url.searchParams.get('client_id'), 'cid');
    assert.strictEqual(url.searchParams.get('state'), 'abc');
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://gw/api/auth/sso/corp/callback');
  });
});

test('mapProfile：用户名兜底与清洗，绝不产生路径/注入字符', () => {
  withEnv(FULL, () => {
    const p = sso.getProvider('corp');
    const a = sso.mapProfile(p, { sub: 'u-1', email: 'zhang@corp.com', name: '张三' });
    assert.strictEqual(a.subject, 'u-1');
    assert.strictEqual(a.username, 'zhang', '无 preferred_username 时用邮箱前缀');
    assert.strictEqual(a.name, '张三');

    const b = sso.mapProfile(p, { sub: 'u 2', preferred_username: '../../etc/passwd' });
    assert.ok(!b.username.includes('/'), '非法字符被替换');
    assert.ok(!b.username.includes('..'));

    const c = sso.mapProfile(p, {});
    assert.strictEqual(c.subject, '', '缺主体时留空，由调用方判断');
    assert.ok(c.username.length > 0);
  });
});
