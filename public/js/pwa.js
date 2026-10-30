/**
 * pwa.js — PWA 增强能力（Service Worker 注册 / 通知）
 *
 * 设计原则：PWA 只是增强。任何一步失败都必须静默降级，绝不影响工作台主流程。
 *
 * 安全上下文说明（重要）：
 *   - 浏览器只在「安全上下文」下允许注册 Service Worker 与请求通知权限。
 *   - 本机 localhost / http://127.0.0.1 被视为安全上下文，可正常注册；
 *   - 局域网地址 http://192.168.168.3:39000 属于不安全上下文，SW 与通知都会被浏览器拒绝，
 *     需部署到 HTTPS 域名（或反向代理加证书）后才能真正启用离线与通知能力。
 *
 * 不在模块加载时自动注册；由 app.js 的 init() 显式调用 window.HLM.PWA.register()。
 */
window.HLM = window.HLM || {};

(function () {
  const NOTIFY_KEY = 'hlm_notify';

  const supported = () =>
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  const isSecure = () => !!window.isSecureContext;

  // 统一通过 window.Notification 访问，避免某些沙箱/严格模式下裸全局名不可见
  const notifCtor = () => (typeof window !== 'undefined' ? window.Notification : undefined);

  const canNotify = () => {
    const N = notifCtor();
    return !!N && 'function' === typeof N.requestPermission;
  };

  const permission = () => (canNotify() ? notifCtor().permission : 'unsupported');

  /**
   * 注册 Service Worker。
   * 非安全上下文 / 不支持 SW / 注册失败 → 静默跳过（仅 console.info），返回 null。
   */
  async function register() {
    try {
      if (!supported()) {
        console.info('[PWA] 当前浏览器不支持 Service Worker，跳过注册（不影响使用）。');
        return null;
      }
      if (!isSecure()) {
        console.info('[PWA] 非安全上下文（局域网 http 地址），浏览器不允许注册 Service Worker；' +
          '如需离线与通知能力请部署到 HTTPS 域名。');
        return null;
      }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

      // 有新版本在等待时，主动让它接管（配合 sw.js 的 message:SKIP_WAITING）
      if (reg.waiting) {
        try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { /* ignore */ }
      }
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            try { sw.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { /* ignore */ }
          }
        });
      });

      // 前端路由接管：SW 的 notificationclick 会 postMessage({type:'navigate'})
      navigator.serviceWorker.addEventListener('message', (ev) => {
        const d = (ev && ev.data) || {};
        if (d.type === 'navigate' && d.url) {
          try {
            const u = new URL(d.url, window.location.origin);
            if (u.pathname === '/workbench.html' || u.pathname === '/') {
              window.location.hash = u.hash || '#/dashboard';
            } else {
              window.location.href = u.href;
            }
          } catch (e) { /* ignore */ }
        }
      });

      console.info('[PWA] Service Worker 注册成功，scope =', reg.scope);
      return reg;
    } catch (e) {
      // 任何失败都不能影响主应用
      console.info('[PWA] Service Worker 注册失败，已忽略：', e && e.message);
      return null;
    }
  }

  /**
   * 请求通知权限。必须在用户手势（点击）内调用，否则多数浏览器会直接拒绝。
   * 授权成功后写 localStorage 标记，便于下次静默启用。
   */
  async function enableNotifications() {
    try {
      if (!canNotify()) {
        console.info('[PWA] 当前环境不支持通知。');
        return 'unsupported';
      }
      if (!isSecure()) {
        console.info('[PWA] 非安全上下文，浏览器不允许请求通知权限。');
        return 'denied';
      }
      const p = await notifCtor().requestPermission();
      if (p === 'granted') {
        try { localStorage.setItem(NOTIFY_KEY, '1'); } catch (e) { /* 配额/隐私模式 */ }
      }
      return p;
    } catch (e) {
      console.info('[PWA] 请求通知权限失败：', e && e.message);
      return 'denied';
    }
  }

  /**
   * 发系统通知。
   * opts: { body, tag, url, icon }
   * 注意：即使页面可见也照常发送（由调用方决定是否只在 document.hidden 时调用）。
   */
  async function notify(title, opts) {
    try {
      const N = notifCtor();
      if (!N || N.permission !== 'granted') return false;
      const o = opts || {};
      const options = {
        body: o.body || '',
        tag: o.tag || 'hlm',
        icon: o.icon || '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        // 点击通知后跳转的目标地址，交给 sw.js 的 notificationclick 处理
        data: { url: o.url || '/workbench.html' },
      };

      if (supported()) {
        try {
          const reg = await navigator.serviceWorker.ready;
          if (reg && reg.showNotification) {
            await reg.showNotification(title || 'Human as Agent', options);
            return true;
          }
        } catch (e) { /* 回退到普通 Notification */ }
      }

      // 回退：页面上下文直接 new Notification（移动端多数不支持，桌面 Chrome 可以）
      try {
        const n = new N(title || 'Human as Agent', options);
        if (o.url) {
          n.onclick = () => {
            try { window.focus(); window.location.href = o.url; } catch (e) { /* ignore */ }
          };
        }
        return true;
      } catch (e) {
        return false;
      }
    } catch (e) {
      return false;
    }
  }

  window.HLM.PWA = {
    register,
    enableNotifications,
    notify,
    permission,
    isSecure,
    canNotify,
  };
})();
