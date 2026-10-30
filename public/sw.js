/* sw.js — Human as Agent 工作台 Service Worker
 *
 * 职责边界（重要）：
 *   仅缓存「静态外壳」（HTML / CSS / JS / 图标 / manifest），
 *   绝不缓存任何带身份的接口数据（JWT、租户数据、SSE 流），
 *   离线时回落到 offline.html。PWA 属于增强能力，任何异常都不得影响主应用。
 */

const VERSION = 'p390-v2';
const CACHE_NAME = VERSION;

// 预缓存外壳。注意：列表中任何一项缺失都不应导致整个安装失败（见 install 中逐个 add）。
const SHELL = [
  '/workbench.html', '/mobile.html', '/login.html', '/offline.html',
  '/css/style.css', '/css/mobile.css',
  '/js/i18n.js', '/js/utils.js', '/js/api.js', '/js/ws.js',
  '/js/templates.js', '/js/dispatch.js', '/js/alerts.js', '/js/billing.js',
  '/js/ui.js', '/js/app.js', '/js/pwa.js', '/js/mobile.js',
  '/socket.io/socket.io.js',
  '/manifest.json', '/icons/icon-192.png'
];

// ===== install：逐个预缓存，容忍单个失败 =====
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 用 allSettled 而非 addAll：addAll 是全有或全无，一个可选文件 404 会让 SW 装不上
    const results = await Promise.allSettled(
      SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.info(`[SW] 跳过预缓存（失败不影响安装）: ${SHELL[i]}`, r.reason && r.reason.message);
      }
    });
    await self.skipWaiting();
  })());
});

// ===== activate：清理旧版本缓存 + 立即接管 =====
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ===== fetch 路由 =====
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源 GET。POST/PUT/DELETE（提交任务、审批）以及跨域请求一律不拦截。
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  const p = url.pathname;

  // —— 绝不清缓存接口，直接放行 ——
  // /api/*、/v1/* 携带 JWT 与租户私有数据，一旦落盘缓存，退出登录后仍可能被读到（越权风险）；
  // /socket.io/* 是 WebSocket 握手与长连接，缓存毫无意义且会破坏实时推送；
  // /v1/* 的 SSE 流是持续输出，中间人缓存同样会截断。故这三类请求 SW 完全不介入。
  if (p.startsWith('/api/') || p.startsWith('/v1/') || p.startsWith('/socket.io')) {
    return;
  }

  // 页面导航：网络优先 → 缓存 → 离线页
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // 只把成功的 HTML 写回缓存，避免把 500 页面缓存成「首页」
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (e) {
        // 先按完整 URL 找，再按 pathname 找（命中外壳预缓存的 /workbench.html 等）
        let cached = await caches.match(req);
        if (!cached) cached = await caches.match(url.pathname);
        // 根路径离线时回落到工作台外壳（未登录时工作台会自行跳转登录页）
        if (!cached && url.pathname === '/') cached = await caches.match('/workbench.html');
        if (cached) return cached;
        const offline = await caches.match('/offline.html');
        if (offline) return offline;
        return new Response('<h1>当前离线</h1>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 其他同源 GET：stale-while-revalidate（先给缓存，后台静默更新）
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) return cached;
    const fresh = await network;
    if (fresh) return fresh;
    // 静态资源都取不到时给一个空响应，避免 fetch 抛错打断页面逻辑
    return new Response('', { status: 504, statusText: 'Offline' });
  })());
});

// ===== 点击通知：聚焦已有窗口并跳转，否则新开 =====
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || '/workbench.html';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      // 优先复用已有工作台窗口：先 postMessage 让前端自己路由，再兜底 focus
      try {
        if (client.focus) {
          const focused = await client.focus();
          const c = focused || client;
          if (c.navigate) {
            try { await c.navigate(target); } catch (e) { /* 跨作用域无法 navigate，交给 postMessage */ }
          }
          if (c.postMessage) c.postMessage({ type: 'navigate', url: target });
          return;
        }
      } catch (e) { /* 继续尝试下一个窗口 */ }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// ===== 页面消息：允许前端触发「立即接管新版本」 =====
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'NAVIGATE' && data.url && self.clients.openWindow) {
    self.clients.openWindow(data.url);
  }
});

// ===== push（防御性实现）=====
// 本项目未引入 VAPID/推送服务，此处仅为将来接入留出兼容：收到带 data 的 push 就弹通知，
// 没有 data 或解析失败时保持静默，绝不抛错。
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch (e) {
    try { payload = { body: event.data.text() }; } catch (e2) { payload = {}; }
  }
  const title = payload.title || 'Human as Agent';
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || '',
    tag: payload.tag || 'hlm-push',
    icon: payload.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: payload.url || '/workbench.html' },
  }));
});
