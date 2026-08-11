/* ui.js — 任务列表 / 详情模态 / 状态操作 / 用户 / 日志 渲染 */
window.HLM = window.HLM || {};

(function () {
  const { API } = window.HLM;
  const U = window.HLM.U;
  const { Icons, $, esc, fmt, jsonStr, nl, toast, openModal, closeModal, confirmDialog, STATUS_LABEL } = U;
  const { t } = window.HLM.I18n;

  // ===== 任务表格 =====
  function renderTasks(list, containerId) {
    const box = $(containerId);
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<tr><td colspan="9" class="empty">${t('task.empty')}</td></tr>`;
      return;
    }
    box.innerHTML = list.map(task => {
      const summary = task.request_payload?.messages?.find(m => m.role === 'user')?.content;
      return `<tr>
        <td class="nowrap"><span class="mono">#${task.id}</span></td>
        <td><span class="tag ${task.priority}">${esc(task.priority)}</span>${task.category && task.category !== 'general' ? ` <span class="tag ${task.category}" title="${esc(t('category.hint.' + task.category))}">${t('category.' + task.category)}</span>` : ''}</td>
        <td><span class="tag ${task.status}">${STATUS_LABEL[task.status] || task.status}</span></td>
        <td>${esc(task.project_name || task.project_code || '-')}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(String(summary || '').slice(0, 60))}</td>
        <td class="nowrap">${esc(task.assignee_name || '-')}</td>
        <td class="nowrap" style="color:var(--muted);font-size:12px;">${fmt(task.created_at)}</td>
        <td class="nowrap" data-timeout="${task.timeout_at || ''}" data-status="${task.status}" style="font-size:12px;">${renderTimeoutCell(task.timeout_at, task.status)}</td>
        <td class="nowrap">
          <div style="display:flex;gap:6px;">
            <button class="btn sm" onclick="window.HLM.UI.openDetail(${task.id})">${t('common.view')}</button>
            ${task.status === 'pending' ? `<button class="btn sm primary" onclick="window.HLM.UI.doAction('claim',${task.id})">${t('task.claim')}</button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // ===== 超时剩余时间倒计时 =====
  function fmtRemain(ms) {
    if (ms <= 0) return { label: t('task.timeout'), danger: true };
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    let out = '';
    if (d > 0) out += d + t('task.timeout.days');
    if (h > 0 || d > 0) out += h + t('task.timeout.hours');
    if (m > 0 || h > 0 || d > 0) out += m + t('task.timeout.mins');
    out += sec + t('task.timeout.secs');
    return { label: out, danger: false };
  }
  function renderTimeoutCell(timeoutAt, status) {
    if (!timeoutAt || ['completed', 'cancelled'].includes(status)) return '-';
    const ms = new Date(timeoutAt).getTime() - Date.now();
    const r = fmtRemain(ms);
    return r.danger
      ? '<span style="color:var(--danger);font-weight:600;">' + t('task.timeout') + '</span>'
      : `<span style="color:var(--muted);">${r.label}</span>`;
  }
  function startCountdown() {
    if (window._hlmCountdown) return;
    window._hlmCountdown = true;
    setInterval(() => {
      document.querySelectorAll('[data-timeout]').forEach(td => {
        const t = td.dataset.timeout;
        const st = td.dataset.status || '';
        td.innerHTML = renderTimeoutCell(t, st);
      });
    }, 1000);
  }

  // ===== 任务详情模态 =====
  async function openDetail(id) {
    try {
      const r = await API.get('/tasks/' + id);
      const task = r.data;
      const p = task.request_payload || {};
      const messages = Array.isArray(p.messages) ? p.messages : [];

      const metaHtml = Object.entries(task.meta_tags || {}).map(([k, v]) => `<span class="tag medium" style="margin-right:6px;">${esc(k)}: ${esc(v)}</span>`).join('');
      const msgsHtml = messages.map(m => `
        <div class="msg-row ${esc(m.role)}">
          <div class="role">${esc(m.role)}</div>
          <div class="content">${nl(m.content).split('\n').map(esc).join('<br>')}</div>
        </div>`).join('');

      const params = ['max_tokens', 'temperature', 'top_p', 'stop', 'user']
        .filter(k => p[k] != null).map(k => `${esc(k)}=${esc(String(p[k]))}`).join(' &nbsp; ');

      let resultHtml = '';
      if (task.status === 'completed' && task.result_text) {
        resultHtml = `<div class="ctx"><div class="k">${t('task.result')}</div><pre>${esc(nl(task.result_text))}</pre></div>`;
      }
      if (task.reject_reason) {
        resultHtml += `<div class="ctx" style="border-left:3px solid var(--danger);"><div class="k">${t('task.rejectReason')}</div><pre>${esc(nl(task.reject_reason))}</pre></div>`;
      }

      const body = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <span class="tag ${task.status}">${STATUS_LABEL[task.status] || task.status}</span>
          <span class="tag ${task.priority}">${esc(task.priority)}</span>
          ${task.category && task.category !== 'general' ? `<span class="tag ${task.category}" title="${esc(t('category.hint.' + task.category))}">${t('category.' + task.category)}</span>` : ''}
          ${task.stream ? '<span class="tag pending">stream</span>' : ''}
          <span class="chip">model: ${esc(task.model)}</span>
          ${task.project_code ? `<span class="chip">${t('task.project')} ${esc(task.project_name || task.project_code)}</span>` : ''}
          <span class="chip">${t('task.owner')} ${esc(task.project_name || task.project_code || t('task.unassigned'))} <button class="btn sm" style="margin-left:4px;" onclick="window.HLM.UI.promptTaskProject(${task.id})">${t('task.set')}</button></span>
          <span class="chip">upstream: <span class="mono">${esc(task.upstream_request_id || '-')}</span></span>
        </div>
        <div class="ctx" style="display:flex;gap:8px;flex-wrap:wrap;">${metaHtml || `<span class="k">${t('task.noTags')}</span>`} ${params ? `<span style="color:var(--muted);font-size:12px;align-self:center;">${params}</span>` : ''}</div>
        <div class="ctx"><div class="k">${t('task.context', { n: messages.length })}</div>${msgsHtml}</div>
        ${resultHtml}
        <div class="ctx"><div class="k">${t('task.audit')}</div><pre style="font-size:11px;">${(task.logs || []).map(l => `[${fmt(l.created_at)}] ${esc(l.action)} — ${esc(l.actor_name || t('task.system'))}${l.remark ? ' · ' + esc(l.remark) : ''}`).join('\n') || t('task.none')}</pre></div>
      `;

      const foot = actionButtons(task);
      openModal(t('task.detailTitle', { id: task.id }), body, foot, 'lg');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function actionButtons(task) {
    const id = task.id;
    const user = window.HLM.currentUser || {};
    const isOwner = task.assignee_id === user.id || user.role === 'admin';
    let btns = `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.close')}</button>`;

    if (task.status === 'pending') btns += `<button class="btn primary" onclick="window.HLM.UI.doAction('claim', ${id})">${t('task.claim')}</button>`;
    if (task.status === 'processing' && isOwner) {
      btns += `<button class="btn success" onclick="window.HLM.UI.promptComplete(${id})">${t('task.submitResult')}</button>`;
      btns += `<button class="btn danger" onclick="window.HLM.UI.promptReject(${id})">${t('task.reject')}</button>`;
      btns += `<button class="btn" onclick="window.HLM.UI.doAction('pause', ${id})">${t('task.pause')}</button>`;
    }
    if (task.status === 'paused' && isOwner) {
      btns += `<button class="btn primary" onclick="window.HLM.UI.doAction('resume', ${id})">${t('task.resume')}</button>`;
      btns += `<button class="btn danger" onclick="window.HLM.UI.promptReject(${id})">${t('task.reject')}</button>`;
    }
    if (task.status === 'returned') btns += `<button class="btn primary" onclick="window.HLM.UI.doAction('claim', ${id})">${t('task.claimAgain')}</button>`;
    if (task.status === 'returned' || task.status === 'paused') btns += `<button class="btn" onclick="window.HLM.UI.promptRequeue(${id})">${t('task.requeue')}</button>`;
    if (task.status === 'completed' && isOwner) btns += `<button class="btn danger" onclick="window.HLM.UI.promptReopen(${id})">${t('task.reopen')}</button>`;
    if (!['completed', 'cancelled'].includes(task.status)) btns += `<button class="btn danger" onclick="window.HLM.UI.promptCancel(${id})">${t('task.cancel')}</button>`;
    return btns;
  }

  // ===== 操作 =====
  async function doAction(action, id, payload) {
    try {
      const r = await API.post(`/tasks/${id}/${action}`, payload || {});
      toast(t('task.actionSuccess', { action }), 'success');
      closeModal();
      window.HLM.refresh && window.HLM.refresh();
      return r;
    } catch (e) { toast(e.message, 'error'); }
  }

  function promptComplete(id) {
    openModal(t('modal.complete.title'), `
      <div class="form-group">
        <label class="form-label">${t('modal.complete.content')}</label>
        <textarea class="form-textarea" id="completeText" rows="8" placeholder="${t('modal.complete.placeholder')}"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">${t('modal.complete.note')}</label>
        <textarea class="form-textarea" id="completeNote" rows="3" placeholder="${t('modal.complete.notePlaceholder')}"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
       <button class="btn success" onclick="window.HLM.UI.submitComplete(${id})">${t('common.submit')}</button>`);
  }
  function submitComplete(id) {
    const content = $('#completeText').value;
    const note = $('#completeNote').value;
    if (!content.trim()) { toast(t('modal.complete.empty'), 'warning'); return; }
    doAction('complete', id, { content, completion_note: note });
  }

  function promptReject(id) {
    openModal(t('modal.reject.title'), `
      <div class="form-group">
        <label class="form-label">${t('modal.reject.content')}</label>
        <textarea class="form-textarea" id="rejectReason" rows="3" placeholder="${t('modal.reject.placeholder')}"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
       <button class="btn danger" onclick="window.HLM.UI.submitReject(${id})">${t('modal.reject.confirm')}</button>`,
      'sm');
  }
  function submitReject(id) {
    const reason = $('#rejectReason').value.trim();
    if (!reason) { toast(t('modal.reject.empty'), 'warning'); return; }
    doAction('reject', id, { reason });
  }

  function promptRequeue(id) {
    openModal(t('modal.requeue.title'), `
      <div class="form-group">
        <label class="form-label">${t('modal.requeue.content')}</label>
        <textarea class="form-textarea" id="requeuePayload" rows="8" placeholder='{"model":"human-llm","messages":[...]}'></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
       <button class="btn primary" onclick="window.HLM.UI.submitRequeue(${id})">${t('modal.requeue.submit')}</button>`);
  }
  function submitRequeue(id) {
    const raw = $('#requeuePayload').value.trim();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch (e) { toast(t('modal.requeue.jsonError'), 'error'); return; }
    }
    doAction('requeue', id, { request_payload: payload });
  }

  function promptCancel(id) {
    confirmDialog(t('modal.cancel.title'), t('modal.cancel.msg'), () => doAction('cancel', id), true);
  }

  // 打回重做：产出不合格/乱答
  function promptReopen(id) {
    openModal(t('modal.reopen.title'), `
      <div class="form-group">
        <label class="form-label">${t('modal.reopen.content')}</label>
        <textarea class="form-textarea" id="reopenReason" rows="3" placeholder="${t('modal.reopen.placeholder')}"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
       <button class="btn danger" onclick="window.HLM.UI.submitReopen(${id})">${t('modal.reopen.confirm')}</button>`,
      'sm');
  }
  function submitReopen(id) {
    const reason = $('#reopenReason').value.trim();
    if (!reason) { toast(t('modal.reopen.empty'), 'warning'); return; }
    doAction('reopen', id, { reason });
  }

  // ===== 用户管理 =====
  async function renderUsers(box, isAdmin) {
    try {
      const r = await API.get('/users');
      const users = r.data;
      box.innerHTML = `
        <div class="card"><div class="card-head"><span class="t">${t('user.cardTitle')}</span>
          ${isAdmin ? `<button class="btn primary sm" onclick="window.HLM.UI.showUserForm()">${Icons.plus} ${t('user.add')}</button>` : ''}
        </div>
        <div class="card-body-flush"><div class="tbl-wrap"><table class="data">
          <thead><tr><th>${t('table.id')}</th><th>${t('user.username')}</th><th>${t('user.name')}</th><th>${t('user.skills')}</th><th>${t('user.role')}</th><th>${t('table.status')}</th><th>${t('table.createdAt')}</th>${isAdmin ? `<th>${t('table.action')}</th>` : ''}</tr></thead>
          <tbody>${users.map(u => `
            <tr>
              <td>${u.id}</td><td><strong>${esc(u.username)}</strong></td><td>${esc(u.name || '-')}</td>
              <td>${u.skills ? `<span class="tag low">${esc(u.skills)}</span>` : '-'}</td>
              <td><span class="tag ${u.role === 'admin' ? 'high' : 'medium'}">${u.role === 'admin' ? t('role.admin') : t('role.engineer')}</span></td>
              <td>${u.is_active ? `<span class="tag completed">${t('user.active')}</span>` : `<span class="tag cancelled">${t('user.disabled')}</span>`}</td>
              <td class="nowrap">${fmt(u.created_at)}</td>
              ${isAdmin ? `<td class="nowrap"><button class="btn sm" onclick="window.HLM.UI.showUserForm(${u.id})">${t('common.edit')}</button> <button class="btn sm danger" onclick="window.HLM.UI.delUser(${u.id})">${t('common.delete')}</button></td>` : ''}
            </tr>`).join('') || `<tr><td colspan="8" class="empty">${t('user.empty')}</td></tr>`}
          </tbody>
        </table></div></div></div>`;
    } catch (e) { box.innerHTML = `<div class="empty" style="padding:40px;">${esc(e.message)}</div>`; }
  }

  async function showUserForm(id) {
    const isEdit = !!id;
    let u = {};
    if (isEdit) {
      try { const r = await API.get('/users'); u = (r.data || []).find(x => x.id === id) || {}; } catch (e) { /* ignore */ }
    }
    openModal(isEdit ? t('user.editTitle') : t('user.addTitle'), `
      <div class="form-group"><label class="form-label">${t('user.username')}</label><input class="form-input" id="uName" value="${esc(u.username || '')}" ${isEdit ? 'disabled' : ''}></div>
      <div class="form-group"><label class="form-label">${t('user.name')}</label><input class="form-input" id="uNick" value="${esc(u.name || '')}"></div>
      <div class="form-group"><label class="form-label">${t('user.skills')}</label><input class="form-input" id="uSkills" value="${esc(u.skills || '')}" placeholder="${t('user.skillsPh')}"></div>
      ${!isEdit ? `<div class="form-group"><label class="form-label">${t('user.password')}</label><input class="form-input" id="uPass" type="password"></div>` : ''}
      <div class="form-group"><label class="form-label">${t('user.role')}</label><select class="form-select" id="uRole"><option value="engineer" ${u.role !== 'admin' ? 'selected' : ''}>${t('role.engineer')}</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>${t('role.admin')}</option></select></div>
    `, `
      <button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
      <button class="btn primary" onclick="window.HLM.UI.saveUser(${id || 'null'})">${t('common.save')}</button>`);
  }

  async function saveUser(id) {
    const username = $('#uName').value.trim();
    const name = $('#uNick').value.trim();
    const skills = $('#uSkills').value.trim();
    const role = $('#uRole').value;
    const password = id ? undefined : $('#uPass').value;
    if (!username) { toast(t('user.requiredUsername'), 'warning'); return; }
    if (!id && !password) { toast(t('user.requiredPassword'), 'warning'); return; }
    try {
      if (id) { await API.put('/users/' + id, { name, role, skills }); }
      else { await API.post('/users', { username, password, role, name, skills }); }
      toast(t('user.saved'), 'success');
      closeModal();
      window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  function delUser(id) {
    confirmDialog(t('user.delTitle'), t('user.delMsg'), async () => {
      try { await API.del('/users/' + id); toast(t('user.deleted'), 'success'); window.HLM.refresh && window.HLM.refresh(); }
      catch (e) { toast(e.message, 'error'); }
    }, true);
  }

  // ===== 日志 =====
  async function renderLogs(box, kind) {
    try {
      const r = await API.get('/logs/' + (kind === 'audit' ? 'tasks' : 'requests') + '?size=50');
      const rows = r.data.data;
      const isReq = kind !== 'audit';
      box.innerHTML = `<div class="card"><div class="card-head"><span class="t">${isReq ? t('log.reqTitle') : t('log.auditTitle')}</span><span class="chip">${t('log.count', { n: r.data.total })}</span></div>
        <div class="card-body-flush"><div class="tbl-wrap"><table class="data">
          <thead><tr>${isReq
            ? `<th>${t('table.id')}</th><th>${t('log.direction')}</th><th>${t('log.task')}</th><th>${t('log.model')}</th><th>${t('log.summary')}</th><th>${t('table.time')}</th>`
            : `<th>${t('table.id')}</th><th>${t('log.task')}</th><th>${t('log.action')}</th><th>${t('log.actor')}</th><th>${t('log.remark')}</th><th>${t('table.time')}</th>`}</tr></thead>
          <tbody>${rows.map(x => isReq
            ? `<tr><td>${x.id}</td><td><span class="tag ${x.direction === 'in' ? 'pending' : 'completed'}">${x.direction === 'in' ? 'IN' : 'OUT'}</span></td><td><span class="mono">#${x.task_id || '-'}</span></td><td>${esc(x.model || '-')}</td><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(jsonStr(x.payload).slice(0, 80))}</td><td class="nowrap">${fmt(x.created_at)}</td></tr>`
            : `<tr><td>${x.id}</td><td><span class="mono">#${x.task_id}</span></td><td><span class="tag ${x.action}">${esc(x.action)}</span></td><td>${esc(x.actor_name || '-')}</td><td>${esc(x.remark || '-')}</td><td class="nowrap">${fmt(x.created_at)}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">${t('log.empty')}</td></tr>`}
          </tbody>
        </table></div></div></div>`;
    } catch (e) { box.innerHTML = `<div class="empty" style="padding:40px;">${esc(e.message)}</div>`; }
  }

  // ===== 审批 =====
  const APPROVAL_LABEL = {};
  ['pending', 'approved', 'rejected'].forEach(k => {
    Object.defineProperty(APPROVAL_LABEL, k, { enumerable: true, get: () => t('approval.status.' + k) });
  });

  async function renderApprovals(list, box) {
    box.innerHTML = `<div class="card"><div class="card-body-flush"><div class="tbl-wrap"><table class="data">
      <thead><tr><th>${t('approval.no')}</th><th>${t('approval.resource')}</th><th>${t('approval.amount')}</th><th>${t('approval.purpose')}</th><th>${t('table.status')}</th><th>${t('approval.requester')}</th><th>${t('table.createdAt')}</th><th>${t('table.action')}</th></tr></thead>
      <tbody>${list.map(a => `
        <tr>
          <td class="nowrap"><span class="mono">${esc(a.approval_no)}</span></td>
          <td><strong>${esc(a.resource)}</strong></td>
          <td>${esc(a.amount || '-')}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.purpose || '')}</td>
          <td><span class="tag ${a.status}">${APPROVAL_LABEL[a.status] || a.status}</span></td>
          <td>${esc(a.requester || '-')}</td>
          <td class="nowrap">${fmt(a.created_at)}</td>
          <td class="nowrap"><button class="btn sm" onclick="window.HLM.UI.openApproval(${a.id})">${t('approval.operate')}</button></td>
        </tr>`).join('') || `<tr><td colspan="8" class="empty">${t('approval.empty')}</td></tr>`}
      </tbody></table></div></div></div>`;
  }

  async function openApproval(id) {
    try {
      const r = await API.get('/approvals/' + id);
      const a = r.data;
      openModal(t('approval.detailTitle', { no: a.approval_no }), `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <span class="tag ${a.status}">${APPROVAL_LABEL[a.status] || a.status}</span>
          <span class="chip">${t('approval.requesterColon')} ${esc(a.requester || '-')}</span>
          ${a.project_code ? `<span class="chip">${t('approval.project')} ${esc(a.project_code)}</span>` : ''}
        </div>
        <div class="ctx"><div class="k">${t('approval.resource')}</div><pre>${esc(a.resource)}${a.amount ? ' · ' + esc(a.amount) : ''}</pre></div>
        ${a.purpose ? `<div class="ctx"><div class="k">${t('approval.purpose')}</div><pre>${esc(nl(a.purpose))}</pre></div>` : ''}
        ${a.detail ? `<div class="ctx"><div class="k">${t('approval.detail')}</div><pre>${esc(nl(a.detail))}</pre></div>` : ''}
        ${a.provided ? `<div class="ctx" style="border-left:3px solid var(--success);"><div class="k">${t('approval.provided')}</div><pre>${esc(nl(a.provided))}</pre></div>` : ''}
        ${a.reject_reason ? `<div class="ctx" style="border-left:3px solid var(--danger);"><div class="k">${t('approval.rejectReason')}</div><pre>${esc(nl(a.reject_reason))}</pre></div>` : ''}
      `, approvalActions(a), 'lg');
    } catch (e) { toast(e.message, 'error'); }
  }

  function approvalActions(a) {
    if (a.status !== 'pending') return `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.close')}</button>`;
    const id = a.id;
    return `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.close')}</button>
      <button class="btn success" onclick="window.HLM.UI.promptApprove(${id})">${t('approval.approveProvide')}</button>
      <button class="btn danger" onclick="window.HLM.UI.promptApproveReject(${id})">${t('task.reject')}</button>`;
  }

  function promptApprove(id) {
    openModal(t('approval.approveTitle'), `
      <div class="form-group">
        <label class="form-label">${t('approval.approveContent')}</label>
        <textarea class="form-textarea" id="approveProvided" rows="4" placeholder="${t('approval.approvePlaceholder')}"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
       <button class="btn success" onclick="window.HLM.UI.submitApprove(${id})">${t('approval.approve')}</button>`);
  }

  async function submitApprove(id) {
    const provided = $('#approveProvided').value;
    try {
      await API.post('/approvals/' + id + '/approve', { provided });
      toast(t('approval.approvedNote'), 'success');
      closeModal();
      window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  function promptApproveReject(id) {
    openModal(t('approval.rejectTitle'), `
      <div class="form-group">
        <label class="form-label">${t('approval.rejectContent')}</label>
        <textarea class="form-textarea" id="approveRejectReason" rows="3" placeholder="${t('approval.rejectPlaceholder')}"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
       <button class="btn danger" onclick="window.HLM.UI.submitApproveReject(${id})">${t('approval.rejectConfirm')}</button>`,
      'sm');
  }

  async function submitApproveReject(id) {
    const reason = $('#approveRejectReason').value.trim();
    if (!reason) { toast(t('approval.rejectEmpty'), 'warning'); return; }
    try {
      await API.post('/approvals/' + id + '/reject', { reason });
      toast(t('approval.rejected'), 'success');
      closeModal();
      window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 项目管理 =====
  function projectFormHtml(p) {
    return `
      <div class="form-group"><label class="form-label">${t('project.code')}</label><input class="form-input" id="pjCode" value="${p ? esc(p.code) : ''}" ${p ? 'disabled' : ''} placeholder="${t('project.codePlaceholder')}"></div>
      <div class="form-group"><label class="form-label">${t('project.name')}</label><input class="form-input" id="pjName" value="${p ? esc(p.name) : ''}"></div>
      <div class="form-group"><label class="form-label">${t('project.desc')}</label><textarea class="form-textarea" id="pjDesc" rows="3">${p ? esc(p.description || '') : ''}</textarea></div>`;
  }
  function promptCreateProject() {
    openModal(t('project.createTitle'), projectFormHtml(null), `
      <button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
      <button class="btn primary" onclick="window.HLM.UI.submitCreateProject()">${t('project.create')}</button>`, 'sm');
  }
  async function submitCreateProject() {
    const code = $('#pjCode').value.trim();
    const name = $('#pjName').value.trim();
    if (!code || !name) { toast(t('project.codeNameRequired'), 'warning'); return; }
    try {
      await API.post('/projects', { code, name, description: $('#pjDesc').value });
      toast(t('project.created'), 'success'); closeModal(); window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  function promptApplyProject() {
    openModal(t('project.applyTitle'), projectFormHtml(null) + `<p style="color:var(--muted);font-size:12px;margin-top:8px;">${t('project.applyNote')}</p>`, `
      <button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
      <button class="btn primary" onclick="window.HLM.UI.submitApplyProject()">${t('project.applySubmit')}</button>`, 'sm');
  }
  async function submitApplyProject() {
    const code = $('#pjCode').value.trim();
    const name = $('#pjName').value.trim();
    if (!code || !name) { toast(t('project.codeNameRequired'), 'warning'); return; }
    try {
      const r = await API.post('/projects/apply', { code, name, description: $('#pjDesc').value });
      toast(r.message || t('project.applySubmitted'), 'success'); closeModal();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function promptEditProject(id) {
    try {
      const r = await API.get('/projects');
      const p = (r.data || []).find(x => x.id === id);
      if (!p) { toast(t('project.notFound'), 'error'); return; }
      openModal(t('project.editTitle'), projectFormHtml(p), `
        <button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
        <button class="btn primary" onclick="window.HLM.UI.submitEditProject(${id})">${t('common.save')}</button>`, 'sm');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function submitEditProject(id) {
    try {
      await API.put('/projects/' + id, { name: $('#pjName').value.trim(), description: $('#pjDesc').value });
      toast(t('project.saved'), 'success'); closeModal(); window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function doArchiveProject(id) {
    try {
      await API.post('/projects/' + id + '/archive', {});
      toast(t('project.updated'), 'success'); window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function renderProjects(list, box, isAdmin) {
    box.innerHTML = `<div class="card"><div class="card-body-flush"><div class="tbl-wrap"><table class="data">
      <thead><tr><th>${t('table.code')}</th><th>${t('table.name')}</th><th>${t('table.desc')}</th><th>${t('table.status')}</th><th>${t('table.createdAt')}</th>${isAdmin ? `<th>${t('table.action')}</th>` : ''}</tr></thead>
      <tbody>${list.map(p => `
        <tr>
          <td><span class="mono">${esc(p.code)}</span></td>
          <td><strong>${esc(p.name)}</strong></td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.description || '')}</td>
          <td><span class="tag ${p.status === 'active' ? 'completed' : 'cancelled'}">${p.status === 'active' ? t('project.active') : t('project.archived')}</span></td>
          <td class="nowrap">${fmt(p.created_at)}</td>
          ${isAdmin ? `<td class="nowrap">
            <button class="btn sm" onclick="window.HLM.UI.promptEditProject(${p.id})">${t('common.edit')}</button>
            <button class="btn sm danger" onclick="window.HLM.UI.doArchiveProject(${p.id})">${p.status === 'active' ? t('project.archive') : t('project.enable')}</button>
          </td>` : ''}
        </tr>`).join('') || `<tr><td colspan="6" class="empty">${t('project.empty')}</td></tr>`}
      </tbody></table></div></div></div>`;
  }

  // 任务归属项目
  async function promptTaskProject(id) {
    try {
      const pr = await API.get('/projects');
      const projects = (pr.data || []).filter(p => p.status === 'active');
      openModal(t('project.setTask'), `
        <div class="form-group">
          <label class="form-label">${t('project.belong')}</label>
          <select class="form-select" id="taskProjectSelect">
            <option value="">${t('project.none')}</option>
            ${projects.map(p => `<option value="${esc(p.code)}">${esc(p.code)} · ${esc(p.name)}</option>`).join('')}
          </select>
        </div>`,
        `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
         <button class="btn primary" onclick="window.HLM.UI.submitTaskProject(${id})">${t('common.save')}</button>`, 'sm');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function submitTaskProject(id) {
    const code = $('#taskProjectSelect').value;
    try {
      await API.post('/tasks/' + id + '/project', { project_code: code });
      toast(t('project.attached'), 'success'); closeModal(); window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  // 导出 CSV（带 token 下载）
  async function exportCSV(url) {
    try {
      const token = localStorage.getItem('hlm_token');
      const res = await fetch(window.location.origin + '/api' + url, {
        headers: { Authorization: 'Bearer ' + token, 'Accept-Language': HLM.I18n.acceptHeader() },
      });
      if (!res.ok) throw new Error(t('csv.exportFail'));
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = url.includes('approvals') ? 'approvals.csv' : 'tasks.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast(t('csv.exportOk'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // 合规报告（数据不出网关证明）
  async function showAuditReport() {
    try {
      const r = await API.get('/audit/report');
      const d = r.data;
      const rows = [
        [t('audit.totalTasks'), d.total_tasks],
        [t('audit.protected'), `${d.protected.confidential} ${t('category.confidential')} + ${d.protected.ops} ${t('category.ops')}`],
        [t('audit.aiFallback'), `${d.ai_fallback.total} (${t('category.general')} ${d.ai_fallback.general} / ${t('audit.protectedAi')} ${d.ai_fallback.protected})`],
        [t('audit.compliance'), d.compliance],
        [t('audit.auditChain'), `${d.audit_chains.valid} ${t('audit.valid')} / ${d.audit_chains.invalid} ${t('audit.invalid')}`],
        [t('audit.approvals'), `${d.approvals.total} (${t('audit.approved')} ${d.approvals.approved} / ${t('audit.rejected')} ${d.approvals.rejected})`],
        [t('audit.generatedAt'), d.generated_at],
      ];
      const html = rows.map(([k, v]) => `<div class="ctx"><div class="k">${esc(k)}</div><div>${esc(String(v))}</div></div>`).join('');
      openModal(t('page.audit.report'), html,
        `<button class="btn" onclick="window.HLM.UI.downloadDataset()">${t('audit.dataset')}</button>
         <button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.close')}</button>`);
    } catch (e) { toast(e.message, 'error'); }
  }

  // 数据资产导出（JSONL，默认 general 类，合规）
  async function downloadDataset() {
    try {
      const token = localStorage.getItem('hlm_token');
      const res = await fetch(window.location.origin + '/api/audit/dataset', {
        headers: { Authorization: 'Bearer ' + token, 'Accept-Language': HLM.I18n.acceptHeader() },
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message || t('csv.exportFail')); }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'p390-dataset-general.jsonl';
      a.click();
      URL.revokeObjectURL(a.href);
      toast(t('audit.datasetOk'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 分级规则管理（治理配置后台，admin） =====
  let _rules = [];
  async function showRules() {
    try {
      const r = await API.get('/rules');
      _rules = r.data;
      const html = `
        <div style="margin-bottom:10px;"><button class="btn sm" onclick="window.HLM.UI.ruleForm()">${t('rules.add')}</button></div>
        <div class="tbl-wrap"><table class="data">
          <thead><tr><th>${t('rules.name')}</th><th>${t('rules.category')}</th><th>${t('rules.keywords')}</th><th>${t('rules.priority')}</th><th>${t('rules.enabled')}</th><th>${t('table.action')}</th></tr></thead>
          <tbody>${_rules.map(rl => `<tr>
            <td>${esc(rl.name)}</td>
            <td><span class="tag ${rl.category}">${t('category.' + rl.category) || rl.category}</span></td>
            <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;" title="${esc(rl.keywords)}">${esc(rl.keywords)}</td>
            <td>${rl.priority}</td>
            <td>${rl.enabled ? t('common.yes') : t('common.no')}</td>
            <td><div style="display:flex;gap:6px;">
              <button class="btn sm" onclick="window.HLM.UI.ruleForm(${rl.id})">${t('common.edit')}</button>
              <button class="btn sm" onclick="window.HLM.UI.toggleRule(${rl.id})">${rl.enabled ? t('rules.disable') : t('rules.enable')}</button>
              <button class="btn sm danger" onclick="window.HLM.UI.delRule(${rl.id})">${t('common.delete')}</button>
            </div></td>
          </tr>`).join('')}</tbody>
        </table></div>`;
      openModal(t('rules.title'), html, `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.close')}</button>`, 'lg');
    } catch (e) { toast(e.message, 'error'); }
  }

  function ruleForm(id) {
    const rl = _rules.find(x => x.id === id) || {};
    const catOptions = ['general', 'confidential', 'ops'].map(c => `<option value="${c}" ${rl.category === c ? 'selected' : ''}>${t('category.' + c)}</option>`).join('');
    openModal(id ? t('rules.edit') : t('rules.add'), `
      <div class="form-group"><label class="form-label">${t('rules.name')}</label><input class="form-input" id="ruleName" value="${esc(rl.name || '')}"></div>
      <div class="form-group"><label class="form-label">${t('rules.category')}</label><select class="form-select" id="ruleCategory">${catOptions}</select></div>
      <div class="form-group"><label class="form-label">${t('rules.keywords')}</label><textarea class="form-textarea" id="ruleKeywords" rows="3" placeholder=",${t('rules.keywordsPh')}">${esc(rl.keywords || '')}</textarea></div>
      <div class="form-group"><label class="form-label">${t('rules.priority')}</label><input class="form-input" type="number" id="rulePriority" value="${rl.priority || 100}"></div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">${t('common.cancel')}</button>
       <button class="btn primary" onclick="window.HLM.UI.saveRule(${id || 0})">${t('common.save')}</button>`);
  }

  async function saveRule(id) {
    const body = {
      name: $('#ruleName').value.trim(),
      category: $('#ruleCategory').value,
      keywords: $('#ruleKeywords').value.trim(),
      priority: parseInt($('#rulePriority').value) || 100,
    };
    if (!body.name || !body.keywords) { toast(t('rules.empty'), 'warning'); return; }
    try {
      if (id) await API.put('/rules/' + id, body);
      else await API.post('/rules', body);
      toast(t('rules.saved'), 'success');
      closeModal();
      showRules();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function toggleRule(id) {
    const rl = _rules.find(x => x.id === id);
    if (!rl) return;
    try {
      await API.put('/rules/' + id, { enabled: !rl.enabled });
      closeModal();
      showRules();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function delRule(id) {
    if (!window.confirm(t('rules.delConfirm'))) return;
    try {
      await API.del('/rules/' + id);
      closeModal();
      showRules();
    } catch (e) { toast(e.message, 'error'); }
  }

  window.HLM.UI = {
    renderTasks, openDetail, doAction, promptComplete, submitComplete,
    promptReject, submitReject, promptRequeue, submitRequeue, promptCancel,
    promptReopen, submitReopen, showAuditReport, downloadDataset, showRules, ruleForm, saveRule, toggleRule, delRule,
    renderUsers, showUserForm, saveUser, delUser, renderLogs,
    renderApprovals, openApproval, promptApprove, submitApprove, promptApproveReject, submitApproveReject,
    renderProjects, promptCreateProject, submitCreateProject, promptApplyProject, submitApplyProject,
    promptEditProject, submitEditProject, doArchiveProject,
    promptTaskProject, submitTaskProject, exportCSV,
    startCountdown,
    closeModal,
  };
})();
