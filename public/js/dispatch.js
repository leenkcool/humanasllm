/* dispatch.js — 智能派单：任务详情里的推荐人选面板 + 一键派单 */
window.HLM = window.HLM || {};

(function () {
  const { $, esc, toast, openModal, closeModal, Icons } = window.HLM.U;
  const { t } = window.HLM.I18n;
  const { API } = window.HLM;

  const isAdmin = () => (window.HLM.currentUser || {}).role === 'admin';

  /** 任务详情里的推荐人选区块（异步填 #dispatchBox，范式同 verifyChain） */
  async function suggest(taskId) {
    const box = document.getElementById('dispatchBox');
    if (!box) return;
    box.innerHTML = `<div style="color:var(--muted);font-size:12px;">…</div>`;
    try {
      const r = await API.get(`/dispatch/tasks/${taskId}/suggest?limit=5`);
      box.innerHTML = renderRanking(r.data, taskId);
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  function scoreBar(score) {
    const color = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--warning)' : 'var(--muted)';
    return `<div class="score-bar" title="${score}">
      <span style="width:${Math.max(2, Math.min(100, score))}%;background:${color};"></span>
    </div>`;
  }

  function renderRanking(data, taskId) {
    if (!data.candidates || !data.candidates.length) {
      return `<div style="color:var(--muted);font-size:12px;">${t('dispatch.noCandidate')}</div>`;
    }
    if (!data.assignable) {
      return `<div style="color:var(--muted);font-size:12px;margin-bottom:8px;">${t('dispatch.notAssignable', { status: data.status })}</div>`;
    }
    return `<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">
        ${t('dispatch.requiredSkills')}: ${data.required_skills.length ? esc(data.required_skills.join(', ')) : t('dispatch.noSkills')}
      </div>` + data.candidates.map((c, i) => `
      <div class="dispatch-row">
        <div style="flex:1;min-width:180px;">
          <div style="font-weight:600;font-size:13px;">${i === 0 ? `<span class="tag completed" style="margin-right:6px;">${t('dispatch.recommend')}</span>` : ''}${esc(c.name)}
            <span style="color:var(--muted);font-weight:400;">@${esc(c.username)}</span></div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px;">${c.reasons.map(esc).join(' · ')}</div>
        </div>
        <div style="width:120px;text-align:right;">
          ${scoreBar(c.score)}
          <div style="font-size:12px;font-weight:600;margin-top:3px;">${c.score}</div>
        </div>
        ${isAdmin() ? `<button class="btn sm primary" onclick="window.HLM.Dispatch.assign(${taskId}, ${c.user_id})">${Icons.zap}${t('dispatch.assign')}</button>` : ''}
      </div>`).join('');
  }

  /** 一键派单（不指定 user_id 时由服务端取推荐第一位） */
  async function assign(taskId, userId) {
    try {
      const body = {};
      if (userId) body.user_id = userId;
      const r = await API.post(`/dispatch/tasks/${taskId}/assign`, body);
      const who = r.data && r.data.assignee ? r.data.assignee.name : '';
      toast(t('dispatch.assigned', { name: who }), 'success');
      closeModal();
      if (window.HLM.refresh) window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  /** 队列页批量建议：对当前页所有可派任务给出推荐（只读展示） */
  async function suggestBatch(taskIds) {
    const out = [];
    for (const id of taskIds.slice(0, 10)) {
      try {
        const r = await API.get(`/dispatch/tasks/${id}/suggest?limit=1`);
        if (r.data.recommended) out.push({ task_id: id, ...r.data.recommended });
      } catch (e) { /* 单条失败忽略 */ }
    }
    return out;
  }

  window.HLM.Dispatch = { suggest, assign, suggestBatch, renderRanking };
})();
