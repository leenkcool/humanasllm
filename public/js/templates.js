/* templates.js — 工单模板：列表渲染 / 新建编辑 / 一键建单 */
window.HLM = window.HLM || {};

(function () {
  const { $, esc, toast, openModal, closeModal, confirmDialog, Icons, fmt } = window.HLM.U;
  const { t } = window.HLM.I18n;
  const { API } = window.HLM;

  const CATS = ['general', 'confidential', 'ops'];
  const PRIS = ['high', 'medium', 'low'];

  /** 渲染模板表（isAdmin 决定是否显示管理按钮） */
  function renderTemplates(list, container, isAdmin) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = `<div class="empty" style="padding:32px;">${t('tpl.empty')}</div>`;
      return;
    }
    box.innerHTML = list.map(x => {
      const payload = x.payload_template || {};
      const msgs = Array.isArray(payload.messages) ? payload.messages : [];
      const preview = msgs.length && msgs[0].content ? String(msgs[0].content).slice(0, 80) : '';
      return `<div class="card" style="margin-bottom:10px;">
        <div class="card-body">
          <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;">
            <div style="flex:1;min-width:220px;">
              <div style="font-weight:600;font-size:14px;">${esc(x.name)}
                <span class="tag ${esc(x.category)}" style="margin-left:6px;">${t('category.' + x.category)}</span>
                <span class="tag ${esc(x.priority)}" style="margin-left:4px;">${esc(x.priority)}</span>
                ${x.enabled === false ? '<span class="tag cancelled" style="margin-left:4px;">disabled</span>' : ''}
              </div>
              <div style="color:var(--muted);font-size:12px;margin-top:4px;">${esc(x.description || '-')}</div>
              ${preview ? `<div class="mono" style="font-size:11px;color:var(--muted);margin-top:6px;">${esc(preview)}…</div>` : ''}
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
                ${x.skills ? `<span class="chip">${t('tpl.skills')}: ${esc(x.skills)}</span>` : ''}
                ${x.project_code ? `<span class="chip">${t('tpl.project')}: ${esc(x.project_code)}</span>` : ''}
                <span class="chip">${t('tpl.uses')}: ${x.use_count || 0}</span>
                <span class="chip">${fmt(x.created_at)}</span>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start;">
              <button class="btn primary sm" onclick="window.HLM.Templates.promptUse(${x.id})">${Icons.play}${t('tpl.use')}</button>
              ${isAdmin ? `<button class="btn sm" onclick="window.HLM.Templates.promptSave(${x.id})">${Icons.edit}${t('tpl.edit')}</button>
                ${x.enabled !== false ? `<button class="btn danger sm" onclick="window.HLM.Templates.remove(${x.id})">${Icons.trash}${t('tpl.delete')}</button>` : ''}` : ''}
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  async function load() {
    const box = $('#templatesBox');
    if (!box) return;
    box.innerHTML = `<div class="empty" style="padding:24px;">…</div>`;
    try {
      const r = await API.get('/templates');
      renderTemplates(r.data, box, (window.HLM.currentUser || {}).role === 'admin');
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  /** 新建 / 编辑弹窗（id 为空即新建） */
  async function promptSave(id) {
    let x = { category: 'general', priority: 'medium', payload_template: {}, enabled: true };
    if (id) {
      try {
        const r = await API.get('/templates/' + id);
        x = r.data;
      } catch (e) { return toast(e.message, 'error'); }
    }
    const payloadText = JSON.stringify(x.payload_template || {}, null, 2);
    const body = `
      <div class="form-group"><label class="form-label">${t('tpl.name')} *</label>
        <input class="form-input" id="tplName" value="${esc(x.name || '')}"></div>
      <div class="form-group"><label class="form-label">${t('tpl.desc')}</label>
        <input class="form-input" id="tplDesc" value="${esc(x.description || '')}"></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">${t('tpl.category')}</label>
          <select class="form-select" id="tplCat">${CATS.map(c => `<option value="${c}" ${x.category === c ? 'selected' : ''}>${t('category.' + c)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">${t('tpl.priority')}</label>
          <select class="form-select" id="tplPri">${PRIS.map(p => `<option value="${p}" ${x.priority === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">${t('tpl.skills')}</label>
          <input class="form-input" id="tplSkills" placeholder="${t('tpl.skillsPh')}" value="${esc(x.skills || '')}"></div>
        <div class="form-group"><label class="form-label">${t('tpl.project')}</label>
          <input class="form-input" id="tplProject" value="${esc(x.project_code || '')}"></div>
      </div>
      <div class="form-group"><label class="form-label">${t('tpl.systemPrompt')}</label>
        <textarea class="form-textarea" id="tplSys" style="min-height:80px;">${esc(x.system_prompt || '')}</textarea></div>
      <div class="form-group"><label class="form-label">${t('tpl.payload')}</label>
        <textarea class="form-textarea" id="tplPayload" placeholder='${esc(t('tpl.payloadPh'))}'>${esc(payloadText)}</textarea></div>`;
    const foot = `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
      <button class="btn primary" id="tplSaveBtn">${t('common.save')}</button>`;
    openModal(id ? t('tpl.edit') : t('tpl.create'), body, foot, 'lg');
    $('#tplSaveBtn').onclick = () => save(id);
  }

  async function save(id) {
    let payload;
    try {
      payload = JSON.parse($('#tplPayload').value || '{}');
    } catch (e) { return toast(t('tpl.badJson'), 'error'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return toast(t('tpl.badJson'), 'error');

    const data = {
      name: $('#tplName').value.trim(),
      description: $('#tplDesc').value.trim(),
      category: $('#tplCat').value,
      priority: $('#tplPri').value,
      skills: $('#tplSkills').value.trim() || null,
      project_code: $('#tplProject').value.trim() || null,
      system_prompt: $('#tplSys').value.trim() || null,
      payload_template: payload,
    };
    if (!data.name) return toast(t('tpl.required'), 'error');
    try {
      if (id) await API.put('/templates/' + id, data);
      else await API.post('/templates', data);
      closeModal();
      toast(t('tpl.saved'), 'success');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  function remove(id) {
    confirmDialog(t('tpl.delete'), t('tpl.confirmDelete'), async () => {
      try {
        await API.del('/templates/' + id);
        toast(t('tpl.deleted'), 'success');
        load();
      } catch (e) { toast(e.message, 'error'); }
    }, true);
  }

  /** 用模板建单：可覆盖需求文本/优先级/技能 */
  async function promptUse(id) {
    let x;
    try {
      const r = await API.get('/templates/' + id);
      x = r.data;
    } catch (e) { return toast(e.message, 'error'); }
    const payload = x.payload_template || {};
    const preset = (Array.isArray(payload.messages) && payload.messages[0] && payload.messages[0].content) || '';
    const body = `
      <div class="ctx" style="margin-bottom:12px;">
        <div class="k">${t('tpl.name')}</div>
        <div><strong>${esc(x.name)}</strong> <span class="tag ${esc(x.category)}">${t('category.' + x.category)}</span>
          ${x.skills ? `<span class="chip" style="margin-left:6px;">${esc(x.skills)}</span>` : ''}</div>
        ${x.system_prompt ? `<div class="k" style="margin-top:8px;">${t('tpl.systemPrompt')}</div><pre style="font-size:11px;">${esc(x.system_prompt)}</pre>` : ''}
      </div>
      <div class="form-group"><label class="form-label">${t('tpl.overrideMsg')}</label>
        <textarea class="form-textarea" id="useMsg" style="min-height:100px;">${esc(preset)}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">${t('tpl.priority')}</label>
          <select class="form-select" id="usePri">${PRIS.map(p => `<option value="${p}" ${x.priority === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">${t('tpl.skills')}</label>
          <input class="form-input" id="useSkills" value="${esc(x.skills || '')}"></div>
      </div>`;
    const foot = `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
      <button class="btn primary" id="useBtn">${t('tpl.use')}</button>`;
    openModal(t('tpl.useTitle'), body, foot);
    $('#useBtn').onclick = async () => {
      const msg = $('#useMsg').value.trim();
      const overrides = {
        priority: $('#usePri').value,
        skills: $('#useSkills').value.trim() || undefined,
      };
      if (msg) overrides.messages = [{ role: 'user', content: msg }];
      try {
        const r = await API.post('/templates/' + id + '/apply', { overrides });
        closeModal();
        toast(`${t('tpl.created')} #${r.data.task_id}`, 'success');
        location.hash = '#/queue';
        if (window.HLM.App && window.HLM.App.route) window.HLM.App.route();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  window.HLM.Templates = { renderTemplates, load, promptSave, save, remove, promptUse };
})();
