/* app.js — 工作台入口：登录检查、hash 路由、页面渲染、实时刷新、主题切换 */
window.HLM = window.HLM || {};

(function () {
  const U = window.HLM.U;
  const { Icons, $, esc, toast, STATUS_LABEL } = U;
  const API = window.HLM.API;
  const UI = window.HLM.UI;
  const WS = window.HLM.WS;

  let currentUser = null;

  const THEMES = [
    { id: 'light', label: '浅色' },
    { id: 'warm', label: '暖色' },
    { id: 'mori', label: '莫兰迪' },
    { id: 'dark', label: '深色' },
  ];

  // ===== 认证 =====
  function checkAuth() {
    const token = localStorage.getItem('hlm_token');
    if (!token) { window.location.href = '/login.html'; return false; }
    try { currentUser = JSON.parse(localStorage.getItem('hlm_user') || '{}'); } catch (e) { currentUser = {}; }
    window.HLM.currentUser = currentUser;
    return true;
  }
  function logout() {
    localStorage.removeItem('hlm_token');
    localStorage.removeItem('hlm_user');
    WS.disconnect();
    window.location.href = '/login.html';
  }

  // ===== 导航 =====
  const NAV = [
    { id: 'dashboard', label: '工作台', icon: 'grid', show: () => true },
    { id: 'queue', label: '任务队列', icon: 'queue', show: () => true, badge: () => window._pendingCount || 0 },
    { id: 'mine', label: '我的任务', icon: 'mine', show: () => true },
    { id: 'logs', label: '请求日志', icon: 'logs', show: () => true },
    { id: 'approvals', label: '审批', icon: 'key', show: () => true, badge: () => window._pendingApprovals || 0 },
    { id: 'users', label: '用户管理', icon: 'users', show: () => (currentUser.role === 'admin') },
  ];

  function renderSidebar() {
    const nav = $('#nav');
    nav.innerHTML = NAV.filter(n => n.show()).map(n => `
      <a class="nav-item" data-page="${n.id}" href="#/${n.id}">
        ${Icons[n.icon]}<span class="txt">${n.label}</span>
        <span class="badge" data-badge="${n.id}" style="display:none"></span>
      </a>`).join('');
    const foot = $('#sidebarFoot');
    foot.innerHTML = `
      <div class="chip"><span style="width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block"></span><span id="wsStatus"></span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${THEMES.map(t => `<button class="btn sm" data-theme-btn="${t.id}">${t.label}</button>`).join('')}</div>
      <button class="btn sm" onclick="window.HLM.App.logout()">${Icons.logout} 退出登录</button>`;
    foot.querySelectorAll('[data-theme-btn]').forEach(b => {
      b.onclick = () => setTheme(b.dataset.themeBtn);
    });
  }

  function setTheme(id) {
    document.body.dataset.theme = id;
    localStorage.setItem('hlm_theme', id);
  }

  function highlight() {
    const page = (location.hash.replace('#/', '') || 'dashboard');
    document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  }

  // ===== 页面渲染 =====
  async function renderDashboard() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">工作台</div><div class="page-desc">人工代理网关 · Human-as-LLM 任务监控</div></div>
        <div class="spacer"></div><span class="chip">model: ${esc('human-llm')}</span>
        <button class="icon-btn" onclick="window.HLM.App.route()">${Icons.refresh}</button></div>
      <div class="stats" id="statsBox"></div>
      <div class="card"><div class="card-head"><span class="t">待接单队列</span>
        <button class="btn sm" onclick="window.HLM.App.route()">刷新</button></div>
        <div class="card-body-flush"><div class="tbl-wrap"><table class="data">
          <thead><tr><th>ID</th><th>优先级</th><th>状态</th><th>项目</th><th>需求摘要</th><th>指派人</th><th>创建时间</th><th>超时剩余</th><th>操作</th></tr></thead>
          <tbody id="queueBody"></tbody></table></div></div></div>`;
    try {
      const s = await API.get('/workbench/summary');
      const st = s.data.stats;
      const order = [['pending', '待接单'], ['processing', '处理中'], ['completed', '已完成'], ['returned', '驳回'], ['paused', '暂停']];
      $('#statsBox').innerHTML = order.map(([k, label]) => `
        <div class="stat ${k}"><div class="num">${st[k] || 0}</div><div class="lbl">${label}</div></div>`).join('');
      window._pendingCount = st.pending || 0;
      updateBadges();
      const q = await API.get('/workbench/queue');
      UI.renderTasks(q.data, '#queueBody');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function renderQueue() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">任务队列</div><div class="page-desc">全部人工任务</div></div>
        <div class="spacer"></div>
        <select class="form-select" id="fStatus" style="width:140px;">
          <option value="">全部状态</option>${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
        <select class="form-select" id="fPriority" style="width:120px;">
          <option value="">全部优先级</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option>
        </select>
        <button class="btn" onclick="window.HLM.App.loadQueue()">筛选</button></div>
      <div class="card"><div class="card-body-flush"><div class="tbl-wrap"><table class="data">
        <thead><tr><th>ID</th><th>优先级</th><th>状态</th><th>项目</th><th>需求摘要</th><th>指派人</th><th>创建时间</th><th>超时剩余</th><th>操作</th></tr></thead>
        <tbody id="queueBody"></tbody></table></div></div></div>`;
  }

  async function loadQueue() {
    const status = $('#fStatus').value;
    const priority = $('#fPriority').value;
    const params = new URLSearchParams({ size: 50 });
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    try {
      const r = await API.get('/tasks?' + params.toString());
      UI.renderTasks(r.data.data, '#queueBody');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function renderMine() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">我的任务</div><div class="page-desc">我接单处理的任务</div></div>
        <div class="spacer"></div><button class="btn" onclick="window.HLM.App.route()">刷新</button></div>
      <div class="card"><div class="card-body-flush"><div class="tbl-wrap"><table class="data">
        <thead><tr><th>ID</th><th>优先级</th><th>状态</th><th>项目</th><th>需求摘要</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody id="mineBody"></tbody></table></div></div></div>`;
    try {
      const r = await API.get('/workbench/mine');
      UI.renderTasks(r.data, '#mineBody');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function renderLogs() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">日志</div><div class="page-desc">完整请求 / 人工输出 / 状态审计</div></div>
        <div class="spacer"></div>
        <button class="btn sm" data-logtab="req">请求/输出</button>
        <button class="btn sm" data-logtab="audit">任务审计</button></div>
      <div id="logBox"></div>`;
    content.querySelector('[data-logtab="req"]').onclick = () => renderLogInner('req');
    content.querySelector('[data-logtab="audit"]').onclick = () => renderLogInner('audit');
    renderLogInner('req');
  }

  async function renderLogInner(kind) {
    const box = $('#logBox');
    box.innerHTML = '<div class="empty" style="padding:40px;">加载中...</div>';
    await UI.renderLogs(box, kind);
  }

  async function renderUsers() {
    const content = $('#content');
    content.innerHTML = `<div class="topbar"><div><div class="page-title">用户管理</div><div class="page-desc">工程师账户管理</div></div>
      <div class="spacer"></div></div><div id="usersBox"></div>`;
    await UI.renderUsers($('#usersBox'), currentUser.role === 'admin');
  }

  // ===== 审批页 =====
  async function renderApprovals() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">审批</div><div class="page-desc">AI 资源 / 权限审批 · 人类采购或准备后提供</div></div>
        <div class="spacer"></div>
        <select class="form-select" id="aStatus" style="width:130px;">
          <option value="">全部状态</option><option value="pending">待审批</option><option value="approved">已批准</option><option value="rejected">已驳回</option>
        </select>
        <button class="btn" onclick="window.HLM.App.loadApprovals()">筛选</button></div>
      <div id="approvalsBox"></div>`;
    await loadApprovals();
  }

  async function loadApprovals() {
    const status = $('#aStatus') ? $('#aStatus').value : '';
    const params = new URLSearchParams({ size: 50 });
    if (status) params.set('status', status);
    try {
      const r = await API.get('/approvals?' + params.toString());
      window._pendingApprovals = r.data.data.filter(a => a.status === 'pending').length;
      updateBadges();
      UI.renderApprovals(r.data.data, $('#approvalsBox'));
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 路由 =====
  const routes = { dashboard: renderDashboard, queue: renderQueue, mine: renderMine, logs: renderLogs, approvals: renderApprovals, users: renderUsers };

  async function route() {
    const page = (location.hash.replace('#/', '') || 'dashboard');
    if (!routes[page]) { location.hash = '#/dashboard'; return; }
    highlight();
    if (page === 'dashboard') await routes.dashboard();
    else if (page === 'queue') { await routes.queue(); await loadQueue(); }
    else if (page === 'users') await routes.users();
    else await routes[page]();
  }

  function refresh() { route(); }

  // ===== Socket 事件 =====
  function bindWS() {
    WS.on('new', () => { toast('有新任务进入队列', 'info'); updateBadges(); refresh(); });
    WS.on('update', (d) => { toast(`任务 #${d.id} 状态更新为 ${STATUS_LABEL[d.status] || d.status}`, 'info'); refresh(); });
    WS.on('timeout', (d) => { toast(`任务 #${d.id} 超时告警`, 'warning'); refresh(); });
    WS.on('approval:new', () => { toast('有新审批请求，请处理', 'info'); refresh(); });
    WS.on('approval:update', () => { toast('审批状态已更新', 'info'); refresh(); });
    WS.on('approval:overdue', (d) => { toast(`审批 #${d.id} 已超 24h 未处理`, 'warning'); refresh(); });
  }

  function updateBadges() {
    document.querySelectorAll('.nav-item .badge').forEach(b => {
      const n = b.dataset.badge;
      const cnt = n === 'queue' ? (window._pendingCount || 0)
        : n === 'approvals' ? (window._pendingApprovals || 0) : 0;
      b.style.display = cnt > 0 ? 'block' : 'none';
      b.textContent = cnt;
    });
  }

  // ===== 侧栏交互 =====
  function initSidebar() {
    const sb = $('#sidebar');
    $('#collapseBtn').onclick = () => { sb.classList.toggle('collapsed'); document.querySelector('.main').classList.toggle('full', sb.classList.contains('collapsed')); };
    $('#menuBtn').onclick = () => sb.classList.toggle('open');
    document.querySelector('.main').addEventListener('click', () => sb.classList.remove('open'));
  }

  function init() {
    if (!checkAuth()) return;
    document.body.dataset.theme = localStorage.getItem('hlm_theme') || 'light';
    $('#userName').textContent = currentUser.name || currentUser.username || '';
    $('#userRole').textContent = currentUser.role === 'admin' ? '管理员' : '工程师';
    renderSidebar();
    initSidebar();
    WS.init();
    bindWS();
    window.addEventListener('hashchange', route);
    route();
    UI.startCountdown();
    window.HLM.refresh = refresh;
  }

  window.HLM.App = { logout, route, loadQueue, loadApprovals, refresh };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
