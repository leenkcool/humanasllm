/* ws.js — Socket.IO 实时推送客户端 */
window.HLM = window.HLM || {};

(function () {
  let socket = null;
  const handlers = {};

  function init() {
    const token = localStorage.getItem('hlm_token');
    if (!token) return;
    try {
      socket = io(window.location.origin, {
        auth: { token },
        path: '/socket.io',
        reconnection: true,
        reconnectionDelay: 3000,
        reconnectionAttempts: 10,
      });
      socket.on('connect', () => setStatus(true));
      socket.on('disconnect', () => setStatus(false));
      socket.on('task:new', (d) => fire('new', d));
      socket.on('task:update', (d) => fire('update', d));
      socket.on('task:timeout', (d) => fire('timeout', d));
      socket.on('connect_error', () => setStatus(false));
    } catch (e) { /* ignore */ }
  }

  function setStatus(ok) {
    const el = document.getElementById('wsStatus');
    if (el) {
      el.className = 'chip';
      el.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${ok ? 'var(--success)' : 'var(--danger)'};display:inline-block"></span>${ok ? '实时已连接' : '实时断开'}`;
    }
  }

  function fire(evt, data) { (handlers[evt] || []).forEach(fn => { try { fn(data); } catch (e) { /* ignore */ } }); }
  function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }
  function disconnect() { if (socket) { socket.disconnect(); socket = null; } }

  window.HLM.WS = { init, on, disconnect };
})();
