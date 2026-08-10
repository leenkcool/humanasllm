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
      box.innerHTML = `<tr><td colspan="9" class="empty">暂无任务</td></tr>`;
      return;
    }
    box.innerHTML = list.map(t => {
      const summary = t.request_payload?.messages?.find(m => m.role === 'user')?.content;
      return `<tr>
        <td class="nowrap"><span class="mono">#${t.id}</span></td>
        <td><span class="tag ${t.priority}">${esc(t.priority)}</span></td>
        <td><span class="tag ${t.status}">${STATUS_LABEL[t.status] || t.status}</span></td>
        <td>${esc(t.project_name || t.project_code || '-')}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(String(summary || '').slice(0, 60))}</td>
        <td class="nowrap">${esc(t.assignee_name || '-')}</td>
        <td class="nowrap" style="color:var(--muted);font-size:12px;">${fmt(t.created_at)}</td>
        <td class="nowrap" data-timeout="${t.timeout_at || ''}" data-status="${t.status}" style="font-size:12px;">${renderTimeoutCell(t.timeout_at, t.status)}</td>
        <td class="nowrap">
          <div style="display:flex;gap:6px;">
            <button class="btn sm" onclick="window.HLM.UI.openDetail(${t.id})">查看</button>
            ${t.status === 'pending' ? `<button class="btn sm primary" onclick="window.HLM.UI.doAction('claim',${t.id})">接单</button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // ===== 超时剩余时间倒计时 =====
  function fmtRemain(ms) {
    if (ms <= 0) return { label: '已超时', danger: true };
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    let t = '';
    if (d > 0) t += d + '天';
    if (h > 0 || d > 0) t += h + '时';
    if (m > 0 || h > 0 || d > 0) t += m + '分';
    t += sec + '秒';
    return { label: t, danger: false };
  }
  function renderTimeoutCell(timeoutAt, status) {
    if (!timeoutAt || ['completed', 'cancelled'].includes(status)) return '-';
    const ms = new Date(timeoutAt).getTime() - Date.now();
    const r = fmtRemain(ms);
    return r.danger
      ? '<span style="color:var(--danger);font-weight:600;">已超时</span>'
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
          ${t.project_code ? `<span class="chip">项目: ${esc(t.project_name || t.project_code)}</span>` : ''}
          <span class="chip">归属: ${esc(t.project_name || t.project_code || '未归属')} <button class="btn sm" style="margin-left:4px;" onclick="window.HLM.UI.promptTaskProject(${t.id})">设置</button></span>
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
    if (t.status === 'completed' && isOwner) btns += `<button class="btn danger" onclick="window.HLM.UI.promptReopen(${id})">打回重做</button>`;
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

  // 打回重做：产出不合格/乱答
  function promptReopen(id) {
    openModal('打回重做', `
      <div class="form-group">
        <label class="form-label">打回原因（产出不合格 / 乱答 / 未实现实际内容）</label>
        <textarea class="form-textarea" id="reopenReason" rows="3" placeholder="如：产出为占位乱答，未包含实际实现内容"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
       <button class="btn danger" onclick="window.HLM.UI.submitReopen(${id})">确认打回</button>`,
      'sm');
  }
  function submitReopen(id) {
    const reason = $('#reopenReason').value.trim();
    if (!reason) { toast('请填写打回原因', 'warning'); return; }
    doAction('reopen', id, { reason });
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

  // ===== 审批 =====
  const nl = (v) => String(v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v, null, 1))).replace(/\\n/g, '\n');
  const APPROVAL_LABEL = { pending: '待审批', approved: '已批准', rejected: '已驳回' };

  async function renderApprovals(list, box) {
    box.innerHTML = `<div class="card"><div class="card-body-flush"><div class="tbl-wrap"><table class="data">
      <thead><tr><th>单号</th><th>资源</th><th>规格/数量</th><th>用途</th><th>状态</th><th>申请人</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${list.map(a => `
        <tr>
          <td class="nowrap"><span class="mono">${esc(a.approval_no)}</span></td>
          <td><strong>${esc(a.resource)}</strong></td>
          <td>${esc(a.amount || '-')}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.purpose || '')}</td>
          <td><span class="tag ${a.status}">${APPROVAL_LABEL[a.status] || a.status}</span></td>
          <td>${esc(a.requester || '-')}</td>
          <td class="nowrap">${fmt(a.created_at)}</td>
          <td class="nowrap"><button class="btn sm" onclick="window.HLM.UI.openApproval(${a.id})">处理</button></td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">暂无审批单</td></tr>'}
      </tbody></table></div></div></div>`;
  }

  async function openApproval(id) {
    try {
      const r = await API.get('/approvals/' + id);
      const a = r.data;
      openModal(`审批 #${a.approval_no}`, `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <span class="tag ${a.status}">${APPROVAL_LABEL[a.status] || a.status}</span>
          <span class="chip">申请人: ${esc(a.requester || '-')}</span>
          ${a.project_code ? `<span class="chip">项目: ${esc(a.project_code)}</span>` : ''}
        </div>
        <div class="ctx"><div class="k">资源</div><pre>${esc(a.resource)}${a.amount ? ' · ' + esc(a.amount) : ''}</pre></div>
        ${a.purpose ? `<div class="ctx"><div class="k">用途</div><pre>${esc(nl(a.purpose))}</pre></div>` : ''}
        ${a.detail ? `<div class="ctx"><div class="k">详情</div><pre>${esc(nl(a.detail))}</pre></div>` : ''}
        ${a.provided ? `<div class="ctx" style="border-left:3px solid var(--success);"><div class="k">人类提供的资源 / 说明</div><pre>${esc(nl(a.provided))}</pre></div>` : ''}
        ${a.reject_reason ? `<div class="ctx" style="border-left:3px solid var(--danger);"><div class="k">驳回原因</div><pre>${esc(nl(a.reject_reason))}</pre></div>` : ''}
      `, approvalActions(a), 'lg');
    } catch (e) { toast(e.message, 'error'); }
  }

  function approvalActions(a) {
    if (a.status !== 'pending') return `<button class="btn" onclick="window.HLM.UI.closeModal()">关闭</button>`;
    const id = a.id;
    return `<button class="btn" onclick="window.HLM.UI.closeModal()">关闭</button>
      <button class="btn success" onclick="window.HLM.UI.promptApprove(${id})">批准并提供</button>
      <button class="btn danger" onclick="window.HLM.UI.promptApproveReject(${id})">驳回</button>`;
  }

  function promptApprove(id) {
    openModal('批准并提供资源', `
      <div class="form-group">
        <label class="form-label">提供的资源 / 准备说明（将返回给 AI）</label>
        <textarea class="form-textarea" id="approveProvided" rows="4" placeholder="如：已申请 2C4G 测试服务器，IP 192.168.168.x，凭据已发至安全邮箱"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
       <button class="btn success" onclick="window.HLM.UI.submitApprove(${id})">批准</button>`);
  }

  async function submitApprove(id) {
    const provided = $('#approveProvided').value;
    try {
      await API.post('/approvals/' + id + '/approve', { provided });
      toast('已批准并记录提供说明', 'success');
      closeModal();
      window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  function promptApproveReject(id) {
    openModal('驳回审批', `
      <div class="form-group">
        <label class="form-label">驳回原因（将返回给 AI）</label>
        <textarea class="form-textarea" id="approveRejectReason" rows="3" placeholder="如：预算未批复 / 资源不足 / 需补充理由"></textarea>
      </div>`,
      `<button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
       <button class="btn danger" onclick="window.HLM.UI.submitApproveReject(${id})">确认驳回</button>`,
      'sm');
  }

  async function submitApproveReject(id) {
    const reason = $('#approveRejectReason').value.trim();
    if (!reason) { toast('请填写驳回原因', 'warning'); return; }
    try {
      await API.post('/approvals/' + id + '/reject', { reason });
      toast('已驳回', 'success');
      closeModal();
      window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===== 项目管理 =====
  function projectFormHtml(p) {
    return `
      <div class="form-group"><label class="form-label">项目编码</label><input class="form-input" id="pjCode" value="${p ? esc(p.code) : ''}" ${p ? 'disabled' : ''} placeholder="如 internal-settlement"></div>
      <div class="form-group"><label class="form-label">项目名称</label><input class="form-input" id="pjName" value="${p ? esc(p.name) : ''}"></div>
      <div class="form-group"><label class="form-label">描述</label><textarea class="form-textarea" id="pjDesc" rows="3">${p ? esc(p.description || '') : ''}</textarea></div>`;
  }
  function promptCreateProject() {
    openModal('新建项目', projectFormHtml(null), `
      <button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
      <button class="btn primary" onclick="window.HLM.UI.submitCreateProject()">创建</button>`, 'sm');
  }
  async function submitCreateProject() {
    const code = $('#pjCode').value.trim();
    const name = $('#pjName').value.trim();
    if (!code || !name) { toast('编码和名称不能为空', 'warning'); return; }
    try {
      await API.post('/projects', { code, name, description: $('#pjDesc').value });
      toast('项目已创建', 'success'); closeModal(); window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  function promptApplyProject() {
    openModal('申请建项目', projectFormHtml(null) + '<p style="color:var(--muted);font-size:12px;margin-top:8px;">提交后将由管理员审批，批准后自动创建项目。</p>', `
      <button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
      <button class="btn primary" onclick="window.HLM.UI.submitApplyProject()">提交申请</button>`, 'sm');
  }
  async function submitApplyProject() {
    const code = $('#pjCode').value.trim();
    const name = $('#pjName').value.trim();
    if (!code || !name) { toast('编码和名称不能为空', 'warning'); return; }
    try {
      const r = await API.post('/projects/apply', { code, name, description: $('#pjDesc').value });
      toast(r.message || '申请已提交，待管理员审批', 'success'); closeModal();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function promptEditProject(id) {
    try {
      const r = await API.get('/projects');
      const p = (r.data || []).find(x => x.id === id);
      if (!p) { toast('项目不存在', 'error'); return; }
      openModal('编辑项目', projectFormHtml(p), `
        <button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
        <button class="btn primary" onclick="window.HLM.UI.submitEditProject(${id})">保存</button>`, 'sm');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function submitEditProject(id) {
    try {
      await API.put('/projects/' + id, { name: $('#pjName').value.trim(), description: $('#pjDesc').value });
      toast('已保存', 'success'); closeModal(); window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function doArchiveProject(id) {
    try {
      await API.post('/projects/' + id + '/archive', {});
      toast('已更新', 'success'); window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function renderProjects(list, box, isAdmin) {
    box.innerHTML = `<div class="card"><div class="card-body-flush"><div class="tbl-wrap"><table class="data">
      <thead><tr><th>编码</th><th>名称</th><th>描述</th><th>状态</th><th>创建时间</th>${isAdmin ? '<th>操作</th>' : ''}</tr></thead>
      <tbody>${list.map(p => `
        <tr>
          <td><span class="mono">${esc(p.code)}</span></td>
          <td><strong>${esc(p.name)}</strong></td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.description || '')}</td>
          <td><span class="tag ${p.status === 'active' ? 'completed' : 'cancelled'}">${p.status === 'active' ? '进行中' : '已归档'}</span></td>
          <td class="nowrap">${fmt(p.created_at)}</td>
          ${isAdmin ? `<td class="nowrap">
            <button class="btn sm" onclick="window.HLM.UI.promptEditProject(${p.id})">编辑</button>
            <button class="btn sm danger" onclick="window.HLM.UI.doArchiveProject(${p.id})">${p.status === 'active' ? '归档' : '启用'}</button>
          </td>` : ''}
        </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无项目，可申请创建</td></tr>'}
      </tbody></table></div></div></div>`;
  }

  // 任务归属项目
  async function promptTaskProject(id) {
    try {
      const pr = await API.get('/projects');
      const projects = (pr.data || []).filter(p => p.status === 'active');
      openModal('设置任务归属项目', `
        <div class="form-group">
          <label class="form-label">归属项目</label>
          <select class="form-select" id="taskProjectSelect">
            <option value="">（不归属）</option>
            ${projects.map(p => `<option value="${esc(p.code)}">${esc(p.code)} · ${esc(p.name)}</option>`).join('')}
          </select>
        </div>`,
        `<button class="btn" onclick="window.HLM.UI.closeModal()">取消</button>
         <button class="btn primary" onclick="window.HLM.UI.submitTaskProject(${id})">保存</button>`, 'sm');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function submitTaskProject(id) {
    const code = $('#taskProjectSelect').value;
    try {
      await API.post('/tasks/' + id + '/project', { project_code: code });
      toast('归属已更新', 'success'); closeModal(); window.HLM.refresh && window.HLM.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  window.HLM.UI = {
    renderTasks, openDetail, doAction, promptComplete, submitComplete,
    promptReject, submitReject, promptRequeue, submitRequeue, promptCancel,
    promptReopen, submitReopen,
    renderUsers, showUserForm, saveUser, delUser, renderLogs,
    renderApprovals, openApproval, promptApprove, submitApprove, promptApproveReject, submitApproveReject,
    renderProjects, promptCreateProject, submitCreateProject, promptApplyProject, submitApplyProject,
    promptEditProject, submitEditProject, doArchiveProject,
    promptTaskProject, submitTaskProject,
    startCountdown,
    closeModal,
  };
})();
