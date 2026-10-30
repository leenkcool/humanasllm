/* review.js — 答复审核：四维评分 / 退回修改 / 抽检 */
window.HLM = window.HLM || {};

(function () {
  const { $, esc, fmt, toast, openModal, closeModal, Icons } = window.HLM.U;
  const { t } = window.HLM.I18n;
  const { API } = window.HLM;

  const ST_LABEL = () => ({
    draft: t('rv.status.draft'),
    needs_revision: t('rv.status.needs_revision'),
    reviewed: t('rv.status.reviewed'),
    delivered: t('rv.status.delivered'),
    spot_checked: t('rv.status.spot_checked'),
  });

  function scoreRow(name, value) {
    const n = parseInt(value, 10) || 0;
    return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:12px;color:var(--muted)">${esc(name)}</span>
      <span style="font-weight:600;">${n ? n + ' / 5' : '-'}</span></div>`;
  }

  /** 任务详情里的审核面板（异步填 #reviewBox） */
  async function renderForTask(taskId) {
    const box = document.getElementById('reviewBox');
    if (!box) return;
    try {
      const r = await API.get('/reviews/' + taskId);
      const x = r.data;
      if (!x) {
        box.innerHTML = `<span style="color:var(--muted);font-size:12px;">${t('rv.none')}</span>`;
        return;
      }
      const labels = ST_LABEL();
      const badge = `<span class="tag ${x.status === 'delivered' || x.status === 'spot_checked' ? 'completed' : x.status === 'needs_revision' ? 'returned' : 'pending'}">${esc(labels[x.status] || x.status)}</span>`;
      let html = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">${badge}
        ${x.reviewer_name ? `<span class="chip">${t('rv.reviewer')}: ${esc(x.reviewer_name)}</span>` : ''}
        ${x.score_total != null ? `<span class="chip">${t('rv.scoreTotal')}: ${x.score_total}</span>` : ''}
        ${x.reviewed_at ? `<span class="chip">${fmt(x.reviewed_at)}</span>` : ''}</div>`;
      if (x.score_completeness != null) {
        html += scoreRow(t('rv.dim.completeness'), x.score_completeness)
          + scoreRow(t('rv.dim.accuracy'), x.score_accuracy)
          + scoreRow(t('rv.dim.actionable'), x.score_actionable)
          + scoreRow(t('rv.dim.boundary'), x.score_boundary);
      }
      if (x.revision_note) {
        html += `<div class="ctx" style="border-left:3px solid var(--danger);margin-top:8px;"><div class="k">${t('rv.revisionNote')}</div><pre>${esc(x.revision_note)}</pre></div>`;
      }
      if (x.note) html += `<div style="font-size:12px;color:var(--muted);margin-top:6px;">${esc(x.note)}</div>`;
      // 操作按钮
      const canReview = x.status === 'draft' || x.status === 'needs_revision';
      if (canReview) {
        html += `<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">
          <button class="btn primary sm" onclick="window.HLM.Review.promptApprove(${taskId})">${Icons.check}${t('rv.approve')}</button>
          <button class="btn danger sm" onclick="window.HLM.Review.promptRevision(${taskId})">${t('rv.revision')}</button>
        </div>`;
      }
      if (x.status === 'delivered' && (window.HLM.currentUser || {}).role === 'admin') {
        html += `<div style="display:flex;gap:6px;margin-top:10px;">
          <button class="btn sm" onclick="window.HLM.Review.spotCheck(${taskId}, true)">${t('rv.spotPass')}</button>
          <button class="btn danger sm" onclick="window.HLM.Review.spotCheck(${taskId}, false)">${t('rv.spotFail')}</button>
        </div>`;
      }
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = '';
    }
  }

  /** 审核通过（四维评分） */
  function promptApprove(taskId) {
    const dims = [
      ['completeness', t('rv.dim.completeness'), t('rv.dim.completenessHint')],
      ['accuracy', t('rv.dim.accuracy'), t('rv.dim.accuracyHint')],
      ['actionable', t('rv.dim.actionable'), t('rv.dim.actionableHint')],
      ['boundary', t('rv.dim.boundary'), t('rv.dim.boundaryHint')],
    ];
    const body = dims.map(([k, label, hint]) => `
      <div class="form-group"><label class="form-label">${esc(label)} <span style="color:var(--muted);font-size:11px;">${esc(hint)}</span></label>
        <select class="form-select" id="rv_${k}">
          ${[5, 4, 3, 2, 1].map(v => `<option value="${v}">${v} ${t('rv.score.' + v)}</option>`).join('')}
        </select></div>`).join('')
      + `<div class="form-group"><label class="form-label">${t('rv.note')}</label>
           <textarea class="form-textarea" id="rvNote" style="min-height:70px;"></textarea></div>`;
    openModal(t('rv.approve'), body,
      `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
       <button class="btn primary" id="rvOk">${t('rv.approveAndRelease')}</button>`);
    $('#rvOk').onclick = async () => {
      const scores = {};
      for (const [k] of dims) scores[k] = parseInt($('#rv_' + k).value, 10);
      try {
        const r = await API.post(`/reviews/${taskId}/approve`, { scores, note: $('#rvNote').value.trim() });
        closeModal();
        toast(t('rv.approved', { score: r.data.score_total }), 'success');
        renderForTask(taskId);
        if (window.HLM.refresh) window.HLM.refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  /** 退回修改 */
  function promptRevision(taskId) {
    openModal(t('rv.revision'),
      `<div class="form-group"><label class="form-label">${t('rv.revisionReason')} *</label>
        <textarea class="form-textarea" id="rvReason" style="min-height:90px;"></textarea></div>`,
      `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
       <button class="btn danger" id="rvBack">${t('rv.revision')}</button>`);
    $('#rvBack').onclick = async () => {
      const reason = $('#rvReason').value.trim();
      if (!reason) return toast(t('rv.needReason'), 'error');
      try {
        await API.post(`/reviews/${taskId}/revision`, { reason });
        closeModal();
        toast(t('rv.revisionDone'), 'success');
        renderForTask(taskId);
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  async function spotCheck(taskId, pass) {
    try {
      await API.post(`/reviews/${taskId}/spot-check`, { pass, note: '' });
      toast(pass ? t('rv.spotPassed') : t('rv.spotFailed'), pass ? 'success' : 'warning');
      renderForTask(taskId);
    } catch (e) { toast(e.message, 'error'); }
  }

  /** 工作台待审队列 */
  async function loadPending() {
    const box = $('#reviewQueueBox');
    if (!box) return;
    box.innerHTML = `<div class="empty" style="padding:20px;">…</div>`;
    try {
      const r = await API.get('/reviews/pending?size=20');
      const d = r.data;
      window._pendingReviews = d.total;
      if (!d.data.length) {
        box.innerHTML = `<div class="empty" style="padding:24px;">${t('rv.queueEmpty')}</div>`;
        return;
      }
      box.innerHTML = `<div class="tbl-wrap"><table class="data">
        <thead><tr><th>${t('table.id')}</th><th>${t('tpl.category')}</th><th>${t('table.priority')}</th>
          <th>${t('table.summary')}</th><th>${t('table.createdAt')}</th><th>${t('table.action')}</th></tr></thead>
        <tbody>${d.data.map(x => `<tr>
          <td class="nowrap"><span class="mono">#${x.task_id}</span></td>
          <td><span class="tag ${esc(x.category)}">${t('category.' + x.category)}</span></td>
          <td><span class="tag ${esc(x.priority)}">${esc(x.priority)}</span></td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(String(x.result_text || '').slice(0, 60))}</td>
          <td class="nowrap" style="font-size:12px;color:var(--muted);">${fmt(x.updated_at)}</td>
          <td class="nowrap"><button class="btn sm primary" onclick="window.HLM.UI.openDetail(${x.task_id})">${t('rv.review')}</button></td>
        </tr>`).join('')}</tbody></table></div>`;
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  window.HLM.Review = { renderForTask, promptApprove, promptRevision, spotCheck, loadPending };
})();
