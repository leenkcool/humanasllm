/* annotations.js — 产出标注 + 私有评测集（数据飞轮：标注 → 快照 → SFT/评测集） */
window.HLM = window.HLM || {};

(function () {
  const { $, esc, fmt, toast, openModal, closeModal, Icons } = window.HLM.U;
  const { t } = window.HLM.I18n;
  const { API } = window.HLM;

  const state = { filter: 'unannotated', category: '', page: 1 };
  const PAGE_SIZE = 20;

  const isAdmin = () => ((window.HLM.currentUser || {}).role === 'admin');

  const labelOf = (k) => t('an.label.' + k);
  const LABEL_CLASS = { good: 'completed', partial: 'pending', bad: 'returned' };

  function labelTag(v) {
    if (!v) return `<span class="tag">${t('an.unlabeled')}</span>`;
    return `<span class="tag ${LABEL_CLASS[v] || ''}">${esc(labelOf(v))}</span>`;
  }

  // ===== 统计 =====
  async function loadStats() {
    const box = $('#anStats');
    if (!box) return;
    try {
      const r = await API.get('/annotations/stats');
      const d = r.data;
      box.innerHTML = `
        <div class="stat"><div class="num">${d.completed}</div><div class="lbl">${t('an.stat.completed')}</div></div>
        <div class="stat"><div class="num">${d.annotated}</div><div class="lbl">${t('an.stat.annotated')}</div></div>
        <div class="stat"><div class="num">${d.coverage != null ? d.coverage + '%' : '-'}</div><div class="lbl">${t('an.stat.coverage')}</div></div>
        <div class="stat completed"><div class="num">${d.good}</div><div class="lbl">${t('an.label.good')}</div></div>
        <div class="stat returned"><div class="num">${d.bad}</div><div class="lbl">${t('an.label.bad')}</div></div>
        <div class="stat"><div class="num">${d.eval_sets}</div><div class="lbl">${t('an.stat.sets')}</div></div>`;
      const extra = $('#anExtra');
      if (extra) {
        const tags = (d.top_tags || []).map(x => `<span class="chip">${esc(x.tag)} · ${x.count}</span>`).join('');
        extra.style.display = tags ? '' : 'none';
        extra.innerHTML = tags
          ? `<div class="card-head"><span class="t">${t('an.topTags')}</span></div><div class="card-body" style="display:flex;gap:6px;flex-wrap:wrap;">${tags}</div>`
          : '';
      }
    } catch (e) { /* 统计失败不阻塞队列 */ }
  }

  // ===== 待标注队列 =====
  async function loadQueue() {
    const box = $('#anQueueBox');
    if (!box) return;
    box.innerHTML = `<div class="empty" style="padding:20px;">…</div>`;
    try {
      const qs = `?filter=${state.filter}&size=${PAGE_SIZE}&page=${state.page}${state.category ? '&category=' + state.category : ''}`;
      const r = await API.get('/annotations/candidates' + qs);
      const d = r.data;
      if (!d.data.length) {
        box.innerHTML = `<div class="empty" style="padding:24px;">${t('an.queueEmpty')}</div>`;
        return;
      }
      const rows = d.data.map(x => `
        <tr>
          <td class="nowrap"><span class="mono">#${x.task_id}</span></td>
          <td><span class="tag ${esc(x.category)}">${t('category.' + x.category)}</span></td>
          <td style="max-width:320px;">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(String(x.result_text || '').slice(0, 70))}</div>
            ${x.tags ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">${esc(x.tags)}</div>` : ''}
          </td>
          <td>${labelTag(x.label)}</td>
          <td class="nowrap" style="font-size:12px;color:var(--muted);">${fmt(x.completed_at)}</td>
          <td class="nowrap">
            <button class="btn sm" onclick="window.HLM.UI.openDetail(${x.task_id})">${t('common.view')}</button>
            <button class="btn sm primary" onclick="window.HLM.Annotations.promptAnnotate(${x.task_id})">${x.label ? t('an.reannotate') : t('an.annotate')}</button>
          </td>
        </tr>`).join('');
      const pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
      box.innerHTML = `<div class="tbl-wrap"><table class="data">
        <thead><tr><th>${t('table.id')}</th><th>${t('tpl.category')}</th><th>${t('an.answer')}</th>
          <th>${t('an.label')}</th><th>${t('table.completedAt')}</th><th>${t('table.action')}</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;font-size:12px;color:var(--muted);">
          <span>${d.total} ${t('an.total')}</span>
          <span style="display:flex;gap:6px;">
            <button class="btn sm" ${state.page <= 1 ? 'disabled' : ''} onclick="window.HLM.Annotations.page(-1)">‹</button>
            <span>${state.page} / ${pages}</span>
            <button class="btn sm" ${state.page >= pages ? 'disabled' : ''} onclick="window.HLM.Annotations.page(1)">›</button>
          </span></div>`;
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  function page(delta) {
    state.page = Math.max(1, state.page + delta);
    loadQueue();
  }

  function switchTab(filter) {
    state.filter = filter;
    state.page = 1;
    document.querySelectorAll('[data-antab]').forEach(b => b.classList.toggle('primary', b.dataset.antab === filter));
    loadQueue();
  }

  function switchCategory(cat) {
    state.category = cat;
    state.page = 1;
    loadQueue();
  }

  // ===== 打标弹窗 =====
  async function promptAnnotate(taskId) {
    let cur = null;
    try { cur = (await API.get('/annotations/' + taskId)).data; } catch (e) { /* 无标注 */ }
    const c = cur || {};
    const labelOpts = ['good', 'partial', 'bad'].map(k => `
      <label class="an-radio" style="display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;">
        <input type="radio" name="anLabel" value="${k}" ${c.label === k ? 'checked' : ''}>
        <span>${esc(labelOf(k))}</span>
      </label>`).join('');
    openModal(t('an.annotate'),
      `<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${t('an.task')} <span class="mono">#${taskId}</span></div>
       <div class="form-group"><label class="form-label">${t('an.label')} *</label>
         <div style="display:flex;gap:8px;flex-wrap:wrap;">${labelOpts}</div></div>
       <div class="form-group"><label class="form-label">${t('an.tags')} <span style="color:var(--muted);font-size:11px;">${t('an.tagsHint')}</span></label>
         <input class="form-input" id="anTags" value="${esc(c.tags || '')}" placeholder="${esc(t('an.tagsPh'))}"></div>
       <div class="form-group"><label class="form-label">${t('an.note')}</label>
         <textarea class="form-textarea" id="anNote" style="min-height:70px;">${esc(c.note || '')}</textarea></div>
       <div class="form-group"><label class="form-label">${t('an.expected')} <span style="color:var(--muted);font-size:11px;">${t('an.expectedHint')}</span></label>
         <textarea class="form-textarea" id="anExpected" style="min-height:100px;">${esc(c.expected || '')}</textarea></div>`,
      `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
       <button class="btn primary" id="anOk">${t('common.save')}</button>`);
    $('#anOk').onclick = async () => {
      const pick = document.querySelector('input[name="anLabel"]:checked');
      if (!pick) return toast(t('an.pickLabel'), 'warning');
      try {
        await API.post('/annotations/' + taskId, {
          label: pick.value,
          tags: $('#anTags').value.trim(),
          note: $('#anNote').value.trim(),
          expected: $('#anExpected').value.trim(),
        });
        closeModal();
        toast(t('an.saved'), 'success');
        loadStats();
        loadQueue();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  // ===== 评测集 =====
  async function loadSets() {
    const box = $('#anSetsBox');
    if (!box) return;
    try {
      const r = await API.get('/annotations/eval-sets');
      const list = r.data || [];
      if (!list.length) {
        box.innerHTML = `<div class="empty" style="padding:24px;">${t('an.setEmpty')}</div>`;
        return;
      }
      const rows = list.map(s => {
        const st = s.stats || {};
        const cat = s.category ? t('category.' + s.category) : t('an.setMixed');
        return `<tr>
          <td class="nowrap"><span class="mono">${esc(s.version)}</span></td>
          <td>${esc(s.name || '')}</td>
          <td><span class="tag">${esc(cat)}</span></td>
          <td class="nowrap">${s.item_count}</td>
          <td class="nowrap" style="font-size:12px;">${st.good || 0} / ${st.partial || 0} / ${st.bad || 0}</td>
          <td class="nowrap" style="font-size:12px;color:var(--muted);">${fmt(s.created_at)}</td>
          <td class="nowrap">
            <button class="btn sm" onclick="window.HLM.Annotations.viewSet(${s.id})">${t('common.view')}</button>
            <button class="btn sm" onclick="window.HLM.Annotations.exportSet(${s.id}, 'sft')">${t('an.exportSft')}</button>
            <button class="btn sm" onclick="window.HLM.Annotations.exportSet(${s.id}, 'eval')">${t('an.exportEval')}</button>
          </td></tr>`;
      }).join('');
      box.innerHTML = `<div class="tbl-wrap"><table class="data">
        <thead><tr><th>${t('an.version')}</th><th>${t('an.setName')}</th><th>${t('tpl.category')}</th>
          <th>${t('an.items')}</th><th>${t('an.setDist')}</th><th>${t('table.createdAt')}</th><th>${t('table.action')}</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    } catch (e) { box.innerHTML = ''; toast(e.message, 'error'); }
  }

  async function viewSet(id) {
    try {
      const s = (await API.get('/annotations/eval-sets/' + id)).data;
      const items = (s.items || []).slice(0, 50).map(it => `
        <div class="ctx" style="margin-bottom:8px;">
          <div class="k">#${it.task_id} · ${esc(labelOf(it.label))}${it.tags ? ' · ' + esc(it.tags) : ''}</div>
          <div style="font-size:12px;color:var(--muted);margin:4px 0 2px;">${t('an.prompt')}</div>
          <pre style="max-height:120px;overflow:auto;">${esc(String(it.prompt || '').slice(0, 800))}</pre>
          <div style="font-size:12px;color:var(--muted);margin:4px 0 2px;">${t('an.expected')}</div>
          <pre style="max-height:120px;overflow:auto;">${esc(String(it.target || it.completion || '').slice(0, 800))}</pre>
        </div>`).join('');
      openModal(`${s.version} · ${s.name || ''}`,
        `<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">
           ${t('an.items')}: ${s.item_count} · ${t('an.setDist')}: ${(s.stats && s.stats.good) || 0} / ${(s.stats && s.stats.partial) || 0} / ${(s.stats && s.stats.bad) || 0}
         </div>${items || `<div class="empty">${t('an.setNoItems')}</div>`}`,
        `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.close')}</button>`, 'lg');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function createSet() {
    openModal(t('an.createSet'),
      `<div class="form-group"><label class="form-label">${t('an.setName')}</label>
         <input class="form-input" id="asName" placeholder="${esc(t('an.setNamePh'))}"></div>
       <div class="form-group"><label class="form-label">${t('tpl.category')}</label>
         <select class="form-select" id="asCat">
           <option value="general">${t('category.general')}</option>
           <option value="ops">${t('category.ops')}</option>
           <option value="confidential">${t('category.confidential')}</option>
           <option value="">${t('an.setMixed')}</option>
         </select></div>
       <div class="form-group"><label class="form-label">${t('an.setLabels')}</label>
         <div style="display:flex;gap:12px;flex-wrap:wrap;">
           ${['good', 'partial', 'bad'].map(k => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;">
             <input type="checkbox" class="asLabel" value="${k}" checked>${esc(labelOf(k))}</label>`).join('')}
         </div></div>
       <div style="font-size:12px;color:var(--muted);">${t('an.setHint')}</div>`,
      `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
       <button class="btn primary" id="asOk">${t('an.createSet')}</button>`);
    $('#asOk').onclick = async () => {
      const labels = Array.from(document.querySelectorAll('.asLabel:checked')).map(x => x.value);
      try {
        const r = await API.post('/annotations/eval-sets', {
          name: $('#asName').value.trim(),
          category: $('#asCat').value || null,
          labels,
        });
        closeModal();
        toast(t('an.setCreated', { v: r.data.version, n: r.data.item_count }), 'success');
        loadStats();
        loadSets();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  async function exportSet(id, format) {
    try {
      const res = await fetch(`${window.location.origin}/api/annotations/eval-sets/${id}/export?format=${format}`, {
        headers: {
          Authorization: 'Bearer ' + localStorage.getItem('hlm_token'),
          'Accept-Language': window.HLM.I18n.acceptHeader(),
        },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || t('csv.exportFail'));
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename=([^;]+)/.exec(cd);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m ? m[1].replace(/"/g, '') : `p390-${format}-${id}.jsonl`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(t('csv.exportOk'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 任务详情内的标注面板 =====
  async function renderForTask(taskId) {
    const box = document.getElementById('annotationBox');
    if (!box) return;
    try {
      const a = (await API.get('/annotations/' + taskId)).data;
      const body = a
        ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
             ${labelTag(a.label)}
             ${a.annotator_name ? `<span class="chip">${esc(a.annotator_name)}</span>` : ''}
             ${a.updated_at ? `<span class="chip">${fmt(a.updated_at)}</span>` : ''}</div>
           ${a.tags ? `<div style="font-size:12px;color:var(--muted);">${t('an.tags')}: ${esc(a.tags)}</div>` : ''}
           ${a.note ? `<div style="font-size:12px;margin-top:4px;">${esc(a.note)}</div>` : ''}
           ${a.expected ? `<div class="ctx" style="margin-top:6px;"><div class="k">${t('an.expected')}</div><pre>${esc(a.expected)}</pre></div>` : ''}`
        : `<span style="color:var(--muted);font-size:12px;">${t('an.none')}</span>`;
      box.innerHTML = body + `<div style="margin-top:8px;">
        <button class="btn sm" onclick="window.HLM.Annotations.promptAnnotate(${taskId})">${Icons.edit}${a ? t('an.reannotate') : t('an.annotate')}</button></div>`;
    } catch (e) { box.innerHTML = ''; }
  }

  // ===== 页面装载 =====
  async function load() {
    await loadStats();
    await loadQueue();
    await loadSets();
  }

  window.HLM.Annotations = {
    load, loadStats, loadQueue, loadSets,
    switchTab, switchCategory, page,
    promptAnnotate, createSet, exportSet, viewSet, renderForTask,
  };
})();
