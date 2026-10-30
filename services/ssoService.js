/**
 * 企业 SSO（OAuth2 / OIDC 授权码模式，配置驱动）
 *
 * 设计取舍：
 *   - 不绑定具体厂商（企微 / 钉钉 / GitHub / Keycloak / Azure AD 都能接），
 *     只要求三个 URL + client 凭据，私有化环境用自建 OIDC 即可；
 *   - 环境变量在**调用时**读取（不在模块顶层固化），否则测试改不了配置；
 *   - state 只存内存（单实例网关足够；多实例部署需换共享存储，见 docs/DEPLOY.md）；
 *   - 回调把 JWT 放在 URL fragment（`#token=`）交给前端，避免 token 进服务端日志与 Referer。
 *
 * 配置示例（.env）：
 *   SSO_PROVIDERS=corp
 *   SSO_CORP_LABEL=公司统一登录
 *   SSO_CORP_CLIENT_ID=...
 *   SSO_CORP_CLIENT_SECRET=...
 *   SSO_CORP_AUTH_URL=https://id.example.com/oauth2/authorize
 *   SSO_CORP_TOKEN_URL=https://id.example.com/oauth2/token
 *   SSO_CORP_USERINFO_URL=https://id.example.com/oauth2/userinfo
 *   SSO_CORP_SCOPE=openid profile email
 *   SSO_CORP_DEFAULT_ROLE=engineer
 *   SSO_AUTO_CREATE=true          # 首次登录自动建号（false 时仅允许已存在账户）
 *   SSO_LINK_BY_EMAIL=true        # 按邮箱把 SSO 身份绑定到既有本地账户
 */
const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map(); // state -> { name, next, expires }

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** 已配置且完整的提供方（缺关键字段的直接忽略，避免半配置导致 500） */
function listProviders() {
  const names = String(env('SSO_PROVIDERS', '')).split(',')
    .map(s => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const name of names) {
    const p = getProvider(name);
    if (p) out.push({ name: p.name, label: p.label });
  }
  return out;
}

function getProvider(name) {
  const n = String(name || '').toLowerCase();
  if (!n || !/^[a-z0-9_-]+$/.test(n)) return null;
  const up = n.toUpperCase();
  // 只暴露显式声明过的提供方，避免任意 env 前缀被当成配置
  const declared = String(env('SSO_PROVIDERS', '')).split(',').map(s => s.trim().toLowerCase());
  if (!declared.includes(n)) return null;
  const p = {
    name: n,
    label: env(`SSO_${up}_LABEL`, n),
    clientId: env(`SSO_${up}_CLIENT_ID`, ''),
    clientSecret: env(`SSO_${up}_CLIENT_SECRET`, ''),
    authUrl: env(`SSO_${up}_AUTH_URL`, ''),
    tokenUrl: env(`SSO_${up}_TOKEN_URL`, ''),
    userinfoUrl: env(`SSO_${up}_USERINFO_URL`, ''),
    scope: env(`SSO_${up}_SCOPE`, 'openid profile email'),
    idField: env(`SSO_${up}_ID_FIELD`, 'sub'),
    usernameField: env(`SSO_${up}_USERNAME_FIELD`, 'preferred_username'),
    emailField: env(`SSO_${up}_EMAIL_FIELD`, 'email'),
    nameField: env(`SSO_${up}_NAME_FIELD`, 'name'),
    defaultRole: env(`SSO_${up}_DEFAULT_ROLE`, 'engineer'),
  };
  if (!p.clientId || !p.clientSecret || !p.authUrl || !p.tokenUrl || !p.userinfoUrl) return null;
  return p;
}

function autoCreateEnabled() { return String(env('SSO_AUTO_CREATE', 'true')).toLowerCase() !== 'false'; }
function linkByEmailEnabled() { return String(env('SSO_LINK_BY_EMAIL', 'true')).toLowerCase() !== 'false'; }

/** 只接受站内相对路径，防开放重定向 */
function sanitizeNext(next) {
  const fallback = '/workbench.html';
  if (!next || typeof next !== 'string') return fallback;
  if (next.charAt(0) !== '/' || next.charAt(1) === '/' || next.charAt(1) === '\\') return fallback;
  if (next.indexOf('\\') !== -1 || next.indexOf('\n') !== -1) return fallback;
  return next;
}

function createState({ name, next, now }) {
  const state = crypto.randomBytes(24).toString('hex');
  states.set(state, { name, next: sanitizeNext(next), expires: (now || Date.now()) + STATE_TTL_MS });
  return state;
}

/** 一次性消费：状态无效 / 过期 / 与提供方不符 都返回 null */
function consumeState(state, name, now) {
  if (!state || typeof state !== 'string') return null;
  const rec = states.get(state);
  if (!rec) return null;
  states.delete(state); // 一次性：无论后续校验是否通过都不再可用
  if (rec.expires < (now || Date.now())) return null;
  if (name && rec.name !== String(name).toLowerCase()) return null;
  return rec;
}

function buildAuthorizeUrl(provider, { redirectUri, state }) {
  const u = new URL(provider.authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', provider.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', provider.scope);
  u.searchParams.set('state', state);
  return u.toString();
}

/** 用授权码换 access_token（标准 OAuth2 form 表单） */
async function exchangeCode(provider, { code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {
    // 少数 IdP 返回 form 编码：退化为解析 key=value
    const q = new URLSearchParams(text);
    data = Object.fromEntries(q.entries());
  }
  if (!res.ok || !data || !data.access_token) {
    throw new Error('换取令牌失败：' + (data && (data.error_description || data.error) || res.status));
  }
  return data;
}

async function fetchUserinfo(provider, accessToken) {
  const res = await fetch(provider.userinfoUrl, {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('获取用户信息失败：' + res.status);
  return res.json();
}

/** 从 IdP 返回的用户信息里提取本地账户字段 */
function mapProfile(provider, info) {
  const pick = (field) => (field ? info[field] : undefined);
  const subject = String(pick(provider.idField) || '').trim();
  const email = String(pick(provider.emailField) || '').trim() || null;
  const name = String(pick(provider.nameField) || '').trim() || null;
  let username = String(pick(provider.usernameField) || '').trim();
  if (!username) username = email ? email.split('@')[0] : '';
  if (!username) username = `${provider.name}_${subject || crypto.randomBytes(4).toString('hex')}`;
  // 用户名只保留安全字符，避免注入与奇怪路径（连点/前导点一并收敛）
  username = username.replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.').replace(/^[._-]+/, '').slice(0, 48);
  if (!username) username = `${provider.name}_${subject || crypto.randomBytes(4).toString('hex')}`;
  return { subject, email, name, username };
}

/** 清理过期状态（扫描器友好；也可不调用，consume 时按需判断） */
function sweep(now) {
  const ts = now || Date.now();
  for (const [k, v] of states) if (v.expires < ts) states.delete(k);
}

module.exports = {
  STATE_TTL_MS,
  listProviders, getProvider, autoCreateEnabled, linkByEmailEnabled,
  sanitizeNext, createState, consumeState, buildAuthorizeUrl,
  exchangeCode, fetchUserinfo, mapProfile, sweep,
  _states: states,
};
