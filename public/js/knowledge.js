/* knowledge.js — 知识库：项目/租户/全局三级作用域，答复时复用历史经验 */
window.HLM = window.HLM || {};

(function () {
  const { $, esc, fmt, toast, openModal, closeModal, confirmDialog, Icons } = window.HLM.U;
  const { t } = window.HLM.I18n;
  const { API } = window.HLM;

  let state = { page: 1, keyword: '', scope: '', category: '' };

  function scopeTag(s) {
    const map = { project: 'ops', tenant: 'pending', global: 'completed' };
    return `<span class="tag ${map[s] || 'paused'}">${esc(t('kb.scope.' + s))}</span>`;
  }

  async function load() {
    const box = $('#kbBox');
    if (!box) return;
    box.innerHTML = `<div class="empty" style="padding:24px;">…</div>`;
    const p = new URLSearchParams({ page: state.page, size: 20 });
    if (state.keyword) p.set('keyword', state.keyword);
    if (state.scope) p.set('scope', state.scope);
    if (state.category) p.set('category', state.category);
    try {
      const r = await API.get('/knowledge?' + p.toString());
      const d = r.data;
      window._kbTotal = d.total;
      const cnt = $('#kbCount');
      if (cnt) cnt.textContent = t('kb.total', { n: d.total });
      if (!d.data.length) {
        box.innerHTML = `<div class="empty" style="padding:32px;">${t('kb.empty')}</div>`;
        return;
      }
      box.innerHTML = d.data.map(x => `
        <div class="card" style="margin-bottom:10px;">
          <div class="card-body">
            <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
              <div style="flex:1;min-width:240px;">
                <div style="font-weight:600;font-size:14px;">${esc(x.title)}
                  ${scopeTag(x.scope)}
                  <span class="tag ${esc(x.category)}" style="margin-left:4px;">${t('category.' + x.category)}</span>
                  ${x.project_code ? `<span class="chip" style="margin-left:6px;">${esc(x.project_code)}</span>` : ''}
                </div>
                <div style="color:var(--muted);font-size:12px;margin-top:6px;white-space:pre-wrap;">${esc(String(x.problem).slice(0, 160))}</div>
                <div style="font-size:12px;margin-top:6px;color:var(--muted);">${Icons.file} ${t('kb.uses', { n: x.use_count || 0 })} · ${fmt(x.created_at)}</div>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="btn sm" onclick="window.HLM.Knowledge.view(${x.id})">${t('common.view')}</button>
                <button class="btn sm" onclick="window.HLM.Knowledge.promptSave(${x.id})">${Icons.edit}${t('common.edit')}</button>
              </div>
            </div>
          </div>
        </div>`).join('');
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  async function view(id) {
    try {
      const r = await API.get('/knowledge/' + id);
      const x = r.data;
      const body = `
        <div class="ctx"><div class="k">${t('kb.problem')}</div><pre>${esc(x.problem)}</pre></div>
        <div class="ctx"><div class="k">${t('kb.solution')}</div><pre>${esc(x.solution)}</pre></div>
        <div class="ctx" style="display:flex;gap:6px;flex-wrap:wrap;">
          ${scopeTag(x.scope)}
          <span class="tag ${esc(x.category)}">${t('category.' + x.category)}</span>
          ${x.project_code ? `<span class="chip">${esc(x.project_code)}</span>` : ''}
          ${x.tags ? `<span class="chip">${esc(x.tags)}</span>` : ''}
        </div>`;
      openModal(x.title, body,
        `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.close')}</button>`, 'lg');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function promptSave(id) {
    let x = { scope: 'tenant', category: 'general' };
    if (id) {
      try { x = (await API.get('/knowledge/' + id)).data; } catch (e) { return toast(e.message, 'error'); }
    }
    const scopes = ['project', 'tenant', 'global'];
    const cats = ['general', 'confidential', 'ops'];
    const body = `
      <div class="form-group"><label class="form-label">${t('kb.title')} *</label>
        <input class="form-input" id="kbTitle" value="${esc(x.title || '')}"></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">${t('kb.scopeLabel')}</label>
          <select class="form-select" id="kbScope">${scopes.map(s => `<option value="${s}" ${x.scope === s ? 'selected' : ''}>${t('kb.scope.' + s)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">${t('tpl.category')}</label>
          <select class="form-select" id="kbCat">${cats.map(c => `<option value="${c}" ${x.category === c ? 'selected' : ''}>${t('category.' + c)}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">${t('kb.project')}</label>
          <input class="form-input" id="kbProject" value="${esc(x.project_code || '')}" placeholder="project_code"></div>
        <div class="form-group"><label class="form-label">${t('kb.tags')}</label>
          <input class="form-input" id="kbTags" value="${esc(x.tags || '')}" placeholder="postgres,deadlock"></div>
      </div>
      <div class="form-group"><label class="form-label">${t('kb.problem')} *</label>
        <textarea class="form-textarea" id="kbProblem" style="min-height:90px;">${esc(x.problem || '')}</textarea></div>
      <div class="form-group"><label class="form-label">${t('kb.solution')} *</label>
        <textarea class="form-textarea" id="kbSolution" style="min-height:150px;">${esc(x.solution || '')}</textarea></div>
      <div style="font-size:12px;color:var(--muted);">${t('kb.scopeHint')}</div>`;
    openModal(id ? t('kb.edit') : t('kb.create'), body,
      `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
       <button class="btn primary" id="kbSaveBtn">${t('common.save')}</button>`, 'lg');
    $('#kbSaveBtn').onclick = () => save(id);
  }

  async function save(id) {
    const data = {
      title: $('#kbTitle').value.trim(),
      scope: $('#kbScope').value,
      category: $('#kbCat').value,
      project_code: $('#kbProject').value.trim() || null,
      tags: $('#kbTags').value.trim() || null,
      problem: $('#kbProblem').value.trim(),
      solution: $('#kbSolution').value.trim(),
    };
    if (!data.title || !data.problem || !data.solution) return toast(t('kb.required'), 'error');
    try {
      if (id) await API.put('/knowledge/' + id, data);
      else await API.post('/knowledge', data);
      closeModal();
      toast(t('kb.saved'), 'success');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  function remove(id) {
    confirmDialog(t('common.delete'), t('kb.confirmDelete'), async () => {
      try {
        await API.del('/knowledge/' + id);
        toast(t('kb.deleted'), 'success');
        load();
      } catch (e) { toast(e.message, 'error'); }
    }, true);
  }

  function search() {
    state.keyword = ($('#kbKeyword') || {}).value || '';
    state.scope = ($('#kbScopeFilter') || {}).value || '';
    state.category = ($('#kbCatFilter') || {}).value || '';
    state.page = 1;
    load();
  }

  /** 任务详情侧栏：相似历史答复（工程师答复时参考） */
  async function similarForTask(taskId) {
    const box = document.getElementById('kbSimilarBox');
    if (!box) return;
    box.innerHTML = `<span style="color:var(--muted);font-size:12px;">…</span>`;
    try {
      const r = await API.get('/knowledge/similar?task_id=' + taskId + '&limit=3');
      const list = r.data || [];
      if (!list.length) {
        box.innerHTML = `<span style="color:var(--muted);font-size:12px;">${t('kb.noSimilar')}</span>`;
        return;
      }
      box.innerHTML = list.map(x => `
        <div class="kb-sim" onclick="window.HLM.Knowledge.view(${x.id})">
          <div class="kb-sim-t">${esc(x.title)} ${scopeTag(x.scope)}</div>
          <div class="kb-sim-s">${esc(String(x.solution).slice(0, 120))}</div>
        </div>`).join('');
    } catch (e) {
      box.innerHTML = '';
    }
  }

  /** 完成任务的答复一键沉淀 */
  async function promptFromTask(taskId) {
    try {
      const r = await API.get('/knowledge/from-task/' + taskId);
      const d = r.data;
      const body = `
        <div class="form-group"><label class="form-label">${t('kb.title')}</label>
          <input class="form-input" id="kbTitle" value="${esc(d.title)}"></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">${t('kb.scopeLabel')}</label>
            <select class="form-select" id="kbScope">${['project', 'tenant', 'global'].map(s => `<option value="${s}" ${d.scope === s ? 'selected' : ''}>${t('kb.scope.' + s)}</option>`).join('')}</select></div>
          <div class="form-group"><label class="form-label">${t('tpl.category')}</label>
            <select class="form-select" id="kbCat" ${d.category === 'confidential' ? 'disabled' : ''}>
              ${['general', 'confidential', 'ops'].map(c => `<option value="${c}" ${d.category === c ? 'selected' : ''}>${t('category.' + c)}</option>`).join('')}
            </select></div>
        </div>
        <div class="form-group"><label class="form-label">${t('kb.project')}</label>
          <input class="form-input" id="kbProject" value="${esc(d.project_code || '')}"></div>
        <div class="form-group"><label class="form-label">${t('kb.tags')}</label>
          <input class="form-input" id="kbTags" value="${esc(d.tags || '')}"></div>
        <div class="form-group"><label class="form-label">${t('kb.problem')}</label>
          <textarea class="form-textarea" id="kbProblem" style="min-height:90px;">${esc(d.problem)}</textarea></div>
        <div class="form-group"><label class="form-label">${t('kb.solution')}</label>
          <textarea class="form-textarea" id="kbSolution" style="min-height:150px;">${esc(d.solution)}</textarea></div>`;
      openModal(t('kb.fromTask'), body,
        `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
         <button class="btn primary" id="kbSaveBtn">${t('kb.saveToKb')}</button>`, 'lg');
      $('#kbSaveBtn').onclick = async () => {
        const data = {
          title: $('#kbTitle').value.trim(),
          scope: $('#kbScope').value,
          category: $('#kbCat').value,
          project_code: $('#kbProject').value.trim() || null,
          tags: $('#kbTags').value.trim() || null,
          problem: $('#kbProblem').value.trim(),
          solution: $('#kbSolution').value.trim(),
          source_task_id: taskId,
        };
        try {
          await API.post('/knowledge', data);
          closeModal();
          toast(t('kb.saved'), 'success');
        } catch (e) { toast(e.message, 'error'); }
      };
    } catch (e) { toast(e.message, 'error'); }
  }

  window.HLM.Knowledge = {
    load, view, promptSave, save, remove, search, similarForTask, promptFromTask,
    page: (n) => { state.page = Math.max(1, n); load(); },
  };
})();
