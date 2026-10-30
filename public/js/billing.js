/* billing.js — 计费计量：KPI 概览 / 月度账单 / 费率配置 / 明细流水（IIFE，注册 window.HLM.Billing） */
window.HLM = window.HLM || {};

(function () {
  const { $, esc, toast, openModal, closeModal, confirmDialog, Icons, fmt } = window.HLM.U;
  const { t } = window.HLM.I18n;
  const { API } = window.HLM;

  const CATS = ['general', 'confidential', 'ops'];
  const PRIS = ['high', 'medium', 'low'];

  // 页面状态（切期间 / 翻页时保留）
  const state = { period: '', page: 1, size: 20, isAdmin: false };

  // ===== 格式化 =====
  /** 分 → 「12.34 元」 */
  function yuan(cents) {
    return (Number(cents || 0) / 100).toFixed(2) + ' ' + t('billing.yuan');
  }
  function minutes(n) {
    const v = Number(n || 0);
    return (Math.round(v * 100) / 100) + ' ' + t('billing.min');
  }
  function monthNow() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function srcLabel(s) {
    const m = { human: 'billing.src.human', ai_relay: 'billing.src.aiRelay', ai_shift: 'billing.src.aiShift', manual: 'billing.src.manual' };
    return t(m[s] || 'billing.src.manual');
  }

  /** 汇总表：三列（名称 / 任务数 / 时长 / 金额） */
  function summaryTable(rows, nameLabel) {
    if (!rows || !rows.length) return `<div class="empty" style="padding:20px;">${t('billing.noData')}</div>`;
    return `<div class="tbl-wrap"><table class="data">
      <thead><tr><th>${nameLabel}</th><th>${t('billing.taskCount')}</th><th>${t('billing.minutes')}</th><th>${t('billing.amount')}</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.key || '-')}</td>
        <td>${r.count}</td>
        <td>${minutes(r.minutes)}</td>
        <td><b>${yuan(r.amount_cents)}</b></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // ===== 渲染骨架 =====
  async function render(container, opts) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return;
    state.isAdmin = !!((opts || {}).isAdmin);
    if (!state.period) state.period = monthNow();

    box.innerHTML = `
      <div class="topbar">
        <div><div class="page-title">${t('billing.title')}</div><div class="page-desc">${t('billing.desc')}</div></div>
        <div class="spacer"></div>
        ${state.isAdmin ? `<button class="btn" onclick="window.HLM.Billing.settle()">${Icons.zap}${t('billing.settle')}</button>` : ''}
        <button class="btn" onclick="window.HLM.Billing.load()">${Icons.refresh}${t('common.refresh')}</button>
      </div>
      <div class="stats" id="billKpi"></div>

      <div class="card">
        <div class="card-head"><span class="t">${t('billing.statement')}</span>
          <div class="spacer"></div>
          <input type="month" class="form-input" id="billPeriod" style="max-width:180px;" value="${esc(state.period)}">
          <button class="btn" onclick="window.HLM.Billing.showStatement()">${t('billing.viewMonth')}</button>
        </div>
        <div class="card-body" id="billStatement"><div class="empty" style="padding:20px;">…</div></div>
      </div>

      ${state.isAdmin ? `<div class="card">
        <div class="card-head"><span class="t">${t('billing.rates')}</span>
          <div class="spacer"></div>
          <button class="btn primary" onclick="window.HLM.Billing.promptRate()">${Icons.plus}${t('billing.rateNew')}</button>
        </div>
        <div class="card-body-flush" id="billRates"><div class="empty" style="padding:20px;">…</div></div>
      </div>` : ''}

      <div class="card">
        <div class="card-head"><span class="t">${t('billing.ledger')}</span>
          <div class="spacer"></div>
          <button class="btn" onclick="window.HLM.Billing.exportCsv()">${Icons.file}${t('common.export')}</button>
        </div>
        <div class="card-body-flush"><div id="billLedger"><div class="empty" style="padding:20px;">…</div></div></div>
      </div>`;

    const periodInput = $('#billPeriod');
    if (periodInput) {
      periodInput.onchange = () => {
        state.period = periodInput.value || monthNow();
        state.page = 1;
        load(); // load 内已含账单 / 费率 / 明细刷新
      };
    }
    await load();
  }

  // ===== 数据加载（KPI + 明细）=====
  async function load() {
    const period = state.period || monthNow();
    // 概览只在「当月」有意义；查看历史月份时 KPI 用该月账单汇总
    try {
      const isThisMonth = period === monthNow();
      if (isThisMonth) {
        const r = await API.get('/billing/overview');
        renderKpi(r.data);
      } else {
        const r = await API.get('/billing/statement?period=' + encodeURIComponent(period));
        renderKpi({
          total_cents: r.data.total_cents,
          task_count: r.data.task_count,
          daily_avg_cents: null,
          hourly_avg_cents: r.data.total_minutes > 0
            ? Math.round((r.data.total_cents / r.data.total_minutes) * 60) : 0,
          total_minutes: r.data.total_minutes,
        });
      }
    } catch (e) {
      const box = $('#billKpi');
      if (box) box.innerHTML = '';
      toast(e.message, 'error');
    }
    await Promise.all([showStatement(), state.isAdmin ? loadRates() : Promise.resolve(), loadLedger()]);
  }

  function renderKpi(d) {
    const box = $('#billKpi');
    if (!box || !d) return;
    box.innerHTML = `
      <div class="stat completed"><div class="num">${yuan(d.total_cents)}</div><div class="lbl">${t('billing.kpi.total')}</div></div>
      <div class="stat"><div class="num">${d.task_count || 0}</div><div class="lbl">${t('billing.kpi.tasks')}</div></div>
      <div class="stat"><div class="num">${d.daily_avg_cents == null ? '-' : yuan(d.daily_avg_cents)}</div><div class="lbl">${t('billing.kpi.dailyAvg')}</div></div>
      <div class="stat"><div class="num">${yuan(d.hourly_avg_cents)}</div><div class="lbl">${t('billing.kpi.hourlyAvg')}</div></div>`;
  }

  // ===== 月度账单 =====
  async function showStatement() {
    const box = $('#billStatement');
    if (!box) return;
    box.innerHTML = `<div class="empty" style="padding:20px;">${t('toast.loading')}</div>`;
    try {
      const r = await API.get('/billing/statement?period=' + encodeURIComponent(state.period));
      const d = r.data;
      box.innerHTML = `
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
          <span class="chip">${t('billing.period')}: ${esc(d.period)}</span>
          <span class="chip">${t('billing.kpi.total')}: <b>${yuan(d.total_cents)}</b></span>
          <span class="chip">${t('billing.taskCount')}: ${d.task_count}</span>
          <span class="chip">${t('billing.minutes')}: ${minutes(d.total_minutes)}</span>
        </div>
        <div class="form-group"><label class="form-label">${t('billing.byCategory')}</label></div>
        ${summaryTable(d.by_category.map(x => ({ ...x, key: t('category.' + x.key) || x.key })), t('billing.category'))}        <div class="form-group" style="margin-top:14px;"><label class="form-label">${t('billing.byProject')}</label></div>
        ${summaryTable(d.by_project.map(x => ({ ...x, key: x.key || t('billing.noProject') })), t('billing.project'))}
        <div class="form-group" style="margin-top:14px;"><label class="form-label">${t('billing.byAssignee')}</label></div>
        ${summaryTable(d.by_assignee.map(x => ({ ...x, key: x.key || t('billing.unknownUser') })), t('billing.engineer'))}
        <div class="form-group" style="margin-top:14px;"><label class="form-label">${t('billing.bySource')}</label></div>
        ${summaryTable(d.by_source.map(x => ({ ...x, key: srcLabel(x.key) })), t('billing.source'))}`;
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  // ===== 费率配置（admin）=====
  async function loadRates() {
    const box = $('#billRates');
    if (!box) return;
    try {
      const r = await API.get('/billing/rates');
      const list = r.data || [];
      if (!list.length) {
        box.innerHTML = `<div class="empty" style="padding:20px;">${t('billing.noRates')}</div>`;
        return;
      }
      box.innerHTML = `<div class="tbl-wrap"><table class="data">
        <thead><tr><th>${t('billing.scope')}</th><th>${t('billing.category')}</th><th>${t('billing.priority')}</th>
          <th>${t('billing.unitPrice')}</th><th>${t('billing.minCharge')}</th><th>${t('billing.enabled')}</th><th>${t('table.action')}</th></tr></thead>
        <tbody>${list.map(x => `<tr>
          <td>${x.tenant_id == null ? `<span class="tag low">${t('billing.scopeGlobal')}</span>` : `<span class="tag medium">${t('billing.scopeTenant')}</span>`}</td>
          <td>${esc(t('category.' + x.category) || x.category)}</td>
          <td>${esc(x.priority)}</td>
          <td>${yuan(x.unit_price_cents)}${t('billing.perMin')}</td>
          <td>${yuan(x.min_charge_cents)}</td>
          <td>${x.enabled === false ? t('common.no') : t('common.yes')}</td>
          <td>${x.tenant_id == null
            ? `<span style="color:var(--muted);font-size:12px;">${t('billing.globalLocked')}</span>`
            : `<button class="btn sm" onclick="window.HLM.Billing.promptRate(${x.id})">${Icons.edit}${t('common.edit')}</button>
               <button class="btn danger sm" onclick="window.HLM.Billing.delRate(${x.id})">${Icons.trash}${t('common.delete')}</button>`}</td>
        </tr>`).join('')}</tbody></table></div>`;
      window._billRates = list;
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  /** 新建 / 编辑费率弹窗（id 为空即新建本租户费率） */
  function promptRate(id) {
    const list = window._billRates || [];
    const cur = id ? list.find(x => Number(x.id) === Number(id)) : null;
    const x = cur || {
      category: 'general', priority: 'medium',
      unit_price_cents: 500, min_charge_cents: 500, enabled: true,
    };
    const body = `
      <div class="form-row">
        <div class="form-group"><label class="form-label">${t('billing.category')}</label>
          <select class="form-select" id="rateCat">${CATS.map(c => `<option value="${c}" ${x.category === c ? 'selected' : ''}>${t('category.' + c)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">${t('billing.priority')}</label>
          <select class="form-select" id="ratePri">${PRIS.map(p => `<option value="${p}" ${x.priority === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">${t('billing.unitPricePh')}</label>
          <input class="form-input" type="number" min="0" step="1" id="rateUnit" value="${Number(x.unit_price_cents) || 0}"></div>
        <div class="form-group"><label class="form-label">${t('billing.minChargePh')}</label>
          <input class="form-input" type="number" min="0" step="1" id="rateMin" value="${Number(x.min_charge_cents) || 0}"></div>
      </div>
      <div class="form-group"><label class="form-label">${t('billing.enabled')}</label>
        <select class="form-select" id="rateEnabled">
          <option value="1" ${x.enabled !== false ? 'selected' : ''}>${t('common.yes')}</option>
          <option value="0" ${x.enabled === false ? 'selected' : ''}>${t('common.no')}</option>
        </select></div>
      <div style="font-size:12px;color:var(--muted);">${t('billing.rateHint')}</div>`;
    const foot = `<button class="btn" onclick="window.HLM.U.closeModal()">${t('common.cancel')}</button>
      <button class="btn primary" id="rateSaveBtn">${t('common.save')}</button>`;
    openModal(id ? t('billing.rateEdit') : t('billing.rateNew'), body, foot);
    $('#rateSaveBtn').onclick = () => saveRate(id);
  }

  async function saveRate(id) {
    const data = {
      category: $('#rateCat').value,
      priority: $('#ratePri').value,
      unit_price_cents: parseInt($('#rateUnit').value, 10) || 0,
      min_charge_cents: parseInt($('#rateMin').value, 10) || 0,
      enabled: $('#rateEnabled').value === '1',
    };
    if (data.unit_price_cents < 0 || data.min_charge_cents < 0) return toast(t('billing.rateInvalid'), 'error');
    try {
      await API.post('/billing/rates', data);
      closeModal();
      toast(t('billing.rateSaved'), 'success');
      loadRates();
    } catch (e) { toast(e.message, 'error'); }
  }

  function delRate(id) {
    confirmDialog(t('common.delete'), t('billing.confirmDelRate'), async () => {
      try {
        await API.del('/billing/rates/' + id);
        toast(t('billing.rateDeleted'), 'success');
        loadRates();
      } catch (e) { toast(e.message, 'error'); }
    }, true);
  }

  // ===== 明细流水 =====
  async function loadLedger() {
    const box = $('#billLedger');
    if (!box) return;
    try {
      const params = new URLSearchParams({ period: state.period, page: String(state.page), size: String(state.size) });
      const r = await API.get('/billing/ledger?' + params.toString());
      const d = r.data;
      if (!d.data.length) {
        box.innerHTML = `<div class="empty" style="padding:24px;">${t('billing.noData')}</div>`;
        return;
      }
      const pages = Math.max(1, Math.ceil(d.total / d.size));
      box.innerHTML = `<div class="tbl-wrap"><table class="data">
        <thead><tr><th>${t('table.id')}</th><th>${t('billing.category')}</th><th>${t('billing.priority')}</th>
          <th>${t('billing.project')}</th><th>${t('billing.engineer')}</th><th>${t('billing.minutes')}</th>
          <th>${t('billing.unitPrice')}</th><th>${t('billing.amount')}</th><th>${t('billing.source')}</th><th>${t('table.createdAt')}</th></tr></thead>
        <tbody>${d.data.map(x => `<tr>
          <td class="mono">#${x.task_id}</td>
          <td><span class="tag ${esc(x.category)}">${esc(t('category.' + x.category) || x.category)}</span></td>
          <td>${esc(x.priority)}</td>
          <td>${esc(x.project_code || '-')}</td>
          <td>${esc(x.assignee_name || x.assignee_username || '-')}</td>
          <td>${minutes(x.billable_minutes)}</td>
          <td>${yuan(x.unit_price_cents)}</td>
          <td><b>${yuan(x.amount_cents)}</b></td>
          <td><span class="chip">${esc(srcLabel(x.source))}</span></td>
          <td>${fmt(x.created_at)}</td>
        </tr>`).join('')}</tbody></table></div>
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;flex-wrap:wrap;">
          <span class="chip">${t('billing.totalRows')}: ${d.total}</span>
          <div class="spacer" style="flex:1;"></div>
          <button class="btn sm" ${state.page <= 1 ? 'disabled' : ''} onclick="window.HLM.Billing.page(${state.page - 1})">${t('billing.prev')}</button>
          <span style="font-size:12px;color:var(--muted);">${state.page} / ${pages}</span>
          <button class="btn sm" ${state.page >= pages ? 'disabled' : ''} onclick="window.HLM.Billing.page(${state.page + 1})">${t('billing.next')}</button>
        </div>`;
    } catch (e) {
      box.innerHTML = '';
      toast(e.message, 'error');
    }
  }

  function page(n) {
    state.page = Math.max(1, parseInt(n, 10) || 1);
    loadLedger();
  }

  // ===== 导出 / 结算 =====
  function exportCsv() {
    const token = localStorage.getItem('hlm_token');
    const url = window.location.origin + '/api/billing/export?period=' + encodeURIComponent(state.period);
    fetch(url, { headers: { Authorization: 'Bearer ' + token } })
      .then(res => {
        if (!res.ok) throw new Error(t('csv.exportFail'));
        return res.blob();
      })
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'billing-' + state.period + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(e => toast(e.message, 'error'));
  }

  async function settle() {
    try {
      const r = await API.post('/billing/settle', { limit: 200 });
      toast(t('billing.settleDone', { settled: r.data.settled, skipped: r.data.skipped }), 'success');
      await load();
    } catch (e) { toast(e.message, 'error'); }
  }

  window.HLM.Billing = { render, load, exportCsv, showStatement, promptRate, saveRate, delRate, settle, page, loadRates, loadLedger };
})();
