/* ws.js — Socket.IO 实时推送客户端 */
window.HLM = window.HLM || {};

(function () {
  let socket = null;
  let lastOk = null;
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
      // 审批事件（服务端一直广播，此前客户端漏监听导致 toast 永不触发）
      socket.on('approval:new', (d) => fire('approval:new', d));
      socket.on('approval:update', (d) => fire('approval:update', d));
      socket.on('approval:overdue', (d) => fire('approval:overdue', d));
      // 告警升级（SLA 预警 / 违约 / 驳回滞留）
      socket.on('alert:new', (d) => fire('alert:new', d));
      socket.on('alert:escalate', (d) => fire('alert:escalate', d));
      socket.on('connect_error', () => setStatus(false));
    } catch (e) { /* ignore */ }
  }

  function setStatus(ok) {
    lastOk = ok;
    const el = document.getElementById('wsStatus');
    if (el) {
      el.className = 'chip';
      el.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${ok ? 'var(--success)' : 'var(--danger)'};display:inline-block"></span>${ok ? HLM.I18n.t('ws.connected') : HLM.I18n.t('ws.disconnected')}`;
    }
  }

  // 侧栏重建后恢复实时状态文案（切换语言等场景）
  function refreshStatus() { if (lastOk !== null) setStatus(lastOk); }

  function fire(evt, data) { (handlers[evt] || []).forEach(fn => { try { fn(data); } catch (e) { /* ignore */ } }); }
  function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }
  function disconnect() { if (socket) { socket.disconnect(); socket = null; } }

  window.HLM.WS = { init, on, disconnect, refreshStatus };
})();
