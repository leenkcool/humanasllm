/* ui.js — 任务列表 / 详情模态 / 状态操作 / 用户 / 日志 渲染 */
window.HLM = window.HLM || {};

(function () {
  const { API } = window.HLM;
  const U = window.HLM.U;
  const { Icons, $, esc, fmt, jsonStr, toast, openModal, closeModal, confirmDialog, STATUS_LABEL } = U;

  // ===== 任务表格 =====
  function renderTasks(list, containerId) {
    const box = $(containerId);
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<tr><td colspan="8" class="empty">暂无任务</td></tr>`;
      return;
    }
    box.innerHTML = list.map(t => {
      const summary = t.request_payload?.messages?.find(m => m.role === 'user')?.content;
      return `<tr>
        <td class="nowrap"><span class="mono">#${t.id}</span></td>
        <td><span class="tag ${t.priority}">${esc(t.priority)}</span></td>
        <td><span class="tag ${t.status}">${STATUS_LABEL[t.status] || t.status}</span></td>
        <td>${esc(t.project_code || '-')}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(String(summary || '').slice(0, 60))}</td>
        <td class="nowrap">${esc(t.assignee_name || '-')}</td>
        <td class="nowrap" style="color:var(--muted);font-size:12px;">${fmt(t.created_at)}</td>
        <td class="nowrap">
          <div style="display:flex;gap:6px;">
            <button class="btn sm" onclick="window.HLM.UI.openDetail(${t.id})">查看</button>
            ${t.status === 'pending' ? `<button class="btn sm primary" onclick="window.HLM.UI.doAction('claim',${t.id})">接单</button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // ===== 任务详情模态 =====
  async function openDetail(id) {
    try {
      const r = await API.get('/tasks/' + id);
      const t = r.data;
      const p = t.request_payload || {};
      const messages = Array.isArray(p.messages) ? p.messages : [];

      const metaHtml = Object.entries(t.meta_tags || {}).map(([k, v]) => `<span class="tag medium" style="margin-right:6px;">${esc(k)}: ${esc(v)}</span>`).join('');
      // 内容渲染：字面 \n 与真实换行统一转 <br>（人类可读，兼容手动/脚本派单）
      const nl = (v) => String(v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v, null, 1))).replace(/\\n/g, '\n');
      const msgsHtml = messages.map(m => `
        <div class="msg-row ${esc(m.role)}">
          <div class="role">${esc(m.role)}</div>
          <div class="content">${nl(m.content).split('\n').map(esc).join('<br>')}</div>
        </div>`).join('');

      const params = ['max_tokens', 'temperature', 'top_p', 'stop', 'user']
        .filter(k => p[k] != null).map(k => `${esc(k)}=${esc(String(p[k]))}`).join(' &nbsp; ');

      let resultHtml = '';
      if (t.status === 'completed' && t.result_text) {
        resultHtml = `<div class="ctx"><div class="k">人工产出结果</div><pre>${esc(nl(t.result_text))}</pre></div>`;
      }
      if (t.reject_reason) {
        resultHtml += `<div class="ctx" style="border-left:3px solid var(--danger);"><div class="k">驳回原因</div><pre>${esc(nl(t.reject_reason))}</pre></div>`;
      }

      const body = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <span class="tag ${t.status}">${STATUS_LABEL[t.status] || t.status}</span>
          <span class="tag ${t.priority}">${esc(t.priority)}</span>
          ${t.stream ? '<span class="tag pending">stream</span>' : ''}
          <span class="chip">model: ${esc(t.model)}</span>
          ${t.project_code ? `<span class="chip">项目: ${esc(t.project_code)}</span>` : ''}
          <span class="chip">upstream: <span class="mono">${esc(t.upstream_request_id || '-')}</span></span>
        </div>
        <div class="ctx" style="display:flex;gap:8px;flex-wrap:wrap;">${metaHtml || '<span class="k">无元标签</span>'} ${params ? `<span style="color:var(--muted);font-size:12px;align-self:center;">${params}</span>` : ''}</div>
        <div class="ctx"><div class="k">对话上下文（${messages.length} 条消息）</div>${msgsHtml}</div>
        ${resultHtml}
        <div class="ctx"><div class="k">审计轨迹</div><pre style="font-size:11px;">${(t.logs || []).map(l => `[${fmt(l.created_at)}] ${esc(l.action)} — ${esc(l.actor_name || '系统')}${l.remark ? ' · ' + esc(l.remark) : ''}`).join('\n') || '无'}</pre></div>
      `;

      const foot = actionButtons(t);
      openModal(`任务 #${t.id} · 上下文详情`, body, foot, 'lg');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function actionButtons(t) {
    const id = t.id;
    const user = window.HLM.currentUser || {};
    const isOwner = t.assignee_id === user.id || user.role === 'admin';
    let btns = `<button class="btn" onclick="window.HLM.UI.closeModal()">关闭</button>`;

    if (t.status === 'pending') btns += `<button class="btn primary" onclick="window.HLM.UI.doAction('claim', ${id})">接单</button>`;
    if (t.status === 'processing' && isOwner) {
      btns += `<button class="btn success" onclick="window.HLM.UI.promptComplete(${id})">提交结果</button>`;
      btns += `<button class="btn danger" onclick="window.HLM.UI.promptReject(${id})">驳回</button>`;
      btns += `<button class="btn" onclick="window.HLM.UI.doAction('pause', ${id})">暂停</button>`;
    }
    if (t.status === 'paused' && isOwner) {
      btns += `<button class="btn primary" onclick="window.HLM.UI.doAction('resume', ${id})">恢复</button>`;
      btns += `<button class="btn danger" onclick="window.HLM.UI.promptReject(${id})">驳回</button>`;
    }
    if (t.status === 'returned') btns += `<button class="btn primary" onclick="window.HLM.UI.doAction('claim', ${id})">重新接单</button>`;
    if (t.status === 'returned' || t.status === 'paused') btns += `<button class="btn" onclick="window.HLM.UI.promptRequeue(${id})">改上下文重派</button>`;
    if (!['completed', 'cancelled'].includes(t.status)) btns += `<button class="btn danger" onclick="window.HLM.UI.promptCancel(${id})">取消</button>`;
    return btns;
  }

  // ===== 操作 =====
  async function doAction(action, id, payload) {
    try {
      const r = await API.post(`/tasks/${id}/${action}`, payload || {});
      toast(`操作成功: ${action}`, 'success');
      closeModal();
      window.HLM.refresh && window.HLM.refresh();
      return r;
    } catch (e) { toast(e.message, 'error'); }
  }

  function promptComplete(id) {
    openModal('提交人工产出', `
      <div class="form-group">
        <label class="form-label">产出内容（将按大模型格式封装返回上游）</label>
        <textarea class="form-textarea" id="completeText" rows="8" placeholder="粘贴代码 / 输出结果..."></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
       <button class="btn success" onclick="window.HLM.UI.submitComplete(${id})">提交</button>`);
  }
  function submitComplete(id) {
    const content = $('#completeText').value;
    if (!content.trim()) { toast('内容不能为空', 'warning'); return; }
    doAction('complete', id, { content });
  }

  function promptReject(id) {
    openModal('驳回重写', `
      <div class="form-group">
        <label class="form-label">驳回原因（返回上游说明）</label>
        <textarea class="form-textarea" id="rejectReason" rows="3" placeholder="如：需求不明确 / 缺上下文 / 需补充信息"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
       <button class="btn danger" onclick="window.HLM.UI.submitReject(${id})">确认驳回</button>`,
      'sm');
  }
  function submitReject(id) {
    const reason = $('#rejectReason').value.trim();
    if (!reason) { toast('请填写原因', 'warning'); return; }
    doAction('reject', id, { reason });
  }

  function promptRequeue(id) {
    openModal('修改上下文后重新派发', `
      <div class="form-group">
        <label class="form-label">新的 request_payload（可粘贴完整 OpenAI 请求体；留空则沿用原上下文）</label>
        <textarea class="form-textarea" id="requeuePayload" rows="8" placeholder='{"model":"human-llm","messages":[...]}'></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
       <button class="btn primary" onclick="window.HLM.UI.submitRequeue(${id})">重新派发</button>`);
  }
  function submitRequeue(id) {
    const raw = $('#requeuePayload').value.trim();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch (e) { toast('JSON 格式错误', 'error'); return; }
    }
    doAction('requeue', id, { request_payload: payload });
  }

  function promptCancel(id) {
    confirmDialog('取消任务', '确定取消该任务吗？', () => doAction('cancel', id), true);
  }

  // ===== 用户管理 =====
  async function renderUsers(box, isAdmin) {
    try {
      const r = await API.get('/users');
      const users = r.data;
      box.innerHTML = `
        <div class="card"><div class="card-head"><span class="t">工程师账户</span>
          ${isAdmin ? `<button class="btn primary sm" onclick="window.HLM.UI.showUserForm()">${Icons.plus} 新增</button>` : ''}
        </div>
        <div class="card-body-flush"><div class="tbl-wrap"><table class="data">
          <thead><tr><th>ID</th><th>用户名</th><th>姓名</th><th>角色</th><th>状态</th><th>创建时间</th>${isAdmin ? '<th>操作</th>' : ''}</tr></thead>
          <tbody>${users.map(u => `
            <tr>
              <td>${u.id}</td><td><strong>${esc(u.username)}</strong></td><td>${esc(u.name || '-')}</td>
              <td><span class="tag ${u.role === 'admin' ? 'high' : 'medium'}">${u.role === 'admin' ? '管理员' : '工程师'}</span></td>
              <td>${u.is_active ? '<span class="tag completed">正常</span>' : '<span class="tag cancelled">停用</span>'}</td>
              <td class="nowrap">${fmt(u.created_at)}</td>
              ${isAdmin ? `<td class="nowrap"><button class="btn sm" onclick="window.HLM.UI.showUserForm(${u.id})">编辑</button> <button class="btn sm danger" onclick="window.HLM.UI.delUser(${u.id})">删除</button></td>` : ''}
            </tr>`).join('') || '<tr><td colspan="7" class="empty">暂无用户</td></tr>'}
          </tbody>
        </table></div></div></div>`;
    } catch (e) { box.innerHTML = `<div class="empty" style="padding:40px;">${esc(e.message)}</div>`; }
  }

  function showUserForm(id) {
    const isEdit = !!id;
    openModal(isEdit ? '编辑用户' : '新增工程师', `
      <div class="form-group"><label class="form-label">用户名</label><input class="form-input" id="uName" ${isEdit ? 'disabled' : ''}></div>
      <div class="form-group"><label class="form-label">姓名</label><input class="form-input" id="uNick"></div>
      ${!isEdit ? `<div class="form-group"><label class="form-label">密码</label><input class="form-input" id="uPass" type="password"></div>` : ''}
      <div class="form-group"><label class="form-label">角色</label><select class="form-select" id="uRole"><option value="engineer">工程师</option><option value="admin">管理员</option></select></div>
    `, `
      <button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
      <button class="btn primary" onclick="window.HLM.UI.saveUser(${id || 'null'})">保存</button>`);
  }

  async function saveUser(id) {
    const username = $('#uName').value.trim();
    const name = $('#uNick').value.trim();
    const role = $('#uRole').value;
    const password = id ? undefined : $('#uPass').value;
    if (!username) { toast('请输入用户名', 'warning'); return; }
    if (!id && !password) { toast('请输入密码', 'warning'); return; }
    try {
      if (id) { await API.put('/users/' + id, { name, role }); }
      else { await API.post('/users', { username, password, role, name }); }
      toast('保存成功', 'success');
      closeModal();
      window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  function delUser(id) {
    confirmDialog('删除用户', '确定删除该用户吗？此操作不可恢复。', async () => {
      try { await API.del('/users/' + id); toast('已删除', 'success'); window.HLM.refresh && window.HLM.refresh(); }
      catch (e) { toast(e.message, 'error'); }
    }, true);
  }

  // ===== 日志 =====
  async function renderLogs(box, kind) {
    try {
      const r = await API.get('/logs/' + (kind === 'audit' ? 'tasks' : 'requests') + '?size=50');
      const rows = r.data.data;
      const isReq = kind !== 'audit';
      box.innerHTML = `<div class="card"><div class="card-head"><span class="t">${isReq ? '请求 / 输出日志' : '任务审计日志'}</span><span class="chip">共 ${r.data.total} 条</span></div>
        <div class="card-body-flush"><div class="tbl-wrap"><table class="data">
          <thead><tr>${isReq
            ? '<th>ID</th><th>方向</th><th>任务</th><th>模型</th><th>内容摘要</th><th>时间</th>'
            : '<th>ID</th><th>任务</th><th>动作</th><th>操作人</th><th>说明</th><th>时间</th>'}</tr></thead>
          <tbody>${rows.map(x => isReq
            ? `<tr><td>${x.id}</td><td><span class="tag ${x.direction === 'in' ? 'pending' : 'completed'}">${x.direction === 'in' ? 'IN' : 'OUT'}</span></td><td><span class="mono">#${x.task_id || '-'}</span></td><td>${esc(x.model || '-')}</td><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(jsonStr(x.payload).slice(0, 80))}</td><td class="nowrap">${fmt(x.created_at)}</td></tr>`
            : `<tr><td>${x.id}</td><td><span class="mono">#${x.task_id}</span></td><td><span class="tag ${x.action}">${esc(x.action)}</span></td><td>${esc(x.actor_name || '-')}</td><td>${esc(x.remark || '-')}</td><td class="nowrap">${fmt(x.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">暂无日志</td></tr>'}
          </tbody>
        </table></div></div></div>`;
    } catch (e) { box.innerHTML = `<div class="empty" style="padding:40px;">${esc(e.message)}</div>`; }
  }

  window.HLM.UI = {
    renderTasks, openDetail, doAction, promptComplete, submitComplete,
    promptReject, submitReject, promptRequeue, submitRequeue, promptCancel,
    renderUsers, showUserForm, saveUser, delUser, renderLogs,
    closeModal,
  };
})();
