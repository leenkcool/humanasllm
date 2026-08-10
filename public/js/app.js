/* app.js — 工作台入口：登录检查、hash 路由、页面渲染、实时刷新、主题切换 */
window.HLM = window.HLM || {};

(function () {
  const U = window.HLM.U;
  const { Icons, $, esc, toast, STATUS_LABEL } = U;
  const { t, lang, setLang, applyStatic } = window.HLM.I18n;
  const API = window.HLM.API;
  const UI = window.HLM.UI;
  const WS = window.HLM.WS;

  let currentUser = null;

  const THEMES = [
    { id: 'light', label: () => t('theme.light') },
    { id: 'warm', label: () => t('theme.warm') },
    { id: 'mori', label: () => t('theme.mori') },
    { id: 'dark', label: () => t('theme.dark') },
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
    { id: 'dashboard', label: () => t('nav.dashboard'), icon: 'grid', show: () => true },
    { id: 'queue', label: () => t('nav.queue'), icon: 'queue', show: () => true, badge: () => window._pendingCount || 0 },
    { id: 'mine', label: () => t('nav.mine'), icon: 'mine', show: () => true },
    { id: 'logs', label: () => t('nav.logs'), icon: 'logs', show: () => true },
    { id: 'approvals', label: () => t('nav.approvals'), icon: 'key', show: () => true, badge: () => window._pendingApprovals || 0 },
    { id: 'projects', label: () => t('nav.projects'), icon: 'folder', show: () => true },
    { id: 'users', label: () => t('nav.users'), icon: 'users', show: () => (currentUser.role === 'admin') },
  ];

  function renderSidebar() {
    const nav = $('#nav');
    nav.innerHTML = NAV.filter(n => n.show()).map(n => `
      <a class="nav-item" data-page="${n.id}" href="#/${n.id}">
        ${Icons[n.icon]}<span class="txt">${n.label()}</span>
        <span class="badge" data-badge="${n.id}" style="display:none"></span>
      </a>`).join('');
    const foot = $('#sidebarFoot');
    const otherLang = lang() === 'en' ? '中文' : 'English';
    foot.innerHTML = `
      <div class="chip"><span style="width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block"></span><span id="wsStatus"></span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${THEMES.map(th => `<button class="btn sm" data-theme-btn="${th.id}">${th.label()}</button>`).join('')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn sm" onclick="window.HLM.App.switchLang()">${otherLang}</button>
        <button class="btn sm" onclick="window.HLM.App.logout()">${Icons.logout} ${t('app.logout')}</button>
      </div>`;
    foot.querySelectorAll('[data-theme-btn]').forEach(b => {
      b.onclick = () => setTheme(b.dataset.themeBtn);
    });
  }

  function switchLang() {
    setLang(lang() === 'en' ? 'zh' : 'en');
    applyStatic();
    applyUserBadge();
    renderSidebar();
    refresh();
  }

  function applyUserBadge() {
    $('#userName').textContent = currentUser.name || currentUser.username || '';
    $('#userRole').textContent = currentUser.role === 'admin' ? t('role.admin') : t('role.engineer');
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
      <div class="topbar"><div><div class="page-title">${t('page.dashboard.title')}</div><div class="page-desc">${t('page.dashboard.desc')}</div></div>
        <div class="spacer"></div><span class="chip">model: ${esc('human-llm')}</span>
        <button class="icon-btn" onclick="window.HLM.App.route()">${Icons.refresh}</button></div>
      <div class="stats" id="statsBox"></div>
      <div class="card"><div class="card-head"><span class="t">${t('page.dashboard.queue')}</span>
        <button class="btn sm" onclick="window.HLM.App.route()">${t('common.refresh')}</button></div>
        <div class="card-body-flush"><div class="tbl-wrap"><table class="data">
          <thead><tr><th>${t('table.id')}</th><th>${t('table.priority')}</th><th>${t('table.status')}</th><th>${t('table.project')}</th><th>${t('table.summary')}</th><th>${t('table.assignee')}</th><th>${t('table.createdAt')}</th><th>${t('table.timeoutLeft')}</th><th>${t('table.action')}</th></tr></thead>
          <tbody id="queueBody"></tbody></table></div></div></div>`;
    try {
      const s = await API.get('/workbench/summary');
      const st = s.data.stats;
      const order = ['pending', 'processing', 'completed', 'returned', 'paused'];
      $('#statsBox').innerHTML = order.map(k => `
        <div class="stat ${k}"><div class="num">${st[k] || 0}</div><div class="lbl">${t('stat.' + k)}</div></div>`).join('');
      window._pendingCount = st.pending || 0;
      updateBadges();
      const q = await API.get('/workbench/queue');
      UI.renderTasks(q.data, '#queueBody');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function renderQueue() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">${t('page.queue.title')}</div><div class="page-desc">${t('page.queue.desc')}</div></div>
        <div class="spacer"></div>
        <select class="form-select" id="fStatus" style="width:140px;">
          <option value="">${t('common.all')}</option>${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
        <select class="form-select" id="fPriority" style="width:120px;">
          <option value="">${t('common.allPriority')}</option><option value="high">${t('common.priority.high')}</option><option value="medium">${t('common.priority.medium')}</option><option value="low">${t('common.priority.low')}</option>
        </select>
        <button class="btn" onclick="window.HLM.UI.exportCSV('/tasks/export')">${t('common.export')}</button>
        <button class="btn" onclick="window.HLM.App.loadQueue()">${t('common.filter')}</button></div>
      <div class="card"><div class="card-body-flush"><div class="tbl-wrap"><table class="data">
        <thead><tr><th>${t('table.id')}</th><th>${t('table.priority')}</th><th>${t('table.status')}</th><th>${t('table.project')}</th><th>${t('table.summary')}</th><th>${t('table.assignee')}</th><th>${t('table.createdAt')}</th><th>${t('table.timeoutLeft')}</th><th>${t('table.action')}</th></tr></thead>
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
      <div class="topbar"><div><div class="page-title">${t('page.mine.title')}</div><div class="page-desc">${t('page.mine.desc')}</div></div>
        <div class="spacer"></div><button class="btn" onclick="window.HLM.App.route()">${t('common.refresh')}</button></div>
      <div class="card"><div class="card-body-flush"><div class="tbl-wrap"><table class="data">
        <thead><tr><th>${t('table.id')}</th><th>${t('table.priority')}</th><th>${t('table.status')}</th><th>${t('table.project')}</th><th>${t('table.summary')}</th><th>${t('table.createdAt')}</th><th>${t('table.action')}</th></tr></thead>
        <tbody id="mineBody"></tbody></table></div></div></div>`;
    try {
      const r = await API.get('/workbench/mine');
      UI.renderTasks(r.data, '#mineBody');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function renderLogs() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">${t('page.logs.title')}</div><div class="page-desc">${t('page.logs.desc')}</div></div>
        <div class="spacer"></div>
        <button class="btn sm" data-logtab="req">${t('log.tabReq')}</button>
        <button class="btn sm" data-logtab="audit">${t('log.tabAudit')}</button></div>
      <div id="logBox"></div>`;
    content.querySelector('[data-logtab="req"]').onclick = () => renderLogInner('req');
    content.querySelector('[data-logtab="audit"]').onclick = () => renderLogInner('audit');
    renderLogInner('req');
  }

  async function renderLogInner(kind) {
    const box = $('#logBox');
    box.innerHTML = `<div class="empty" style="padding:40px;">${t('toast.loading')}</div>`;
    await UI.renderLogs(box, kind);
  }

  async function renderUsers() {
    const content = $('#content');
    content.innerHTML = `<div class="topbar"><div><div class="page-title">${t('page.users.title')}</div><div class="page-desc">${t('page.users.desc')}</div></div>
      <div class="spacer"></div></div><div id="usersBox"></div>`;
    await UI.renderUsers($('#usersBox'), currentUser.role === 'admin');
  }

  // ===== 审批页 =====
  async function renderApprovals() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">${t('page.approvals.title')}</div><div class="page-desc">${t('page.approvals.desc')}</div></div>
        <div class="spacer"></div>
        <select class="form-select" id="aStatus" style="width:130px;">
          <option value="">${t('common.all')}</option><option value="pending">${t('approval.status.pending')}</option><option value="approved">${t('approval.status.approved')}</option><option value="rejected">${t('approval.status.rejected')}</option>
        </select>
        <button class="btn" onclick="window.HLM.UI.exportCSV('/approvals/export')">${t('common.export')}</button>
        <button class="btn" onclick="window.HLM.App.loadApprovals()">${t('common.filter')}</button></div>
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

  // ===== 项目页 =====
  async function renderProjects() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">${t('page.projects.title')}</div><div class="page-desc">${t('page.projects.desc')}</div></div>
        <div class="spacer"></div>
        <button class="btn" onclick="window.HLM.UI.promptApplyProject()">${t('project.applyTitle')}</button>
        ${currentUser.role === 'admin' ? `<button class="btn primary" onclick="window.HLM.UI.promptCreateProject()">${t('project.createTitle')}</button>` : ''}</div>
      <div id="projectsBox"></div>`;
    await loadProjects();
  }

  async function loadProjects() {
    try {
      const r = await API.get('/projects');
      UI.renderProjects(r.data, $('#projectsBox'), currentUser.role === 'admin');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 路由 =====
  const routes = { dashboard: renderDashboard, queue: renderQueue, mine: renderMine, logs: renderLogs, approvals: renderApprovals, projects: renderProjects, users: renderUsers };

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
    WS.on('new', () => { toast(t('toast.newTask'), 'info'); updateBadges(); refresh(); });
    WS.on('update', (d) => { toast(t('toast.taskUpdate', { id: d.id, status: STATUS_LABEL[d.status] || d.status }), 'info'); refresh(); });
    WS.on('timeout', (d) => { toast(t('toast.taskTimeout', { id: d.id }), 'warning'); refresh(); });
    WS.on('approval:new', () => { toast(t('toast.newApproval'), 'info'); refresh(); });
    WS.on('approval:update', () => { toast(t('toast.approvalUpdate'), 'info'); refresh(); });
    WS.on('approval:overdue', (d) => { toast(t('toast.approvalOverdue', { id: d.id }), 'warning'); refresh(); });
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
    applyStatic();
    applyUserBadge();
    renderSidebar();
    initSidebar();
    WS.init();
    bindWS();
    window.addEventListener('hashchange', route);
    route();
    UI.startCountdown();
    window.HLM.refresh = refresh;
  }

  window.HLM.App = { logout, route, loadQueue, loadApprovals, loadProjects, refresh, switchLang };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
