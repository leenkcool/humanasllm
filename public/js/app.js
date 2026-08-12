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
  const THEME_DOTS = { light: '#ffffff', warm: '#f0d9a8', mori: '#d8d4cb', dark: '#1e1e22' };
  const GLOBE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

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
    { id: 'gateway', label: () => t('nav.gateway'), icon: 'bot', show: () => true },
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
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${THEMES.map(th => `<button class="btn sm" data-theme-btn="${th.id}" title="${th.label()}"><span class="dot" style="background:${THEME_DOTS[th.id]}"></span>${th.label()}</button>`).join('')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn sm" onclick="window.HLM.App.switchLang()" title="${otherLang}">${GLOBE_ICON}${otherLang}</button>
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
    WS.refreshStatus();
    refresh();
  }

  function applyUserBadge() {
    $('#userName').textContent = currentUser.name || currentUser.username || '';
    const tenant = currentUser.tenant_name ? currentUser.tenant_name + ' · ' : '';
    $('#userRole').textContent = tenant + (currentUser.role === 'admin' ? t('role.admin') : t('role.engineer'));
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
        ${currentUser.role === 'admin' ? `<button class="btn" onclick="window.HLM.UI.showRules()">${t('rules.title')}</button>` : ''}
        <button class="btn" onclick="window.HLM.UI.showAuditReport()">${t('page.audit.report')}</button>
        <button class="icon-btn" onclick="window.HLM.App.route()">${Icons.refresh}</button></div>
      <div class="stats" id="statsBox"></div>
      <div class="stats" id="govBox" style="margin-bottom:18px;"></div>
      <div class="card"><div class="card-head"><span class="t">${t('gov.engineers')}</span></div>
        <div class="card-body" id="engBox"></div></div>
      <div class="card"><div class="card-head"><span class="t">${t('page.dashboard.unfinished')}</span>
        <button class="btn sm" onclick="window.HLM.App.route()">${t('common.refresh')}</button></div>
        <div class="card-body-flush"><div class="tbl-wrap"><table class="data">
          <thead><tr><th>${t('table.id')}</th><th>${t('table.priority')}</th><th>${t('table.status')}</th><th>${t('table.project')}</th><th>${t('table.summary')}</th><th>${t('table.assignee')}</th><th>${t('table.createdAt')}</th><th>${t('table.timeoutLeft')}</th><th>${t('table.action')}</th></tr></thead>
          <tbody id="queueBody"></tbody></table></div></div></div>`;
    try {
      const s = await API.get('/workbench/summary');
      const st = s.data.stats;
      const order = ['unfinished', 'pending', 'processing', 'completed', 'returned', 'paused'];
      $('#statsBox').innerHTML = order.map(k => `
        <div class="stat ${k}"><div class="num">${st[k] || 0}</div><div class="lbl">${t('stat.' + k)}</div></div>`).join('');
      window._pendingCount = st.pending || 0;
      updateBadges();
      const g = await API.get('/workbench/governance');
      const gd = g.data;
      const catLabel = gd.categories.map(c => `${t('category.' + c.category) || c.category}:${c.count}`).join(' · ') || t('gov.noData');
      $('#govBox').innerHTML = `
        <div class="stat"><div class="num">${gd.qa.rate != null ? gd.qa.rate + '%' : '-'}</div><div class="lbl">${t('gov.passRate')}</div></div>
        <div class="stat"><div class="num">${gd.approval.avg_min != null ? gd.approval.avg_min + t('gov.min') : '-'}</div><div class="lbl">${t('gov.approvalAvg')}</div></div>
        <div class="stat"><div class="num">${gd.timeout.rate}%</div><div class="lbl">${t('gov.timeoutRate')}</div></div>
        <div class="stat"><div class="num">${gd.ai_shift.rate != null ? gd.ai_shift.rate + '%' : '-'}</div><div class="lbl">${t('gov.aiShift')}</div></div>
        <div class="stat"><div class="num" style="font-size:14px;line-height:1.5;white-space:normal;">${catLabel}</div><div class="lbl">${t('gov.categories')}</div></div>`;
      $('#engBox').innerHTML = (gd.engineers && gd.engineers.length)
        ? gd.engineers.map(e => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);">
            <div><strong>${esc(e.name)}</strong>${e.skills ? ` <span class="tag low" style="margin-left:6px;">${esc(e.skills)}</span>` : ''}</div>
            <div style="font-size:13px;color:var(--muted);">${t('gov.claimed')} ${e.completed} · ${t('gov.reopened')} ${e.reopened} · <b style="color:var(--success);">${e.rate != null ? e.rate + '%' : '-'}</b></div>
          </div>`).join('')
        : `<div class="empty" style="padding:16px;">${t('gov.noData')}</div>`;
      const q = await API.get('/workbench/unfinished');
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

  // ===== 接入配置（生成 SKILL/AGENT + 在线微调） =====
  let _gwTool = 'claude';
  let _gwFiles = [];       // 当前工具文件列表 [{path, content}]
  let _gwPath = '';        // 当前编辑的文件

  async function renderGateway() {
    const content = $('#content');
    content.innerHTML = `
      <div class="topbar"><div><div class="page-title">${t('page.gateway.title')}</div><div class="page-desc">${t('page.gateway.desc')}</div></div>
        <div class="spacer"></div></div>
      <div class="card"><div class="card-head"><span class="t">${t('gateway.config')}</span></div>
        <div class="card-body">
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <div class="form-group" style="flex:2;min-width:240px;"><label class="form-label">${t('gateway.baseUrl')}</label><input class="form-input" id="gwUrl" placeholder="http://localhost:39000"></div>
            <div class="form-group" style="flex:1;min-width:140px;"><label class="form-label">${t('gateway.model')}</label><input class="form-input" id="gwModel" value="human-llm"></div>
            <div class="form-group" style="flex:1;min-width:180px;"><label class="form-label">${t('gateway.apiKey')}</label><input class="form-input" id="gwKey" placeholder="${t('gateway.apiKeyPh')}"></div>
          </div>
          <div class="form-group"><label class="form-label">${t('gateway.note')}</label><input class="form-input" id="gwNote" placeholder="${t('gateway.notePh')}"></div>
          <div class="form-group"><label class="form-label">${t('gateway.tool')}</label>
            <select class="form-select" id="gwTool" style="max-width:240px;" onchange="window.HLM.App.onToolChange()">
              <option value="claude">Claude Code</option>
              <option value="codex">Codex (OpenAI)</option>
              <option value="opencode">OpenCode</option>
              <option value="gemini">Gemini CLI</option>
              <option value="cursor">Cursor</option>
              <option value="windsurf">Windsurf</option>
              <option value="aider">Aider</option>
              <option value="workbuddy">WorkBuddy</option>
              <option value="openclaw">OpenClaw</option>
              <option value="hermes">Hermes</option>
              <option value="pi">Pi Agent</option>
              <option value="agents">通用 Agent (AGENTS.md)</option>
              <option value="build">构建方法（任意工具）</option>
              <option value="all">本机全装（node 脚本）</option>
            </select></div>
          <div style="display:flex;gap:8px;">
            <button class="btn primary" onclick="window.HLM.App.generateGateway()">${t('gateway.generate')}</button>
            <button class="btn" onclick="window.HLM.App.saveGateway()">${t('gateway.save')}</button>
          </div>
        </div></div>
      <div class="card"><div class="card-head"><span class="t">${t('gateway.installTitle')}</span>
        <span class="chip">${t('gateway.installDesc')}</span></div>
        <div class="card-body">
          <textarea class="form-textarea" id="gwPrompt" rows="8" readonly style="font-family:monospace;font-size:12px;"></textarea>
          <div style="margin-top:8px;"><button class="btn" onclick="window.HLM.App.copyPrompt()">${t('gateway.copy')}</button></div>
        </div></div>
      <div class="card"><div class="card-head"><span class="t">${t('gateway.installPkg')}</span>
        <span class="chip">${t('gateway.installFiles')}</span></div>
        <div class="card-body">
          <textarea class="form-textarea" id="gwInstall" rows="16" readonly style="font-family:monospace;font-size:12px;"></textarea>
          <div style="margin-top:8px;"><button class="btn" onclick="window.HLM.App.copyInstall()">${t('gateway.copyInstall')}</button></div>
        </div></div>
      <div class="card"><div class="card-head"><span class="t">${t('gateway.files')}</span>
        <span class="chip">${t('gateway.editable')}</span></div>
        <div class="card-body">
          <select class="form-select" id="gwFilePath" style="max-width:100%;margin-bottom:8px;font-family:monospace;font-size:12px;"></select>
          <textarea class="form-textarea" id="gwFile" rows="16" style="font-family:monospace;font-size:12px;"></textarea>
          <div style="margin-top:8px;"><button class="btn" onclick="window.HLM.App.saveFile()">${t('gateway.saveFile')}</button></div>
        </div></div>
      ${window.HLM.currentUser && window.HLM.currentUser.role === 'admin' ? `
      <div class="card"><div class="card-head"><span class="t">${t('gateway.serverInstall')}</span>
        <span class="chip" id="siRoot"></span></div>
        <div class="card-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <select class="form-select" id="siTool" style="max-width:200px;">
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
              <option value="agents">通用 AGENTS.md</option>
              <option value="all">全装脚本</option>
            </select>
            <input class="form-input" id="siTarget" placeholder="${t('gateway.serverTarget')}" style="flex:1;min-width:200px;">
            <button class="btn primary" onclick="window.HLM.App.serverInstall()">${t('gateway.serverInstallBtn')}</button>
          </div>
          <div class="ctx" id="siResult" style="margin-top:10px;display:none;"></div>
        </div></div>` : ''}`;
    await loadGateway();
  }

  async function loadGateway() {
    try {
      const c = await API.get('/gateway/config');
      $('#gwUrl').value = c.data.baseUrl || '';
      $('#gwModel').value = c.data.model || 'human-llm';
      $('#gwKey').value = c.data.apiKey || '';
      $('#gwNote').value = c.data.note || '';
      const root = await API.get('/gateway/install-root').catch(() => null);
      if (root && $('#siRoot')) $('#siRoot').textContent = root.data.root;
      updatePrompt();
      loadInstall();
      renderGwFiles(_gwTool);
    } catch (e) { toast(e.message, 'error'); }
  }

  // 加载当前工具的生成文件（微调后优先），供在线编辑
  async function renderGwFiles(tool) {
    const box = $('#gwFile');
    const sel = $('#gwFilePath');
    if (!box || !sel) return;
    try {
      const r = await API.get('/gateway/install?tool=' + tool);
      _gwFiles = r.data.files || [];
      _gwPath = _gwFiles[0] ? _gwFiles[0].path : '';
      sel.innerHTML = _gwFiles.map(f => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('');
      sel.onchange = () => { _gwPath = sel.value; renderGwFileText(); };
      renderGwFileText();
    } catch (e) { /* 预览失败不阻塞 */ }
  }

  function renderGwFileText() {
    const box = $('#gwFile');
    if (!box) return;
    const f = _gwFiles.find(x => x.path === _gwPath);
    box.value = f ? f.content : '';
  }

  // 生成「安装提示词」：在目标项目粘贴即自动安装（按工具）
  // 规范化 baseUrl 去尾斜杠，避免拼出 //api 导致路由 404
  function buildInstallPrompt(baseUrl, model, tool) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (tool === 'all') {
      return `请从 P390 (Human as Agent) 「本机全装」到本项目：

1. 调用 GET ${base}/api/gateway/install?tool=all 获取 p390-install.js
2. 写入项目根目录并运行：node p390-install.js
3. 装完本机 Claude Code 的 skill/agent 后，主动询问用户是否让本机其他 AI agent 工具也安装
4. 同意则运行脚本（会自动扫描本机已装 CLI：codex/opencode/gemini/cursor/aider，对检测到的工具写入 skill/agent/规则，未检测到的提示跳过）
5. 确认安装完成（网关 ${base}，模型 ${model}）`;
    }
    return `请从 P390 人工代理网关安装「人工路由」能力到本项目（工具：${tool}）：

1. 调用 GET ${base}/api/gateway/install?tool=${tool} 获取安装包（返回 data.files 数组）
2. 把每个文件的 content 写入对应 path（如 AGENTS.md / .claude/...）
3. 确认安装完成，并说明网关地址为 ${base}、模型为 ${model}`;
  }

  function updatePrompt() {
    const base = $('#gwUrl').value.trim();
    const model = $('#gwModel').value.trim() || 'human-llm';
    const box = $('#gwPrompt');
    if (box && base) box.value = buildInstallPrompt(base, model, _gwTool);
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText($('#gwPrompt').value);
      toast(t('gateway.copied'), 'success');
    } catch (e) { toast(t('gateway.copyFail'), 'error'); }
  }

  function onToolChange() {
    _gwTool = $('#gwTool').value;
    updatePrompt();
    loadInstall();
    renderGwFiles(_gwTool);
  }

  // 拉取当前工具的安装包预览（只读，可复制）
  async function loadInstall() {
    const base = $('#gwUrl').value.trim();
    const box = $('#gwInstall');
    if (!box || !base) return;
    try {
      const r = await API.get('/gateway/install?tool=' + _gwTool);
      const files = r.data.files || [];
      box.value = files.map(f => `===== ${f.path} =====\n${f.content}`).join('\n\n');
    } catch (e) { /* 预览失败不阻塞，提示词仍可用 */ }
  }

  async function copyInstall() {
    try {
      await navigator.clipboard.writeText($('#gwInstall').value);
      toast(t('gateway.copied'), 'success');
    } catch (e) { toast(t('gateway.copyFail'), 'error'); }
  }

  async function generateGateway() {
    try {
      const cfg = {
        baseUrl: $('#gwUrl').value.trim(),
        model: $('#gwModel').value.trim() || 'human-llm',
        apiKey: $('#gwKey').value.trim(),
        note: $('#gwNote').value.trim(),
      };
      if (!cfg.baseUrl) { toast(t('gateway.baseUrlReq'), 'warning'); return; }
      const r = await API.post('/gateway/generate', cfg);
      updatePrompt();
      await renderGwFiles(_gwTool);   // 生成后重新加载当前工具文件
      toast(t('gateway.generated'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function saveGateway() {
    try {
      await API.put('/gateway/config', {
        baseUrl: $('#gwUrl').value.trim(),
        model: $('#gwModel').value.trim(),
        apiKey: $('#gwKey').value.trim(),
        note: $('#gwNote').value.trim(),
      });
      updatePrompt();
      toast(t('gateway.saved'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function saveFile() {
    if (_gwTool === 'all') { toast(t('gateway.allNoEdit'), 'info'); return; }
    if (!_gwPath) { toast(t('gateway.noFile'), 'warning'); return; }
    try {
      await API.put('/gateway/files', { tool: _gwTool, path: _gwPath, content: $('#gwFile').value });
      toast(t('gateway.saved'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // 服务器端安装（admin）：把当前工具文件写入服务器指定目标目录
  async function serverInstall() {
    try {
      const tool = $('#siTool').value;
      const target = $('#siTarget').value.trim();
      const r = await API.post('/gateway/install-server', { tool, target });
      const box = $('#siResult');
      box.style.display = 'block';
      box.innerHTML = `<div class="k">${esc(r.data.root)} / ${esc(r.data.target || '.')}（${r.data.count} 个文件）</div>${r.data.files.map(f => `<div style="font-size:12px;color:var(--muted);">${esc(f)}</div>`).join('')}`;
      toast(t('gateway.saved'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function loadProjects() {
    try {
      const r = await API.get('/projects');
      UI.renderProjects(r.data, $('#projectsBox'), currentUser.role === 'admin');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 路由 =====
  const routes = { dashboard: renderDashboard, queue: renderQueue, mine: renderMine, logs: renderLogs, approvals: renderApprovals, projects: renderProjects, gateway: renderGateway, users: renderUsers };

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

  // 窄窗(769-1024)/竖屏大窗(≥1025)自动折叠为图标侧栏；可手动展开，展开后主内容宽度由 CSS 扣除
  function syncExpandTitle() {
    const sb = $('#sidebar');
    const eb = $('#expandBtn');
    if (sb && eb) eb.title = sb.classList.contains('collapsed') ? t('app.expand') : t('app.collapse');
  }
  function applyResponsive() {
    const sb = $('#sidebar');
    if (!sb) return;
    const w = window.innerWidth;
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    const mini = (w >= 769 && w <= 1024) || (w >= 1025 && portrait);
    sb.classList.toggle('collapsed', mini);
    syncExpandTitle();
  }

  // ===== 侧栏交互 =====
  function initSidebar() {
    const sb = $('#sidebar');
    $('#expandBtn').onclick = () => { sb.classList.toggle('collapsed'); syncExpandTitle(); };
    $('#menuBtn').onclick = () => sb.classList.toggle('open');
    document.querySelector('.main').addEventListener('click', () => sb.classList.remove('open'));
    applyResponsive();
    window.addEventListener('resize', applyResponsive);
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

  window.HLM.App = { logout, route, loadQueue, loadApprovals, loadProjects, refresh, switchLang, generateGateway, saveGateway, saveFile, copyPrompt, onToolChange, copyInstall, serverInstall };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
