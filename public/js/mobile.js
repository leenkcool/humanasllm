/* mobile.js — 工程师终端（移动优先）：卡片流刷任务 + 内联答复 + AI 起草 */
window.HLM = window.HLM || {};

(function () {
  const { $, esc, fmt, toast, STATUS_LABEL, Icons } = window.HLM.U;
  const { t } = window.HLM.I18n;
  const { API } = window.HLM;

  let tab = 'queue';          // queue | mine | review
  let currentUser = {};
  let counts = { queue: 0, mine: 0 };

  // ===== 技能匹配 =====
  function mySkills() {
    return String((currentUser && currentUser.skills) || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  function matchInfo(required) {
    const need = String(required || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!need.length) return { ratio: null, matched: [], label: t('mobile.noSkillReq') };
    const mine = mySkills();
    const matched = need.filter(s => mine.includes(s));
    const ratio = matched.length / need.length;
    return {
      ratio, matched,
      label: matched.length
        ? t('mobile.skillMatch', { m: matched.length, n: need.length })
        : t('mobile.skillMiss', { n: need.length }),
    };
  }

  // ===== 倒计时 =====
  function slaText(task) {
    if (!task.timeout_at) return { text: '-', danger: false };
    const ms = new Date(task.timeout_at).getTime() - Date.now();
    if (ms <= 0) return { text: t('mobile.overdue'), danger: true };
    const min = Math.floor(ms / 60000);
    const h = Math.floor(min / 60);
    const m = min % 60;
    return { text: h > 0 ? `${h}h${m}m` : `${m}m`, danger: ms < 30 * 60000 };
  }

  function summaryOf(task) {
    const msgs = (task.request_payload && task.request_payload.messages) || [];
    const u = msgs.find(m => m.role === 'user');
    return u && typeof u.content === 'string' ? u.content : '';
  }

  // ===== 卡片 =====
  function esc2(s) { return esc(s); }

  function renderCard(task) {
    const mi = matchInfo(task.skills);
    const sla = slaText(task);
    const summary = summaryOf(task);
    const catTag = task.category && task.category !== 'general'
      ? `<span class="tag ${esc(task.category)}">${t('category.' + task.category)}</span>` : '';
    const matchTag = mi.ratio != null && mi.ratio > 0
      ? `<span class="tag medium">${esc(mi.label)}</span>`
      : (mi.ratio != null ? `<span class="tag low">${esc(mi.label)}</span>` : '');

    const actions = task.status === 'pending'
      ? `<button class="btn primary" style="flex:1;" onclick="window.HLM.Mobile.claim(${task.id})">${t('mobile.claim')}</button>
         <button class="btn" style="flex:1;" onclick="window.HLM.Mobile.open(${task.id})">${t('common.view')}</button>`
      : `<button class="btn primary" style="flex:1;" onclick="window.HLM.Mobile.open(${task.id})">${t('mobile.answer')}</button>`;

    return `<div class="m-card" data-id="${task.id}">
      <div class="m-card-head">
        <span class="mono">#${task.id}</span>
        <span class="tag ${esc(task.priority)}">${esc(task.priority)}</span>
        ${catTag}${matchTag}
        <span class="m-sla ${sla.danger ? 'danger' : ''}">${Icons.clock}${esc(sla.text)}</span>
      </div>
      <div class="m-card-summary">${esc(String(summary).slice(0, 140)) || '<span style="color:var(--muted)">-</span>'}</div>
      <div class="m-card-foot">
        <span class="m-meta">${esc(task.project_name || task.project_code || '-')}</span>
        ${actions}
      </div>
    </div>`;
  }

  // ===== 加载 =====
  async function load() {
    const box = $('#mList');
    if (!box) return;
    box.innerHTML = `<div class="m-empty">…</div>`;
    try {
      let list = [];
      if (tab === 'queue') {
        const r = await API.get('/workbench/queue');
        list = r.data || [];
        // 技能匹配度高的排前面，其次按优先级与时间
        list.sort((a, b) => {
          const ra = matchInfo(a.skills).ratio || 0;
          const rb = matchInfo(b.skills).ratio || 0;
          if (rb !== ra) return rb - ra;
          const pa = { high: 0, medium: 1, low: 2 }[a.priority] ?? 1;
          const pb = { high: 0, medium: 1, low: 2 }[b.priority] ?? 1;
          if (pa !== pb) return pa - pb;
          return a.id - b.id;
        });
        counts.queue = list.length;
      } else {
        const r = await API.get('/workbench/mine');
        list = (r.data || []).filter(x => ['processing', 'paused'].includes(x.status));
        counts.mine = list.length;
      }
      updateCounts();
      box.innerHTML = list.length
        ? list.map(renderCard).join('')
        : `<div class="m-empty">${tab === 'queue' ? t('mobile.emptyQueue') : t('mobile.emptyMine')}</div>`;
    } catch (e) {
      box.innerHTML = `<div class="m-empty">${esc(e.message)}</div>`;
    }
  }

  function updateCounts() {
    document.querySelectorAll('[data-tab-count]').forEach(el => {
      const k = el.dataset.tabCount;
      const n = counts[k] || 0;
      el.textContent = n > 99 ? '99+' : String(n);
      el.style.display = n > 0 ? '' : 'none';
    });
  }

  function switchTab(next) {
    tab = next;
    document.querySelectorAll('[data-mtab]').forEach(b => {
      b.classList.toggle('active', b.dataset.mtab === tab);
    });
    load();
  }

  // ===== 操作 =====
  async function claim(id) {
    try {
      await API.post(`/tasks/${id}/claim`, {});
      toast(t('mobile.claimed'), 'success');
      await load();
      switchTab('mine');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 详情抽屉（不跳页）=====
  async function open(id) {
    const drawer = $('#mDrawer');
    if (!drawer) return;
    drawer.classList.add('show');
    drawer.innerHTML = `<div class="m-drawer-body"><div class="m-empty">…</div></div>`;
    try {
      const r = await API.get('/tasks/' + id);
      const task = r.data;
      const msgs = (task.request_payload && task.request_payload.messages) || [];
      const msgsHtml = msgs.map(m => `
        <div class="m-msg ${esc(m.role)}">
          <div class="role">${esc(m.role)}</div>
          <div>${esc(String(m.content == null ? '' : m.content))}</div>
        </div>`).join('');
      const canDraft = (task.category || 'general') === 'general' && ['processing', 'paused'].includes(task.status);

      drawer.innerHTML = `<div class="m-drawer-body">
        <div class="m-drawer-head">
          <div>
            <div style="font-weight:700;">#${task.id}
              <span class="tag ${esc(task.priority)}">${esc(task.priority)}</span>
              ${task.category !== 'general' ? `<span class="tag ${esc(task.category)}">${t('category.' + task.category)}</span>` : ''}
            </div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">${esc(task.project_name || task.project_code || '-')} · ${STATUS_LABEL[task.status] || task.status}</div>
          </div>
          <button class="icon-btn" onclick="window.HLM.Mobile.closeDrawer()">${Icons.x}</button>
        </div>
        <div class="m-msgs">${msgsHtml || `<div class="m-empty">${t('task.none')}</div>`}</div>
        ${['processing', 'paused'].includes(task.status) ? `
        <div class="m-compose">
          ${canDraft ? `<button class="btn sm" onclick="window.HLM.Mobile.draft(${task.id})">${Icons.zap}${t('mobile.draft')}</button>` : ''}
          <textarea id="mAnswer" class="form-textarea" rows="6" placeholder="${esc(t('mobile.answerPh'))}"></textarea>
          <button class="btn primary" onclick="window.HLM.Mobile.submit(${task.id})">${t('mobile.submit')}</button>
        </div>` : ''}
      </div>`;
    } catch (e) {
      drawer.innerHTML = `<div class="m-drawer-body"><div class="m-empty">${esc(e.message)}</div></div>`;
    }
  }

  function closeDrawer() {
    const d = $('#mDrawer');
    if (d) { d.classList.remove('show'); d.innerHTML = ''; }
  }

  let draftUsed = false;
  let draftModel = null;

  async function draft(id) {
    const ta = $('#mAnswer');
    if (!ta) return;
    ta.disabled = true;
    ta.placeholder = t('mobile.drafting');
    try {
      const r = await API.post(`/tasks/${id}/draft`, {});
      ta.value = r.data.draft;
      draftUsed = true;
      draftModel = r.data.model || null;
      toast(t('mobile.draftDone'), 'success');
    } catch (e) {
      toast(e.message, 'error');
      ta.placeholder = t('mobile.answerPh');
    } finally {
      ta.disabled = false;
    }
  }

  async function submit(id) {
    const ta = $('#mAnswer');
    if (!ta) return;
    const content = ta.value.trim();
    if (!content) return toast(t('mobile.needAnswer'), 'error');
    try {
      await API.post(`/tasks/${id}/complete`, {
        content,
        drafted_by_ai: draftUsed,
        draft_model: draftModel,
      });
      toast(t('mobile.submitted'), 'success');
      draftUsed = false;
      draftModel = null;
      closeDrawer();
      switchTab('mine');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 通知 =====
  function initNotify() {
    const A = window.HLM.PWA;
    if (!A) return;
    const btn = $('#mNotifyBtn');
    if (!btn) return;
    const refresh = () => {
      const p = A.permission();
      btn.textContent = p === 'granted' ? t('mobile.notifyOn') : t('mobile.notifyOff');
      btn.classList.toggle('primary', p !== 'granted');
      btn.disabled = p === 'granted' || p === 'unsupported';
    };
    btn.onclick = async () => {
      const p = await A.enableNotifications();
      if (p === 'granted') toast(t('mobile.notifyOn'), 'success');
      refresh();
    };
    refresh();
  }

  function bindRealtime() {
    const WS = window.HLM.WS;
    if (!WS) return;
    // 定向铃：只推给技能匹配者
    WS.on('task:matched', (d) => {
      toast(t('toast.newTask') + ' #' + d.id, 'info');
      if (document.visibilityState !== 'visible' && window.HLM.PWA) {
        window.HLM.PWA.notify(t('toast.newTask'), {
          body: (t('category.' + (d.category || 'general'))) + ' · ' + (d.skills || ''),
          tag: 'hlm-task-' + d.id,
          url: '/mobile.html',
        });
      }
      load();
    });
    WS.on('task:new', () => load());
    WS.on('task:update', () => load());
  }

  // ===== 初始化 =====
  async function init() {
    currentUser = window.HLM.currentUser || {};
    initNotify();
    bindRealtime();
    if (window.HLM.PWA) window.HLM.PWA.register().catch(() => {});
    switchTab('queue');
    // 兜底轮询：WebSocket 断线时仍能刷到新任务（60s，能耗可控）
    setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
  }

  window.HLM.Mobile = { init, load, switchTab, claim, open, closeDrawer, draft, submit };
})();
